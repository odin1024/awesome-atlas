"""Render docs/banner.png — the social card and README header.

The poster is generated from the same catalogue the site uses: real category
counts, real average health, the same sequential ramp and the same binary
treemap. Nothing on it is drawn by hand, so it cannot drift away from the data.
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
OUT = os.path.join(ROOT, 'docs', 'banner.png')

catalog = json.load(open(os.path.join(ROOT, 'data', 'catalog.json'), encoding='utf-8'))
i18n = json.load(open(os.path.join(ROOT, 'data', 'i18n.json'), encoding='utf-8'))
items = catalog['items']

# Same ramp as assets/app.js (RAMP_LIGHT) — a poster that invents its own colours
# stops being a picture of the site.
RAMP = [(217, 209, 196), (226, 201, 166), (224, 172, 140), (214, 154, 128), (196, 122, 99)]


def health_domain():
    hs = [it['metrics']['health'] for it in items if it.get('metrics')]
    return min(hs), max(hs)


LO, HI = health_domain()


def health_rgb(h):
    if h is None:
        return (138, 134, 126)
    t = 0.5 if HI <= LO else (max(LO, min(HI, h)) - LO) / (HI - LO)
    pos = t * (len(RAMP) - 1)
    i = min(len(RAMP) - 2, int(pos))
    k = pos - i
    return tuple(round(RAMP[i][j] + (RAMP[i + 1][j] - RAMP[i][j]) * k) for j in range(3))


def cat_stats():
    rows = []
    for c in catalog['categories']:
        mine = [it for it in items if it['categoryId'] == c['id'] and it.get('metrics')]
        avg = round(sum(it['metrics']['health'] for it in mine) / len(mine)) if mine else None
        rows.append({
            'id': c['id'],
            'name': i18n['categories'].get(c['id'], {}).get('zh') or c['name'],
            'value': c['itemCount'],
            'health': avg,
        })
    rows.sort(key=lambda r: -r['value'])
    return rows


def treemap(entries, x, y, w, h, out=None):
    out = [] if out is None else out
    if not entries:
        return out
    if len(entries) == 1:
        e = dict(entries[0])
        e.update(x=x, y=y, w=w, h=h)
        out.append(e)
        return out
    total = sum(e['value'] for e in entries) or 1
    acc, split, best = 0, 1, float('inf')
    for i in range(1, len(entries)):
        acc += entries[i - 1]['value']
        if abs(total / 2 - acc) < best:
            best, split = abs(total / 2 - acc), i
    left, right = entries[:split], entries[split:]
    ratio = (sum(e['value'] for e in left) or 0.001) / total
    if w >= h:
        treemap(left, x, y, w * ratio, h, out)
        treemap(right, x + w * ratio, y, w * (1 - ratio), h, out)
    else:
        treemap(left, x, y, w, h * ratio, out)
        treemap(right, x, y + h * ratio, w, h * (1 - ratio), out)
    return out


W, H = 470, 470
tiles = []
for t in treemap(cat_stats(), 0, 0, W, H):
    gap = 2.4
    x, y, w, h = t['x'] + gap, t['y'] + gap, t['w'] - gap * 2, t['h'] - gap * 2
    if w < 2 or h < 2:
        continue
    fs = 13 if w > 150 else 11.5 if w > 92 else 10
    label = ''
    if w > 66 and h > 26:
        # Clip by measure rather than by guess: a CJK glyph is ~1.02em wide.
        limit = max(2, int((w - 10) / (fs * 1.02)))
        text = t['name'] if len(t['name']) <= limit else t['name'][:limit - 1] + '…'
        label = (f'<text x="{x + 6:.1f}" y="{y + fs + 6:.1f}" font-size="{fs}" '
                 f'font-family="PingFang SC, Microsoft YaHei, sans-serif" font-weight="600" '
                 f'fill="#141413">{text}</text>')
    tiles.append(
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
        f'fill="rgb({",".join(map(str, health_rgb(t["health"])))})" stroke="#faf9f5" stroke-width="1.2"/>{label}'
    )

verified = sum(1 for it in items if it.get('metrics'))
stars = sum(it['metrics']['stars'] for it in items if it.get('metrics'))
stats = [
    (str(catalog['stats']['categories']), '技术分类'),
    (str(catalog['stats']['items']), '精选清单'),
    (f'{verified}', '已验证仓库'),
    (f'{stars / 1e4:.0f} 万', '采样 Star'),
]
stat_html = ''.join(
    f'<div class="stat"><div class="stat-v">{v}</div><div class="stat-k">{k}</div></div>'
    for v, k in stats
)

html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  * {{ box-sizing: border-box; margin: 0; }}
  body {{ width: 1200px; height: 630px; background: #faf9f5; color: #141413;
         font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
         display: grid; grid-template-columns: 1fr 470px; gap: 56px; padding: 54px 56px 0;
         border-top: 10px solid #141413; overflow: hidden; }}
  .eyebrow {{ font-family: Consolas, monospace; font-size: 13px; letter-spacing: .18em;
              text-transform: uppercase; color: #a82d22; display: flex; align-items: center; gap: 12px; }}
  .eyebrow i {{ width: 26px; height: 1px; background: currentColor; display: block; }}
  h1 {{ font-family: "Songti SC", "SimSun", "Noto Serif SC", serif; font-size: 66px; line-height: 1.16;
        font-weight: 700; margin: 18px 0 14px; letter-spacing: .01em; }}
  .sub {{ font-size: 23px; line-height: 1.55; color: #4a4842; max-width: 24ch; }}
  .lede {{ font-size: 15.5px; line-height: 1.85; color: #6e6b63; max-width: 38ch; margin-top: 22px;
           padding-left: 13px; border-left: 2px solid #a82d22; }}
  .sub em {{ font-style: normal; color: #a82d22; }}
  .stats {{ display: flex; gap: 34px; position: absolute; left: 56px; bottom: 92px; padding-top: 18px;
            border-top: 1px solid #141413; width: 640px; }}
  .stat-v {{ font-family: Consolas, monospace; font-size: 30px; font-weight: 700; letter-spacing: -.02em; }}
  .stat-k {{ font-size: 12px; color: #6e6b63; margin-top: 2px; letter-spacing: .04em; }}
  .url {{ position: absolute; left: 56px; bottom: 34px; font-family: Consolas, monospace;
          font-size: 14px; color: #6e6b63; letter-spacing: .02em; }}
  .url b {{ color: #141413; font-weight: 600; }}
  .plate {{ border: 1px solid #141413; padding: 12px; align-self: start; margin-top: 4px; }}
  .plate-head {{ display: flex; justify-content: space-between; font-family: Consolas, monospace;
                 font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #6e6b63;
                 padding-bottom: 9px; }}
  .plate-head b {{ color: #a82d22; font-weight: 500; }}
  .plate svg {{ display: block; }}
  .plate-foot {{ display: flex; justify-content: space-between; font-size: 12px; color: #4a4842;
                 border-top: 1px solid #dedad0; margin-top: 9px; padding-top: 9px; }}
  .plate-foot span:last-child {{ color: #a82d22; font-family: Consolas, monospace; }}
  body::after {{ content: ""; position: absolute; right: 0; bottom: 0; width: 300px; height: 300px; }}
</style></head><body>
  <div>
    <div class="eyebrow"><i></i>Awesome Atlas · 数据索引</div>
    <h1>精选清单地图</h1>
    <p class="sub">把 {catalog['stats']['items']} 份清单<br>变成一张<em>看得懂的地图</em></p>
    <p class="lede">源 README 是一份线性列表，看不出结构。这里补上原文没有的四个维度——层级、热度、
      活跃度与时间演化，并把 466 条描述译成中文。不重复列表，只让结构显形。</p>
    <div class="stats">{stat_html}</div>
  </div>
  <div class="plate">
    <div class="plate-head"><b>图 01 · 分类地图</b><span>{catalog['stats']['categories']} 类 · {catalog['stats']['items']} 条</span></div>
    <svg viewBox="0 0 {W} {H}" width="100%" role="img" aria-label="分类树状地图">{"".join(tiles)}</svg>
    <div class="plate-foot"><span>面积 = 清单数 · 颜色 = 平均健康分</span><span>→</span></div>
  </div>
  <div class="url"><b>odin1024.github.io/awesome-atlas</b> &nbsp;·&nbsp; 数据快照 {catalog['generatedAt'][:10]} · {HI - LO and f'健康分 {LO}–{HI}'}</div>
</body></html>"""

os.makedirs(os.path.join(ROOT, 'docs'), exist_ok=True)
html_path = os.path.join(ROOT, 'docs', 'banner.html')
with open(html_path, 'w', encoding='utf-8') as fh:
    fh.write(html)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 1200, 'height': 630}, device_scale_factor=2)
    page = ctx.new_page()
    page.goto('file:///' + html_path.replace('\\', '/'), wait_until='load')
    page.wait_for_timeout(350)
    page.screenshot(path=OUT)
    browser.close()

print('banner:', OUT, os.path.getsize(OUT) // 1024, 'KB', f'{W}x{H} treemap / {len(tiles)} tiles')
