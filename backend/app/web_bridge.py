"""Browser bridge to the 通义 (qianwen.com) chat web app.

Its public API does not expose 相似图检索 (reverse image search), but the consumer web
app does. This module drives it with Playwright: it uploads the image, asks the
identification prompt, waits for the agent to finish, scrapes the answer, and structures
the prose answer into the same JSON shape the rest of the app uses.

Important constraints learned the hard way:
- Consumer sites gate uploads against automation. A bundled headless Chromium does NOT
  work; we must drive a *real* Google Chrome (``channel="chrome"``) via a persistent
  profile, run headful (behind Xvfb in Docker), and mask ``navigator.webdriver``.
- 豆包 (doubao) additionally refuses to open its upload menu even under real Chrome with
  a logged-in session and trusted clicks, so only 通义 is wired here.
- A one-time manual login is captured into the storage_state file
  (see ``scripts/web_bridge_login.py``); its cookies are injected into the profile.
"""

import asyncio
import base64
import json
import logging
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import settings
from app.schemas import VisionCandidateRead
from app.vision import (
    VisionProvider,
    extract_message_text,
    parse_json_response,
    request_chat_completion,
    sanitize_generated_tags,
)

logger = logging.getLogger("app.web_bridge")

PLACEHOLDER_VALUES = {
    "",
    "见描述",
    "待确认",
    "待识别",
    "待确认文物",
    "待识别文物",
    "未知",
    "不详",
    "未提及",
}

WEB_STRUCTURING_SYSTEM_PROMPT = """
你会收到一段「AI 网页端对一件文物图片的鉴定回答」。请把它抽取为数据库录入 JSON，只输出 JSON：
{
  "artifact_name": "文物名称",
  "era": "时代",
  "museum_name": "博物馆或收藏机构/出土地",
  "tags": ["标签1", "标签2"],
  "description": "尽量完整的详细描述",
  "confidence": 0.0,
  "reasoning": "判断依据（摘自原回答）"
}
要求：
1. 只使用原回答中出现的信息，不要自行编造馆藏、年代或名称。
2. 原回答不确定或给了多个候选时，artifact_name 取最可能的一个，并在 reasoning 中说明其它候选。
3. tags 返回 3-8 个中文标签，优先提取器类、材质、纹饰、工艺、用途、题材、出土背景、墓葬/遗址背景等信息点；不要把 artifact_name、era、museum_name，或它们的近义改写/重复表达，放进 tags。
4. description 尽量写详细，优先整合形制、材质、纹饰、工艺、用途、时代背景、馆藏或出土地、出土情况、墓葬情况、遗址情况、流传与研究信息；原回答没提到的不要编造。
""".strip()


# Injected before any page script runs. Masks the most common automation tells so the
# site enables the same upload UI it shows real users.
STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || {runtime: {}};
Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
""".strip()


@dataclass
class WebChatSite:
    key: str  # provider key surfaced to the frontend, e.g. "qwen_web"
    label: str
    url: str
    storage_state: str
    image_input_selector: str
    composer_selector: str  # CSS selector for the input box (contenteditable/textarea)
    answer_selector: str
    # If set, click this button (by accessible name) to send; otherwise press Enter.
    send_button_name: str | None = None
    # Accessible name of the attach/upload control. Many sites create the hidden
    # <input type=file> lazily, so we click this and catch the file chooser.
    attach_name: str | None = None


def enabled_sites() -> list[WebChatSite]:
    sites: list[WebChatSite] = []
    if settings.qwen_web_enabled:
        sites.append(
            WebChatSite(
                key="qwen_web",
                label="通义网页端",
                url=settings.qwen_web_url,
                storage_state=settings.qwen_web_storage_state,
                # NB: avoid the mobile camera input (accept="image/*" capture=...);
                # target the real upload input that lists image extensions.
                image_input_selector='input[type="file"][accept*="webp"]',
                # The composer is a contenteditable DIV (placeholder "向千问提问"),
                # not a real <textarea>/role=textbox, so target it via CSS.
                composer_selector='[contenteditable="true"]',
                answer_selector=settings.qwen_web_answer_selector,
                send_button_name="发送消息",
                attach_name=settings.qwen_web_attach_name or None,
            )
        )
    # NB: 豆包 is intentionally not wired — its upload entry does not respond to
    # automation even under real Chrome with a logged-in session (see module docstring).
    return sites


_PLAYWRIGHT = None
_CONTEXT = None
_BROWSER_LOCK = asyncio.Lock()
_NEW_CHAT_BUTTON_TEXT = "新建对话"


@dataclass
class _SharedWebPageSession:
    site_key: str
    page: object
    turn_count: int = 0


_SHARED_WEB_PAGES: dict[str, _SharedWebPageSession] = {}


async def _get_context():
    """Lazily start a shared, persistent real-Chrome context with stealth patches."""
    global _PLAYWRIGHT, _CONTEXT
    if _CONTEXT is not None:
        return _CONTEXT

    from playwright.async_api import async_playwright

    _PLAYWRIGHT = await async_playwright().start()
    _CONTEXT = await _PLAYWRIGHT.chromium.launch_persistent_context(
        user_data_dir=settings.web_user_data_dir,
        channel=settings.web_browser_channel,
        headless=settings.web_headless,
        no_viewport=True,
        args=[
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--start-maximized",
        ],
    )
    await _CONTEXT.add_init_script(STEALTH_SCRIPT)
    return _CONTEXT


def _load_cookies(storage_state_path: str) -> list[dict]:
    """Read Playwright storage_state JSON and return its cookies (or [])."""
    path = _resolve_storage_state_path(storage_state_path)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    return data.get("cookies", []) or []


def _resolve_storage_state_path(storage_state_path: str) -> Path:
    path = Path(storage_state_path)
    if path.exists():
        return path
    # Host-local absolute paths are not visible inside the Docker container, but the same
    # `data/` directory is bind-mounted to `/data`. Fall back to the mounted file.
    fallback = Path("/data") / path.name
    if Path("/.dockerenv").exists() and fallback.exists():
        return fallback
    return path


def _login_script_path() -> Path:
    return Path(__file__).resolve().parents[1] / "scripts" / "web_bridge_login.py"


def _default_login_command() -> str:
    return ".venv-webtune/bin/python backend/scripts/web_bridge_login.py --duration 300"


def _remote_bridge_base_url() -> str:
    return settings.web_bridge_remote_url.rstrip("/")


def _remote_bridge_start_command() -> str:
    return settings.web_bridge_remote_start_command


def _remote_bridge_health() -> tuple[bool, dict[str, object] | None]:
    base = _remote_bridge_base_url()
    if not base:
        return False, None
    try:
        response = httpx.get(
            f"{base}/health",
            timeout=min(settings.web_bridge_remote_timeout_seconds, 3),
            follow_redirects=True,
        )
        response.raise_for_status()
        return True, response.json()
    except Exception:
        return False, None


def is_web_bridge_login_required(site: WebChatSite) -> bool:
    return len(_load_cookies(site.storage_state)) == 0


def can_auto_launch_web_bridge_login() -> bool:
    return not Path("/.dockerenv").exists()


def build_web_bridge_status(site: WebChatSite | None):
    from app.schemas import WebBridgeStatusRead

    if site is None:
        return WebBridgeStatusRead(enabled=False, detail="未启用通义网页桥接。")

    login_required = is_web_bridge_login_required(site)
    auto_login_supported = can_auto_launch_web_bridge_login()
    detail = None
    remote_url = _remote_bridge_base_url()
    if remote_url:
        reachable, remote_status = _remote_bridge_health()
        if not reachable:
            detail = (
                "已启用宿主机网页桥模式，但宿主机 bridge 服务不可达。"
                f"请先在宿主机启动：{_remote_bridge_start_command()}"
            )
        elif remote_status:
            login_required = bool(remote_status.get("login_required", login_required))
            detail = f"当前通过宿主机网页桥执行：{remote_url}"
    if login_required:
        detail = (
            "通义网页桥当前未登录。"
            if auto_login_supported
            else "当前运行在 Docker 容器内，无法直接弹出宿主机扫码窗口。请在宿主机运行登录脚本。"
        )
    return WebBridgeStatusRead(
        enabled=True,
        site_key=site.key,
        site_label=site.label,
        login_required=login_required,
        auto_login_supported=auto_login_supported,
        login_command=_default_login_command(),
        detail=detail,
    )


def start_web_bridge_login(duration: int = 300):
    from app.schemas import WebBridgeLoginStartRead

    command = _default_login_command()
    if not can_auto_launch_web_bridge_login():
        return WebBridgeLoginStartRead(
            started=False,
            detail="当前运行在 Docker 容器内，无法直接弹出宿主机扫码窗口，请在宿主机执行下面的登录命令。",
            login_command=command,
        )

    script = _login_script_path()
    try:
        subprocess.Popen(  # noqa: S603 - local trusted helper script
            [sys.executable, str(script), "--duration", str(duration)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("web bridge login helper failed to launch: %s", exc, exc_info=exc)
        return WebBridgeLoginStartRead(
            started=False,
            detail=f"自动启动登录窗口失败：{exc}",
            login_command=command,
        )
    return WebBridgeLoginStartRead(
        started=True,
        detail="已尝试拉起通义登录窗口，请在弹出的 Chrome 中扫码登录。",
        login_command=command,
    )


def _resolve_local_image_path(image_url: str, data_dir: Path) -> Path | None:
    if image_url.startswith("/files/"):
        relative_path = image_url.removeprefix("/files/").lstrip("/")
        return data_dir / relative_path
    # Absolute local filesystem path (batch scan passes raw paths from any directory).
    if image_url.startswith("file://"):
        return Path(image_url.removeprefix("file://"))
    candidate = Path(image_url)
    if candidate.is_absolute():
        return candidate
    return None


async def _materialize_image(image_url: str, data_dir: Path) -> tuple[Path, bool]:
    """Return a local file path for the image and whether it is a temp file to clean up."""
    local_path = _resolve_local_image_path(image_url, data_dir)
    if local_path is not None and local_path.exists():
        return local_path, False

    if image_url.startswith("http://") or image_url.startswith("https://"):
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(image_url)
            response.raise_for_status()
            suffix = Path(image_url.split("?")[0]).suffix or ".jpg"
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            tmp.write(response.content)
            tmp.close()
            return Path(tmp.name), True

    raise ValueError(f"web bridge cannot handle image url: {image_url}")


def _compress_for_web_upload(image_path: Path) -> bytes | None:
    max_bytes = settings.web_upload_max_file_bytes
    if max_bytes <= 0:
        return None
    target_min_bytes = min(settings.web_upload_target_min_file_bytes, max_bytes)
    target_max_bytes = min(max(settings.web_upload_target_max_file_bytes, target_min_bytes), max_bytes)

    try:
        from io import BytesIO

        from PIL import Image

        with Image.open(image_path) as original:
            image = original.convert("RGB")
            longest_side = max(image.size)
            max_dimension = max(960, settings.web_upload_max_dimension)
            dimension_candidates = []
            for candidate in (
                min(longest_side, max_dimension),
                5600,
                5200,
                4800,
                4400,
                4000,
                3600,
                3200,
                2800,
                2400,
                2200,
                2000,
                1800,
                1600,
                1440,
                1280,
                1120,
                960,
            ):
                clamped = min(longest_side, max_dimension, candidate)
                if clamped >= 960 and clamped not in dimension_candidates:
                    dimension_candidates.append(clamped)

            best_under_limit: bytes | None = None
            qualities = (95, 92, 90, 88, 85, 82, 80, 78, 75, 72, 70, 68, 65, 62, 60, 58, 55)
            for target_longest in dimension_candidates:
                if longest_side > target_longest:
                    scale = target_longest / longest_side
                    resized = image.resize(
                        (max(1, round(image.size[0] * scale)), max(1, round(image.size[1] * scale))),
                        Image.LANCZOS,
                    )
                else:
                    resized = image

                first_under_limit: bytes | None = None
                for quality in qualities:
                    buffer = BytesIO()
                    resized.save(buffer, format="JPEG", quality=quality, optimize=True)
                    payload = buffer.getvalue()
                    size = len(payload)
                    if size > max_bytes:
                        continue
                    if first_under_limit is None:
                        first_under_limit = payload
                    if target_min_bytes <= size <= target_max_bytes:
                        return payload

                if first_under_limit is None:
                    continue
                best_under_limit = first_under_limit
                if len(first_under_limit) < target_min_bytes:
                    return first_under_limit

            return best_under_limit
    except Exception as exc:  # noqa: BLE001
        logger.warning("web bridge failed to compress oversized image %s: %s", image_path, exc)
        return None


def _prepare_web_upload_image(image_path: Path) -> tuple[Path, bool]:
    max_bytes = settings.web_upload_max_file_bytes
    if max_bytes <= 0:
        return image_path, False
    if image_path.stat().st_size <= max_bytes:
        return image_path, False

    compressed = _compress_for_web_upload(image_path)
    if not compressed:
        logger.warning(
            "web bridge image %s is %d bytes and could not be reduced under %d bytes; using original file",
            image_path,
            image_path.stat().st_size,
            max_bytes,
        )
        return image_path, False

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
    tmp.write(compressed)
    tmp.close()
    logger.info(
        "web bridge compressed oversized upload %s from %d bytes to %d bytes",
        image_path,
        image_path.stat().st_size,
        len(compressed),
    )
    return Path(tmp.name), True


async def _upload_image(page, site: WebChatSite, image_path: Path) -> None:
    """Upload the image.

    The hidden <input type=file> is often injected a few seconds after load, so we wait
    for it and set files directly. Only if it never appears do we fall back to clicking
    an attach control and catching the file chooser.
    """
    await page.wait_for_function(
        """([composerSelector, attachName]) => {
            return Boolean(
                document.querySelector(composerSelector) ||
                document.querySelector('input[type="file"]') ||
                (attachName &&
                    document.querySelector(
                        `button[aria-label="${attachName}"], [role="button"][aria-label="${attachName}"]`
                    ))
            );
        }""",
        arg=[site.composer_selector, site.attach_name],
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

    existing = page.locator(site.image_input_selector).first
    try:
        await existing.wait_for(state="attached", timeout=5000)
        await existing.set_input_files(str(image_path))
        return
    except Exception:
        pass

    if site.attach_name:
        async with page.expect_file_chooser() as fc_info:
            await page.locator(f'button[aria-label="{site.attach_name}"], [role="button"][aria-label="{site.attach_name}"]').first.click(force=True)
        chooser = await fc_info.value
        await chooser.set_files(str(image_path))
        return

    raise RuntimeError(
        f"{site.label}: 未找到图片上传输入框（selector={site.image_input_selector}）。"
    )


async def _count_answer_nodes(page, selector: str) -> int:
    return int(
        await page.evaluate(
            """(sel) => {
                return [...document.querySelectorAll(sel)]
                    .map((node) => (node.innerText || "").trim())
                    .filter(Boolean).length;
            }""",
            selector,
        )
    )


async def _clear_composer(page, site: WebChatSite) -> None:
    composer = page.locator(site.composer_selector).first
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
            site.composer_selector,
        )
    except Exception:
        pass


async def _start_new_conversation(page, site: WebChatSite) -> bool:
    candidates = (
        page.get_by_role("button", name=_NEW_CHAT_BUTTON_TEXT).first,
        page.locator(
            f'button:has-text("{_NEW_CHAT_BUTTON_TEXT}"), [role="button"]:has-text("{_NEW_CHAT_BUTTON_TEXT}")'
        ).first,
    )
    for candidate in candidates:
        try:
            await candidate.wait_for(state="visible", timeout=3000)
            await candidate.click(force=True)
            await page.wait_for_timeout(1500)
            await page.wait_for_function(
                """(sel) => Boolean(document.querySelector(sel))""",
                arg=site.composer_selector,
                timeout=15000,
            )
            return True
        except Exception:
            continue
    return False


async def _open_chat_page(context, site: WebChatSite):
    page = await context.new_page()
    await page.goto(site.url, wait_until="domcontentloaded")
    await page.wait_for_timeout(7000)
    await page.wait_for_function(
        """(sel) => Boolean(document.querySelector(sel))""",
        arg=site.composer_selector,
        timeout=40000,
    )
    return page


async def _invalidate_shared_chat_page(site_key: str, page=None) -> None:
    session = _SHARED_WEB_PAGES.get(site_key)
    if session is None:
        return
    if page is not None and session.page is not page:
        return
    _SHARED_WEB_PAGES.pop(site_key, None)
    try:
        if not session.page.is_closed():
            await session.page.close()
    except Exception:
        pass


async def _get_shared_chat_page(site: WebChatSite) -> _SharedWebPageSession:
    context = await _get_context()

    cookies = _load_cookies(site.storage_state)
    if cookies:
        await context.add_cookies(cookies)
    else:
        logger.warning(
            "web bridge %s: storage_state %s 不存在或无 cookie，将以未登录态访问，"
            "可能无法获取结果。请运行 scripts/web_bridge_login.py 登录。",
            site.key,
            site.storage_state,
        )

    session = _SHARED_WEB_PAGES.get(site.key)
    rotate_after = max(1, settings.web_reuse_conversation_max_turns)
    if session is not None and session.page.is_closed():
        _SHARED_WEB_PAGES.pop(site.key, None)
        session = None

    if session is None:
        page = await _open_chat_page(context, site)
        session = _SharedWebPageSession(site_key=site.key, page=page)
        _SHARED_WEB_PAGES[site.key] = session
        return session

    if session.turn_count >= rotate_after:
        rotated = await _start_new_conversation(session.page, site)
        if not rotated:
            await _invalidate_shared_chat_page(site.key, session.page)
            page = await _open_chat_page(context, site)
            session = _SharedWebPageSession(site_key=site.key, page=page)
            _SHARED_WEB_PAGES[site.key] = session
            return session
        session.turn_count = 0

    return session


async def _wait_for_answer(page, site: WebChatSite, previous_answer_count: int) -> str:
    """Wait for the agent to finish and return the last rendered answer text.

    Heuristic: poll the last answer block; when its text stops changing for a few
    rounds (and, if known, the send button is enabled again) generation is done.
    """
    deadline = asyncio.get_event_loop().time() + settings.web_timeout_seconds
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
            {"sel": site.answer_selector, "previousCount": previous_answer_count},
        )

        if current:
            started = True

        if started and current and current == last_text:
            stable_rounds += 1
        else:
            stable_rounds = 0
        last_text = current

        if stable_rounds >= 4:  # ~8s unchanged -> done
            break
        if stable_rounds >= 2 and site.send_button_name:
            send_disabled = await page.evaluate(
                """(name) => {
                    const b = document.querySelector('button[aria-label="' + name + '"]');
                    return b ? b.disabled : false;
                }""",
                site.send_button_name,
            )
            if not send_disabled:
                break

    if not last_text:
        raise RuntimeError(
            f"{site.label}未返回答案（可能未登录/触发风控/选择器失效）。"
            f"请运行 scripts/web_bridge_login.py 重新登录，或调整 {site.key} 的 answer selector。"
        )
    return last_text


async def _fetch_answer(site: WebChatSite, image_path: Path, prompt: str) -> str:
    """Drive the web app once and return the raw answer prose."""
    session = await _get_shared_chat_page(site)
    page = session.page
    try:
        previous_answer_count = await _count_answer_nodes(page, site.answer_selector)
        await _upload_image(page, site, image_path)
        await page.wait_for_timeout(5000)  # let the upload/thumbnail register

        composer = page.locator(site.composer_selector).first
        await _clear_composer(page, site)
        await composer.click()
        # contenteditable composers ignore Locator.fill, so type the keystrokes.
        await page.keyboard.type(prompt)
        await page.wait_for_timeout(500)

        if site.send_button_name:
            await page.get_by_role("button", name=site.send_button_name).click()
        else:
            await composer.press("Enter")

        answer_text = await _wait_for_answer(page, site, previous_answer_count)
        session.turn_count += 1
        return answer_text
    except Exception:
        await _invalidate_shared_chat_page(site.key, page)
        raise


async def _fetch_answer_remote(site: WebChatSite, image_path: Path, prompt: str) -> str:
    base = _remote_bridge_base_url()
    if not base:
        raise RuntimeError("未配置宿主机网页桥地址")
    payload = {
        "site_key": site.key,
        "image_name": image_path.name,
        "image_base64": base64.b64encode(image_path.read_bytes()).decode("ascii"),
        "prompt": prompt,
    }
    timeout = httpx.Timeout(settings.web_bridge_remote_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.post(f"{base}/v1/bridge/fetch", json=payload)
        if not response.is_success:
            detail = response.text
            try:
                detail = response.json().get("detail", detail)
            except Exception:
                pass
            raise RuntimeError(f"宿主机网页桥调用失败：{detail}")
        data = response.json()
    answer_text = str(data.get("answer_text", "")).strip()
    if not answer_text:
        raise RuntimeError("宿主机网页桥未返回答案")
    return answer_text


async def _structure_answer(answer_text: str) -> dict[str, object]:
    provider = VisionProvider(
        name="qwen",
        base_url=settings.dashscope_base_url.rstrip("/"),
        api_key=settings.dashscope_api_key,
        model=settings.web_structuring_model,
    )
    payload = {
        "model": provider.model,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": WEB_STRUCTURING_SYSTEM_PROMPT},
            {"role": "user", "content": f"网页端鉴定回答：\n{answer_text}"},
        ],
        "temperature": 0.1,
    }
    data = await request_chat_completion(provider, payload)
    return parse_json_response(extract_message_text(data))


def _extract_with_patterns(answer_text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, answer_text, flags=re.MULTILINE)
        if match:
            value = match.group(1).strip().strip(" ,，。；;：:")
            if value:
                return value
    return ""


def _extract_artifact_name(answer_text: str) -> str:
    return _extract_with_patterns(
        answer_text,
        [
            r"(?:这(?:[一二两三四五六七八九十\d]+)?(?:件|尊|组|对)?文物|该文物|此文物|这(?:[一二两三四五六七八九十\d]+)?(?:件|尊|组|对)?器物|该器物|此器|它)(?:是|为)“?([^，。；\n]{1,40})”?",
            r"^“?([^，。；\n]{1,40})”?[，,。；;]\s*(?:为|是)",
        ],
    )


def _extract_era(answer_text: str) -> str:
    match = re.search(
        (
            r"(新石器时代|夏代|商代(?:早期|中期|晚期)?|西周(?:早期|中期|晚期)?|东周|春秋|战国|"
            r"秦代|汉代|西汉|东汉|三国|魏晋(?:南北朝)?|隋代|唐代|宋代|辽代|金代|元代|"
            r"明代|清代|民国)"
        ),
        answer_text,
    )
    return match.group(1).strip() if match else ""


def _extract_museum_name(answer_text: str) -> str:
    return _extract_with_patterns(
        answer_text,
        [
            r"(?:现藏于|收藏于|藏于|现藏|馆藏于)([^，。；\n]{2,40})",
            r"(?:出土于)([^，。；\n]{2,40})",
        ],
    )


def _normalize_answer_text(answer_text: str) -> str:
    lines = [line.strip() for line in answer_text.replace("\r\n", "\n").split("\n")]
    normalized: list[str] = []
    previous_blank = False
    for line in lines:
        if not line:
            if not previous_blank and normalized:
                normalized.append("")
            previous_blank = True
            continue
        normalized.append(line)
        previous_blank = False
    return "\n".join(normalized).strip()


def _parse_tag_tokens(value: str) -> list[str]:
    cleaned = re.sub(r"[（(][^）)]*[）)]", "", value)
    parts = re.split(r"[，,、；;|/\n]+", cleaned)
    tags: list[str] = []
    for part in parts:
        token = re.sub(r"^\d+[.)、]\s*", "", part).strip().strip("[]【】<>《》\"'")
        if token and token not in tags:
            tags.append(token)
    return tags


def _collect_block_lines(lines: list[str], start_index: int) -> list[str]:
    collected: list[str] = []
    for remainder in lines[start_index:]:
        stripped = remainder.strip()
        if not stripped:
            break
        if re.match(
            r"^(?:说明|备注|理由|依据|补充|器型与材质|纹饰与工艺|用途与历史背景|出土与墓葬信息|"
            r"详细描述|描述|名称|时代|馆藏|博物馆|判断依据|结论)[:：]?$",
            stripped,
        ):
            break
        collected.append(stripped)
    return collected


def _extract_tag_block(answer_text: str) -> tuple[list[str], str]:
    marker = re.compile(
        r"^(?:适合入库的|可(?:入库|检索)的?)?"
        r"(?:(?:入库|推荐|建议|检索)\s*)?"
        r"(?:标签|关键词|要点)(?:建议|如下|信息点)?\s*[:：]?\s*(.*)$"
    )
    lines = answer_text.split("\n")
    for index, line in enumerate(lines):
        match = marker.match(line.strip())
        if not match:
            continue
        tag_lines = [match.group(1).strip()] if match.group(1).strip() else []
        tag_lines.extend(_collect_block_lines(lines, index + 1))
        description_lines = lines[:index]
        description = "\n".join(description_lines).strip()
        tags = _parse_tag_tokens("\n".join(tag_lines))
        return tags, description
    return [], answer_text


def _derive_tags(answer_text: str, artifact_name: str, era: str, museum_name: str) -> list[str]:
    tags: list[str] = []
    for keyword in [
        "青铜器",
        "金器",
        "银器",
        "玉器",
        "陶器",
        "瓷器",
        "石器",
        "佛像",
        "礼器",
        "摆件",
        "铭文",
        "龙纹",
        "凤纹",
        "兽面纹",
        "鎏金",
        "彩绘",
        "越窑",
        "秘色瓷",
        "红山文化",
        "墓葬",
        "出土文物",
        "祭祀",
        "陪葬",
        "陶俑",
        "石雕",
        "玉璧",
        "玉猪龙",
        "经函",
        "舍利",
    ]:
        if keyword in answer_text and keyword not in tags:
            tags.append(keyword)
        if len(tags) >= 8:
            break
    return sanitize_generated_tags(tags, artifact_name, era, museum_name)


def _merge_structured_answer(answer_text: str, structured: dict[str, object] | None) -> dict[str, object]:
    data = dict(structured or {})
    normalized_answer = _normalize_answer_text(answer_text)
    extracted_tags, description_source = _extract_tag_block(normalized_answer)

    artifact_name = str(data.get("artifact_name", "")).strip()
    if artifact_name in PLACEHOLDER_VALUES:
        artifact_name = _extract_artifact_name(answer_text)

    era = str(data.get("era", "")).strip()
    if era in PLACEHOLDER_VALUES:
        era = _extract_era(answer_text)

    museum_name = str(data.get("museum_name", "")).strip()
    if museum_name in PLACEHOLDER_VALUES:
        museum_name = _extract_museum_name(answer_text)

    description = _normalize_answer_text(description_source) or str(data.get("description", "")).strip()
    if description in PLACEHOLDER_VALUES:
        description = str(data.get("description", "")).strip()

    raw_tags = [str(tag).strip() for tag in data.get("tags", []) if str(tag).strip()]
    tags = sanitize_generated_tags([*extracted_tags, *raw_tags], artifact_name, era, museum_name)
    if not tags:
        tags = _derive_tags(answer_text, artifact_name, era, museum_name)

    reasoning = str(data.get("reasoning", "")).strip() or answer_text

    data.update(
        artifact_name=artifact_name or "待确认文物",
        era=era or None,
        museum_name=museum_name or None,
        description=description or normalized_answer or answer_text,
        tags=tags,
        reasoning=reasoning,
    )
    return data


def _build_candidate(
    site: WebChatSite, answer_text: str, structured: dict[str, object] | None
) -> VisionCandidateRead:
    structured = _merge_structured_answer(answer_text, structured)
    tags = [str(tag).strip() for tag in structured.get("tags", []) if str(tag).strip()]
    confidence_value = structured.get("confidence")
    return VisionCandidateRead(
        provider=site.key,
        model=site.label,
        artifact_name=str(structured.get("artifact_name", "")).strip() or "待确认文物",
        era=str(structured.get("era", "")).strip() or None,
        museum_name=str(structured.get("museum_name", "")).strip() or None,
        tags=tags,
        description=str(structured.get("description", "")).strip() or answer_text,
        confidence=float(confidence_value) if confidence_value is not None else None,
        analysis=answer_text,
        reasoning=str(structured.get("reasoning", "")).strip() or answer_text,
        search_hits=[],
    )


async def request_web_candidate(
    site: WebChatSite,
    image_urls: list[str],
    data_dir: Path,
    image_name: str | None = None,
) -> VisionCandidateRead:
    if not image_urls:
        raise ValueError("web bridge requires at least one image url")

    image_path, is_temp = await _materialize_image(image_urls[0], data_dir)
    upload_path = image_path
    upload_is_temp = False
    try:
        upload_path, upload_is_temp = _prepare_web_upload_image(image_path)
        if _remote_bridge_base_url():
            answer_text = await _fetch_answer_remote(site, upload_path, settings.web_prompt)
        else:
            async with _BROWSER_LOCK:  # serialize: one web conversation at a time
                answer_text = await _fetch_answer(site, upload_path, settings.web_prompt)
    finally:
        if upload_is_temp:
            Path(upload_path).unlink(missing_ok=True)
        if is_temp:
            Path(image_path).unlink(missing_ok=True)

    try:
        structured = await _structure_answer(answer_text)
    except Exception as exc:  # noqa: BLE001 - structuring is best-effort
        logger.warning("web bridge %s: 结构化失败，返回原始回答。%s", site.key, exc)
        structured = None

    return _build_candidate(site, answer_text, structured)
