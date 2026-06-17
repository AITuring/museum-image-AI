import argparse
import asyncio
import json
from pathlib import Path

from playwright.async_api import async_playwright


DATA_DIR = Path(__file__).resolve().parents[2] / "data"
STATE_PATH = DATA_DIR / "qwen_web_state.json"
PROFILE_PATH = DATA_DIR / "web_chrome_profile"
SHOT_PATH = DATA_DIR / "qwen_dom_probe.png"
OUT_PATH = DATA_DIR / "qwen_dom_probe.json"
URL = "https://www.qianwen.com/"
STEALTH_SCRIPT = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || {runtime: {}};
Object.defineProperty(navigator, 'languages', {get: () => ['zh-CN', 'zh', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
""".strip()


async def main(headless: bool, wait_ms: int, profile_dir: Path | None) -> None:
    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir or PROFILE_PATH),
            channel="chrome",
            headless=headless,
            no_viewport=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        await context.add_init_script(STEALTH_SCRIPT)
        if STATE_PATH.exists():
            data = json.loads(STATE_PATH.read_text())
            cookies = data.get("cookies", []) or []
            if cookies:
                await context.add_cookies(cookies)
        page = await context.new_page()
        await page.goto(URL, wait_until="domcontentloaded", timeout=60000)
        await page.wait_for_timeout(wait_ms)

        payload = await page.evaluate(
            """() => {
                const buttons = [...document.querySelectorAll('button,[role="button"]')]
                  .map((el) => ({
                    text: (el.innerText || '').trim(),
                    ariaLabel: el.getAttribute('aria-label') || '',
                    title: el.getAttribute('title') || '',
                    testid: el.getAttribute('data-testid') || '',
                    className: String(el.className || ''),
                  }))
                  .filter((item) => item.text || item.ariaLabel || item.title || item.testid)
                  .slice(0, 200);

                const fileInputs = [...document.querySelectorAll('input[type="file"]')].map((el) => ({
                  accept: el.getAttribute('accept') || '',
                  multiple: el.multiple,
                  hidden: !!(el.offsetParent === null),
                  className: String(el.className || ''),
                }));

                const editable = [...document.querySelectorAll('[contenteditable="true"], textarea')]
                  .map((el) => ({
                    tag: el.tagName,
                    text: (el.innerText || '').trim(),
                    ariaLabel: el.getAttribute('aria-label') || '',
                    placeholder: el.getAttribute('placeholder') || '',
                    className: String(el.className || ''),
                  }))
                  .slice(0, 50);

                return {
                  title: document.title,
                  url: location.href,
                  buttons,
                  fileInputs,
                  editable,
                  bodyTextPreview: (document.body?.innerText || '').slice(0, 4000),
                };
            }"""
        )

        await page.screenshot(path=str(SHOT_PATH), full_page=True)
        OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        print(str(OUT_PATH))
        print(str(SHOT_PATH))
        await context.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Inspect current qianwen DOM for web bridge tuning.")
    parser.add_argument("--headful", action="store_true", help="Launch a visible Chrome window.")
    parser.add_argument("--wait-ms", type=int, default=8000, help="How long to wait after DOMContentLoaded.")
    parser.add_argument("--profile-dir", help="Optional persistent profile dir override.")
    args = parser.parse_args()
    asyncio.run(
        main(
            headless=not args.headful,
            wait_ms=args.wait_ms,
            profile_dir=Path(args.profile_dir).resolve() if args.profile_dir else None,
        )
    )
