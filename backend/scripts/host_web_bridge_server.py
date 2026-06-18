import argparse
import asyncio
import base64
import json
import tempfile
import threading
from concurrent.futures import TimeoutError as FutureTimeoutError
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.async_api import async_playwright


STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || {runtime: {}};
Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
""".strip()

REQUEST_LOCK = threading.Lock()
NEW_CHAT_BUTTON_TEXT = "新建对话"
COMPOSER_SELECTOR = '[contenteditable="true"], textarea'


def load_cookies(storage_state_path: Path) -> list[dict]:
    if not storage_state_path.exists():
        return []
    try:
        data = json.loads(storage_state_path.read_text())
    except (OSError, ValueError):
        return []
    return data.get("cookies", []) or []


@dataclass
class BridgePageSession:
    page: object
    turn_count: int = 0


class BridgeRuntime:
    def __init__(self, config: dict[str, object]):
        self.config = config
        self.loop = asyncio.new_event_loop()
        self.ready = threading.Event()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        self.ready.wait(timeout=5)
        self._playwright = None
        self._context = None
        self._session: BridgePageSession | None = None

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.ready.set()
        self.loop.run_forever()

    async def _ensure_context(self):
        if self._context is not None:
            return self._context
        self._playwright = await async_playwright().start()
        self._context = await self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.config["profile_dir"]),
            channel=str(self.config["browser_channel"]),
            headless=bool(self.config["headless"]),
            no_viewport=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
        )
        await self._context.add_init_script(STEALTH_SCRIPT)
        return self._context

    async def _sync_cookies(self) -> None:
        context = await self._ensure_context()
        cookies = load_cookies(Path(self.config["storage_state_path"]))
        if cookies:
            await context.add_cookies(cookies)

    async def _open_chat_page(self):
        context = await self._ensure_context()
        page = await context.new_page()
        await page.goto(str(self.config["qwen_url"]), wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(7000)
        await page.wait_for_function(
            """(sel) => Boolean(document.querySelector(sel))""",
            arg=COMPOSER_SELECTOR,
            timeout=40000,
        )
        return page

    async def _invalidate_session(self, page=None) -> None:
        session = self._session
        if session is None:
            return
        if page is not None and session.page is not page:
            return
        self._session = None
        try:
            if not session.page.is_closed():
                await session.page.close()
        except Exception:
            pass

    async def _start_new_conversation(self, page) -> bool:
        candidates = (
            page.get_by_role("button", name=NEW_CHAT_BUTTON_TEXT).first,
            page.locator(
                f'button:has-text("{NEW_CHAT_BUTTON_TEXT}"), [role="button"]:has-text("{NEW_CHAT_BUTTON_TEXT}")'
            ).first,
        )
        for candidate in candidates:
            try:
                await candidate.wait_for(state="visible", timeout=3000)
                await candidate.click(force=True)
                await page.wait_for_timeout(1500)
                await page.wait_for_function(
                    """(sel) => Boolean(document.querySelector(sel))""",
                    arg=COMPOSER_SELECTOR,
                    timeout=15000,
                )
                return True
            except Exception:
                continue
        return False

    async def _ensure_session(self) -> BridgePageSession:
        await self._sync_cookies()

        rotate_after = max(1, int(self.config["rotate_after"]))
        session = self._session
        if session is not None and session.page.is_closed():
            self._session = None
            session = None

        if session is None:
            session = BridgePageSession(page=await self._open_chat_page())
            self._session = session
            return session

        if session.turn_count >= rotate_after:
            rotated = await self._start_new_conversation(session.page)
            if not rotated:
                await self._invalidate_session(session.page)
                session = BridgePageSession(page=await self._open_chat_page())
                self._session = session
                return session
            session.turn_count = 0

        return session

    async def _upload_image(self, page, image_path: Path) -> None:
        attach_name = str(self.config["attach_name"])
        await page.wait_for_function(
            """([attachName, composerSelector]) => Boolean(
                document.querySelector(composerSelector) ||
                document.querySelector('input[type="file"]') ||
                document.querySelector(`button[aria-label="${attachName}"], [role="button"][aria-label="${attachName}"]`)
            )""",
            arg=[attach_name, COMPOSER_SELECTOR],
            timeout=40000,
        )

        all_inputs = page.locator('input[type="file"]')
        input_count = await all_inputs.count()
        for index in range(input_count):
            candidate = all_inputs.nth(index)
            accept = (await candidate.get_attribute("accept") or "").lower()
            if any(token in accept for token in (".png", ".jpg", ".jpeg", ".bmp", ".webp", "image/")):
                await candidate.set_input_files(str(image_path))
                return

        async with page.expect_file_chooser() as chooser_info:
            await page.locator(
                f'button[aria-label="{attach_name}"], [role="button"][aria-label="{attach_name}"]'
            ).first.click(force=True)
        chooser = await chooser_info.value
        await chooser.set_files(str(image_path))

    async def _count_answer_nodes(self, page) -> int:
        return int(
            await page.evaluate(
                """(sel) => {
                    return [...document.querySelectorAll(sel)]
                        .map((node) => (node.innerText || "").trim())
                        .filter(Boolean).length;
                }""",
                str(self.config["answer_selector"]),
            )
        )

    async def _clear_composer(self, page) -> None:
        composer = page.locator(COMPOSER_SELECTOR).first
        await composer.click()

        for shortcut in ("Meta+A", "Control+A"):
            try:
                await composer.press(shortcut)
                await composer.press("Backspace")
            except Exception:
                continue

        try:
            await page.evaluate(
                """(sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return;
                    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
                        el.value = "";
                        el.dispatchEvent(new Event("input", { bubbles: true }));
                        el.dispatchEvent(new Event("change", { bubbles: true }));
                        return;
                    }
                    el.textContent = "";
                    el.dispatchEvent(new InputEvent("input", {
                        bubbles: true,
                        data: "",
                        inputType: "deleteContentBackward",
                    }));
                }""",
                COMPOSER_SELECTOR,
            )
        except Exception:
            pass

    async def _wait_for_answer(self, page, previous_answer_count: int) -> str:
        deadline = asyncio.get_event_loop().time() + int(self.config["timeout_seconds"])
        last_text = ""
        stable_rounds = 0
        started = False

        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(2.0)
            current = await page.evaluate(
                """({ sel, previousCount }) => {
                    const texts = [...document.querySelectorAll(sel)]
                        .map((node) => (node.innerText || "").trim())
                        .filter(Boolean);
                    if (texts.length <= previousCount) return "";
                    return texts[texts.length - 1];
                }""",
                {
                    "sel": str(self.config["answer_selector"]),
                    "previousCount": previous_answer_count,
                },
            )
            if current:
                started = True
            if started and current and current == last_text:
                stable_rounds += 1
            else:
                stable_rounds = 0
            last_text = current

            if stable_rounds >= 4:
                break
            if stable_rounds >= 2:
                send_disabled = await page.evaluate(
                    """(name) => {
                        const button = document.querySelector(`button[aria-label="${name}"]`);
                        return button ? button.disabled : false;
                    }""",
                    str(self.config["send_button_name"]),
                )
                if not send_disabled:
                    break

        if not last_text:
            raise RuntimeError("宿主机网页桥未抓到通义回答，请检查登录状态或更新 answer selector。")
        return last_text

    async def _fetch_answer(self, image_path: Path, prompt: str) -> str:
        session = await self._ensure_session()
        page = session.page
        try:
            previous_answer_count = await self._count_answer_nodes(page)
            await self._upload_image(page, image_path)
            await page.wait_for_timeout(5000)

            composer = page.locator(COMPOSER_SELECTOR).first
            await self._clear_composer(page)
            await composer.click()
            await page.keyboard.type(prompt)
            await page.wait_for_timeout(500)
            await page.get_by_role("button", name=str(self.config["send_button_name"])).click()

            answer_text = await self._wait_for_answer(page, previous_answer_count)
            session.turn_count += 1
            return answer_text
        except Exception:
            await self._invalidate_session(page)
            raise

    def fetch_answer(self, image_path: Path, prompt: str) -> str:
        future = asyncio.run_coroutine_threadsafe(
            self._fetch_answer(image_path=image_path, prompt=prompt),
            self.loop,
        )
        try:
            return future.result(timeout=int(self.config["timeout_seconds"]) + 120)
        except FutureTimeoutError as exc:
            future.cancel()
            raise RuntimeError("宿主机网页桥等待通义回答超时。") from exc

    async def _shutdown(self) -> None:
        await self._invalidate_session()
        if self._context is not None:
            await self._context.close()
            self._context = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None

    def close(self) -> None:
        future = asyncio.run_coroutine_threadsafe(self._shutdown(), self.loop)
        try:
            future.result(timeout=30)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=5)


class HostBridgeHandler(BaseHTTPRequestHandler):
    server_version = "HostWebBridge/1.0"

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        self.send_json(
            HTTPStatus.OK,
            {
                "status": "ok",
                "service": "host_web_bridge",
                "login_required": len(load_cookies(self.server.config["storage_state_path"])) == 0,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/bridge/fetch":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            payload = self.read_json()
            if payload.get("site_key") not in {None, "", "qwen_web"}:
                raise ValueError("当前宿主机 bridge 仅支持 qwen_web")
            image_base64 = str(payload.get("image_base64", "")).strip()
            prompt = str(payload.get("prompt", "")).strip()
            image_name = str(payload.get("image_name", "upload.jpg")).strip() or "upload.jpg"
            if not image_base64 or not prompt:
                raise ValueError("image_base64 和 prompt 不能为空")

            suffix = Path(image_name).suffix or ".jpg"
            raw = base64.b64decode(image_base64)
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
                temp.write(raw)
                temp_path = Path(temp.name)

            try:
                with REQUEST_LOCK:
                    answer_text = self.server.runtime.fetch_answer(temp_path, prompt)
            finally:
                temp_path.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            self.send_json(HTTPStatus.BAD_REQUEST, {"detail": str(exc)})
            return

        self.send_json(HTTPStatus.OK, {"answer_text": answer_text})

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def read_json(self) -> dict:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            raise ValueError("请求体不能为空")
        raw = self.rfile.read(content_length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("请求体不是合法 JSON") from exc

    def send_json(self, status: HTTPStatus, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> None:
    parser = argparse.ArgumentParser(description="宿主机通义网页桥服务")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--storage-state", default="data/qwen_web_state.json")
    parser.add_argument("--profile-dir", default="data/web_chrome_profile")
    parser.add_argument("--browser-channel", default="chrome")
    parser.add_argument("--qwen-url", default="https://www.qianwen.com/")
    parser.add_argument("--attach-name", default="添加附件")
    parser.add_argument("--answer-selector", default="[class*='markdown']")
    parser.add_argument("--send-button-name", default="发送消息")
    parser.add_argument("--timeout-seconds", type=int, default=180)
    parser.add_argument("--rotate-after", type=int, default=10)
    args = parser.parse_args()

    config = {
        "storage_state_path": Path(args.storage_state).resolve(),
        "profile_dir": Path(args.profile_dir).resolve(),
        "browser_channel": args.browser_channel,
        "qwen_url": args.qwen_url,
        "attach_name": args.attach_name,
        "answer_selector": args.answer_selector,
        "send_button_name": args.send_button_name,
        "timeout_seconds": args.timeout_seconds,
        "headless": args.headless,
        "rotate_after": args.rotate_after,
    }

    server = ThreadingHTTPServer((args.host, args.port), HostBridgeHandler)
    server.config = config
    server.runtime = BridgeRuntime(config)
    print(f"host web bridge listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.runtime.close()
        server.server_close()


if __name__ == "__main__":
    main()
