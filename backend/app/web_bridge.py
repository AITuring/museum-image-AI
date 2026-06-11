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
import json
import logging
import re
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
    path = Path(storage_state_path)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    return data.get("cookies", []) or []


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


async def _upload_image(page, site: WebChatSite, image_path: Path) -> None:
    """Upload the image.

    The hidden <input type=file> is often injected a few seconds after load, so we wait
    for it and set files directly. Only if it never appears do we fall back to clicking
    an attach control and catching the file chooser.
    """
    existing = page.locator(site.image_input_selector).first
    try:
        await existing.wait_for(state="attached", timeout=35000)
        await existing.set_input_files(str(image_path))
        return
    except Exception:
        pass

    if site.attach_name:
        async with page.expect_file_chooser() as fc_info:
            await page.get_by_role("button", name=site.attach_name).click(force=True)
        chooser = await fc_info.value
        await chooser.set_files(str(image_path))
        return

    raise RuntimeError(
        f"{site.label}: 未找到图片上传输入框（selector={site.image_input_selector}）。"
    )


async def _wait_for_answer(page, site: WebChatSite) -> str:
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
            """(sel) => {
                const nodes = [...document.querySelectorAll(sel)];
                if (!nodes.length) return "";
                return (nodes[nodes.length - 1].innerText || "").trim();
            }""",
            site.answer_selector,
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

    page = await context.new_page()
    try:
        await page.goto(site.url, wait_until="domcontentloaded")
        await page.wait_for_timeout(7000)

        await _upload_image(page, site, image_path)
        await page.wait_for_timeout(5000)  # let the upload/thumbnail register

        composer = page.locator(site.composer_selector).first
        await composer.click()
        # contenteditable composers ignore Locator.fill, so type the keystrokes.
        await page.keyboard.type(prompt)
        await page.wait_for_timeout(500)

        if site.send_button_name:
            await page.get_by_role("button", name=site.send_button_name).click()
        else:
            await composer.press("Enter")

        return await _wait_for_answer(page, site)
    finally:
        await page.close()


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


def _extract_tag_block(answer_text: str) -> tuple[list[str], str]:
    marker = re.compile(r"^(?:适合入库的)?(?:推荐)?标签(?:如下)?\s*[:：]\s*(.*)$")
    lines = answer_text.split("\n")
    for index, line in enumerate(lines):
        match = marker.match(line.strip())
        if not match:
            continue
        tag_lines = [match.group(1).strip()] if match.group(1).strip() else []
        remainder_lines = lines[index + 1 :]
        for remainder in remainder_lines:
            stripped = remainder.strip()
            if not stripped:
                break
            if re.match(r"^(?:说明|备注|理由|依据|补充)[:：]", stripped):
                break
            tag_lines.append(stripped)
        description_lines = lines[:index]
        description = "\n".join(description_lines).strip()
        tags = _parse_tag_tokens("\n".join(tag_lines))
        return tags, description
    return [], answer_text


def _derive_tags(answer_text: str, artifact_name: str, era: str, museum_name: str) -> list[str]:
    tags: list[str] = []
    for keyword in ["青铜器", "礼器", "铭文", "龙纹", "簋", "鼎", "尊", "陶器", "瓷器", "佛像"]:
        if keyword in answer_text and keyword not in tags:
            tags.append(keyword)
        if len(tags) >= 6:
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
    try:
        async with _BROWSER_LOCK:  # serialize: one web conversation at a time
            answer_text = await _fetch_answer(site, image_path, settings.web_prompt)
    finally:
        if is_temp:
            Path(image_path).unlink(missing_ok=True)

    try:
        structured = await _structure_answer(answer_text)
    except Exception as exc:  # noqa: BLE001 - structuring is best-effort
        logger.warning("web bridge %s: 结构化失败，返回原始回答。%s", site.key, exc)
        structured = None

    return _build_candidate(site, answer_text, structured)
