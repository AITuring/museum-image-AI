"""Open 通义 (qianwen.com) in a real Chrome window for a one-time manual login.

The window stays open and the script keeps saving the session every few seconds, so
once you finish the login (scan QR / SMS code) the storage_state file already holds a
valid session — no terminal Enter needed. The bridge injects these cookies at runtime.

The bridge drives a *real* Google Chrome, so we log in with the same channel here to keep
the session consistent.

Run on your host machine (where you can see the browser and scan the QR code):

    .venv-webtune/bin/python backend/scripts/web_bridge_login.py --duration 300
"""

import argparse
import asyncio
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parents[2] / "data"
URL = "https://www.qianwen.com/"
OUT = DATA_DIR / "qwen_web_state.json"


async def run(duration: int) -> None:
    from playwright.async_api import async_playwright

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(
            user_data_dir=str(DATA_DIR / "login_chrome_profile"),
            channel="chrome",
            headless=False,
            no_viewport=True,
            args=["--start-maximized", "--disable-blink-features=AutomationControlled"],
        )
        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto(URL, wait_until="domcontentloaded", timeout=45000)
            print(f"窗口已打开: {URL}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"打开较慢/失败(可继续手动操作): {exc}", flush=True)

        print("=" * 72, flush=True)
        print("请在打开的窗口里完成通义登录（扫码/验证码）。", flush=True)
        print(f"脚本会持续 {duration}s 自动保存会话到 {OUT.name}，登录完成即可关掉窗口。", flush=True)
        print("=" * 72, flush=True)

        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            remaining = int(deadline - time.monotonic())
            try:
                await context.storage_state(path=str(OUT))
                try:
                    login_btn = await page.get_by_role("button", name="登录").count()
                except Exception:  # noqa: BLE001
                    login_btn = -1
                state = "可能已登录" if login_btn == 0 else "请完成登录"
                print(f"已保存 {OUT.name} | 登录按钮={login_btn} | {state} | 剩余{remaining}s", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"保存出错: {exc}", flush=True)

        await context.close()
        print(f"已结束。会话文件保存在 {OUT}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Manual login for 通义 (qianwen.com).")
    parser.add_argument("--duration", type=int, default=300, help="窗口保持/自动保存的总秒数")
    args = parser.parse_args()
    asyncio.run(run(args.duration))
