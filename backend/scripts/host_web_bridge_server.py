import argparse
import asyncio
import base64
import json
import tempfile
import threading
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


def load_cookies(storage_state_path: Path) -> list[dict]:
    if not storage_state_path.exists():
        return []
    try:
        data = json.loads(storage_state_path.read_text())
    except (OSError, ValueError):
        return []
    return data.get("cookies", []) or []


async def upload_image(page, image_path: Path, attach_name: str) -> None:
    await page.wait_for_function(
        """(attachName) => Boolean(
            document.querySelector('[contenteditable="true"], textarea') ||
            document.querySelector('input[type="file"]') ||
            document.querySelector(`button[aria-label="${attachName}"], [role="button"][aria-label="${attachName}"]`)
        )""",
        arg=attach_name,
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


async def wait_for_answer(page, answer_selector: str, send_button_name: str, timeout_seconds: int) -> str:
    deadline = asyncio.get_event_loop().time() + timeout_seconds
    last_text = ""
    stable_rounds = 0
    started = False

    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(2.0)
        current = await page.evaluate(
            """(sel) => {
                const nodes = [...document.querySelectorAll(sel)];
                if (!nodes.length) return "";
                return (nodes[nodes.length - 1].innerText || "").trim();
            }""",
            answer_selector,
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
                send_button_name,
            )
            if not send_disabled:
                break

    if not last_text:
        raise RuntimeError("宿主机网页桥未抓到通义回答，请检查登录状态或更新 answer selector。")
    return last_text


async def fetch_answer(
    *,
    image_path: Path,
    prompt: str,
    storage_state_path: Path,
    profile_dir: Path,
    browser_channel: str,
    qwen_url: str,
    attach_name: str,
    answer_selector: str,
    send_button_name: str,
    timeout_seconds: int,
    headless: bool,
) -> str:
    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            channel=browser_channel,
            headless=headless,
            no_viewport=True,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--start-maximized",
            ],
        )
        await context.add_init_script(STEALTH_SCRIPT)
        cookies = load_cookies(storage_state_path)
        if cookies:
            await context.add_cookies(cookies)

        page = await context.new_page()
        try:
            await page.goto(qwen_url, wait_until="domcontentloaded", timeout=60000)
            await page.wait_for_timeout(7000)
            await upload_image(page, image_path, attach_name)
            await page.wait_for_timeout(5000)

            composer = page.locator('[contenteditable="true"], textarea').first
            await composer.click()
            await page.keyboard.type(prompt)
            await page.wait_for_timeout(500)
            await page.get_by_role("button", name=send_button_name).click()

            return await wait_for_answer(page, answer_selector, send_button_name, timeout_seconds)
        finally:
            await page.close()
            await context.close()


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
                    answer_text = asyncio.run(
                        fetch_answer(
                            image_path=temp_path,
                            prompt=prompt,
                            storage_state_path=self.server.config["storage_state_path"],
                            profile_dir=self.server.config["profile_dir"],
                            browser_channel=self.server.config["browser_channel"],
                            qwen_url=self.server.config["qwen_url"],
                            attach_name=self.server.config["attach_name"],
                            answer_selector=self.server.config["answer_selector"],
                            send_button_name=self.server.config["send_button_name"],
                            timeout_seconds=self.server.config["timeout_seconds"],
                            headless=self.server.config["headless"],
                        )
                    )
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
    }

    server = ThreadingHTTPServer((args.host, args.port), HostBridgeHandler)
    server.config = config
    print(f"host web bridge listening on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
