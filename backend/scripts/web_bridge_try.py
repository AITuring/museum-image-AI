"""Standalone tuning/test tool for the web bridges (通义 / 豆包).

Self-contained: only needs `playwright` installed (NOT the whole backend). Use it to
verify login, upload, send, and—most importantly—to tune the answer selector by seeing
exactly what text gets scraped. Runs headful by default so you can watch.

Examples:
    python backend/scripts/web_bridge_try.py --site qwen   --image data/uploads/foo.jpg
    python backend/scripts/web_bridge_try.py --site doubao --image data/uploads/foo.jpg \
        --answer-selector "[data-testid='message_text_content']"

Prerequisite: run web_bridge_login.py for that site first to create the session file.
"""

import argparse
import asyncio
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data"

PRESETS = {
    "qwen": {
        "url": "https://www.qianwen.com/",
        "storage_state": DATA_DIR / "qwen_web_state.json",
        "image_selector": 'input[type="file"][accept*="webp"]',
        "composer_name": "向千问提问",
        "answer_selector": "[class*='markdown']",
        "send": "发送消息",  # button accessible name; or "enter"
        "attach": "添加附件",  # attach button name; "" to upload via input directly
    },
    "doubao": {
        "url": "https://www.doubao.com/chat/",
        "storage_state": DATA_DIR / "doubao_web_state.json",
        "image_selector": 'input[type="file"]',
        "composer_name": "发消息...",
        "answer_selector": "[class*='markdown']",
        "send": "enter",
        "attach": "",
    },
}

DEFAULT_PROMPT = (
    "请识别这件文物：用相似图检索确认它的身份，然后告诉我它的名称、年代、"
    "所属博物馆或出土地、用途和历史背景。"
)


async def run(cfg: dict, image: Path, prompt: str, timeout: int, headless: bool, keep_open: bool = False) -> None:
    from playwright.async_api import async_playwright

    storage_state = str(cfg["storage_state"]) if Path(cfg["storage_state"]).exists() else None
    if storage_state is None:
        print(f"[warn] 未找到登录会话 {cfg['storage_state']}，先跑 web_bridge_login.py。")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless, args=["--no-sandbox"])
        context = await browser.new_context(storage_state=storage_state, viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        await page.goto(cfg["url"], wait_until="domcontentloaded")
        await page.wait_for_timeout(2500)

        print(f"[info] 上传图片: {image}")
        existing = page.locator(cfg["image_selector"]).first
        try:
            await existing.wait_for(state="attached", timeout=35000)
            await existing.set_input_files(str(image))
        except Exception:
            if cfg.get("attach"):
                async with page.expect_file_chooser() as fc_info:
                    await page.get_by_role("button", name=cfg["attach"]).click(force=True)
                chooser = await fc_info.value
                await chooser.set_files(str(image))
            else:
                raise
        print("[info] 图片已选择")
        await page.wait_for_timeout(3000)

        composer = page.get_by_role("textbox", name=cfg["composer_name"])
        await composer.click()
        await composer.fill(prompt)
        await page.wait_for_timeout(500)

        if cfg["send"] == "enter":
            await composer.press("Enter")
        else:
            await page.get_by_role("button", name=cfg["send"]).click()
        print("[info] 已发送，等待答案…")

        last = ""
        stable = 0
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            await asyncio.sleep(2.0)
            cur = await page.evaluate(
                """(sel) => { const n=[...document.querySelectorAll(sel)]; return n.length ? (n[n.length-1].innerText||'').trim() : ''; }""",
                cfg["answer_selector"],
            )
            stable = stable + 1 if (cur and cur == last) else 0
            last = cur
            print(f"[poll] 命中长度={len(cur)} 稳定轮次={stable}")
            if stable >= 4:
                break

        shot = DATA_DIR / f"web_try_{cfg['_key']}.png"
        try:
            await page.screenshot(path=str(shot), timeout=10000)
        except Exception as e:
            print(f"[warn] 截图失败: {e}")
        print("=" * 70)
        print(f"[result] 截图: {shot}")
        print(f"[result] 抓到的答案（selector={cfg['answer_selector']}）：\n{last or '(空 —— 选择器没命中，需调整)'}")
        print("=" * 70)
        if keep_open:
            print("浏览器保持打开，回车关闭…")
            await asyncio.get_event_loop().run_in_executor(None, input)
        await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Try/tune a web-bridge site.")
    parser.add_argument("--site", choices=sorted(PRESETS.keys()), required=True)
    parser.add_argument("--image", type=Path, required=True)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument("--answer-selector", help="Override the answer CSS selector")
    parser.add_argument("--composer-name", help="Override the composer accessible name")
    parser.add_argument("--image-selector", help="Override the file input selector")
    parser.add_argument("--send", help='Override send: button name or "enter"')
    parser.add_argument("--attach", help='Override attach button name ("" = direct input)')
    parser.add_argument("--timeout", type=int, default=150)
    parser.add_argument("--headless", action="store_true", help="Run headless (default headful)")
    parser.add_argument("--keep-open", action="store_true", help="Wait for Enter before closing")
    args = parser.parse_args()

    cfg = dict(PRESETS[args.site])
    cfg["_key"] = args.site
    if args.answer_selector:
        cfg["answer_selector"] = args.answer_selector
    if args.composer_name:
        cfg["composer_name"] = args.composer_name
    if args.image_selector:
        cfg["image_selector"] = args.image_selector
    if args.send:
        cfg["send"] = args.send
    if args.attach is not None:
        cfg["attach"] = args.attach

    if not args.image.exists():
        raise SystemExit(f"image not found: {args.image}")

    asyncio.run(run(cfg, args.image, args.prompt, args.timeout, args.headless, args.keep_open))
