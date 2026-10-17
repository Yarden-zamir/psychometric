# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright>=1.55,<2"]
# ///
"""uv run --script tools/build-text-sheets.py [bank ids]. Uses isolated headless Chrome.

Generated PNGs/HTML contain NITE content and are gitignored. Real browser text
shaping is essential for Hebrew niqqud and embedded English/numbers.
"""
import base64
import hashlib
import html
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "tools/text-review-sheets"
CSS = """<style>
* {box-sizing:border-box} body {margin:0;width:1520px;font:18px Arial;background:white;color:black}
.row {border-bottom:2px solid #888;padding:12px;break-inside:avoid}
header {font:17px monospace;padding-bottom:12px} .panels {display:grid;grid-template-columns:740px 740px;gap:16px}
img {max-width:100%;width:auto;height:auto} .text {padding:0 12px;white-space:pre-wrap;line-height:1.4;overflow-wrap:anywhere}
.stem {margin-bottom:14px}.choice {margin-bottom:4px} .title {font-weight:bold}.instructions {margin:8px 0 16px}
.line {min-height:25px}.num {display:inline-block;width:40px;font-size:14px;color:#777;direction:ltr}
</style>"""


def row(bank, item):
    image = ROOT / "site/banks" / bank["id"] / item["file"]
    uri = "data:image/webp;base64," + base64.b64encode(image.read_bytes()).decode()
    t = item["text"]
    if "stem" in t:
        text = f'<div class="stem">{html.escape(t["stem"])}</div>'
        text += "".join(f'<div class="choice">({i + 1}) {html.escape(c)}</div>' for i, c in enumerate(t["choices"]))
    else:
        text = f'<div class="title">{html.escape(t["title"] or "")}</div>'
        text += f'<div class="instructions">{html.escape(t["instructions"] or "")}</div>'
        text += "".join(f'<div class="line"><span class="num">{line["n"] or ""}</span>{html.escape(line["text"])}</div>' for line in t["lines"])
    return f'''<div class="row"><header>{bank["id"]} / {item["id"]} — SOURCE | TEXT</header>
<div class="panels"><div><img src="{uri}"></div><div class="text" dir="{t["dir"]}">{text}</div></div></div>'''


def main():
    OUT.mkdir(exist_ok=True)
    manifest_bytes = (ROOT / "site/banks/manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    report = {"manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(), "sheets": []}
    only = sys.argv[1:]
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless=True)
        page = browser.new_page(viewport={"width": 1520, "height": 1000}, device_scale_factor=1)
        for bank in manifest["banks"]:
            if only and bank["id"] not in only:
                continue
            items = [i for i in bank["questions"] + bank["contexts"] if i.get("text")]
            rows = [row(bank, i) for i in items]
            page.set_content(CSS + "".join(rows), wait_until="load")
            heights = page.locator(".row").evaluate_all("rows => rows.map(r => r.getBoundingClientRect().height)")
            groups, current, height = [], [], 0
            for i, h in enumerate(heights):
                if current and (height + h > 3000 or len(current) == 10):
                    groups.append(current)
                    current, height = [], 0
                current.append(i)
                height += h
            if current:
                groups.append(current)
            for n, indexes in enumerate(groups, 1):
                name = f"{bank['id']}-{n:02d}"
                content = CSS + "".join(rows[i] for i in indexes)
                (OUT / f"{name}.html").write_text(content)
                page.set_content(content, wait_until="load")
                path = OUT / f"{name}.png"
                page.screenshot(path=path, full_page=True)
                report["sheets"].append({"file": f"tools/text-review-sheets/{name}.png", "bank": bank["id"],
                                         "ids": [items[i]["id"] for i in indexes], "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            print(bank["id"], len(groups), "sheets")
        browser.close()
    (OUT / "index.local.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
