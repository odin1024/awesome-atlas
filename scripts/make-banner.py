"""Render every image the repository itself shows: two README mastheads and the
social preview card.

  docs/banner.png         1600x460   README header, Chinese
  docs/banner-en.png      1600x460   README header, English
  docs/social-preview.png 1200x630   the card GitHub shows when the repo is shared

A header only identifies; it carries no statistics. The numbers a reader wants
(lists, stars, assertions) live in the badge rail under the header, and that
rail is now served by shields.io straight from GitHub rather than baked into
PNGs -- a drawn badge goes stale the moment a check is added, a live one cannot.

Everything here is drawn from data/catalog.json -- category counts, the same
sequential ramp, the same binary treemap as the site -- so no image can drift
from the data.
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
DOCS = os.path.join(ROOT, 'docs')

catalog = json.load(open(os.path.join(ROOT, 'data', 'catalog.json'), encoding='utf-8'))
i18n = json.load(open(os.path.join(ROOT, 'data', 'i18n.json'), encoding='utf-8'))
items = catalog['items']

# Same ramp as assets/app.js (RAMP_LIGHT) — a poster that invents its own colours
# stops being a picture of the site.
RAMP = [(226, 220, 202), (224, 207, 174), (222, 185, 140), (219, 151, 102), (216, 105, 65)]

PAPER, INK, ACCENT = '#faf9f5', '#141413', '#a82d22'
INK2, INK3, RULE = '#4a4842', '#6e6b63', '#dedad0'


def health_domain():
    """The poster draws categories, so it is scaled over category averages, the
    same population the site's category view uses. Scaling over individual repos
    left the two deepest stops unused and flattened the panel."""
    avgs = []
    for c in catalog['categories']:
        mine = [it['metrics']['health'] for it in items if it['categoryId'] == c['id'] and it.get('metrics')]
        if mine:
            avgs.append(round(sum(mine) / len(mine)))
    return min(avgs), max(avgs)


LO, HI = health_domain()


def health_rgb(h):
    if h is None:
        return (138, 134, 126)
    t = 0.5 if HI <= LO else (max(LO, min(HI, h)) - LO) / (HI - LO)
    pos = t * (len(RAMP) - 1)
    i = min(len(RAMP) - 2, int(pos))
    k = pos - i
    return tuple(round(RAMP[i][j] + (RAMP[i + 1][j] - RAMP[i][j]) * k) for j in range(3))


def cat_stats(lang='zh'):
    """Tile labels follow the language of the header: the English README showing a
    Chinese map would be the same mistake as the site mixing the two."""
    rows = []
    for c in catalog['categories']:
        mine = [it for it in items if it['categoryId'] == c['id'] and it.get('metrics')]
        avg = round(sum(it['metrics']['health'] for it in mine) / len(mine)) if mine else None
        name = (i18n['categories'].get(c['id'], {}).get('zh') or c['name']) if lang == 'zh' else c['name']
        rows.append({
            'id': c['id'],
            'name': name,
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


def measure(text, fs):
    """Width in px, without a font engine: CJK is ~1.02em, Latin ~0.56em."""
    return sum(fs * (1.02 if ord(ch) > 0x2E80 else 0.61) for ch in text)


def wrap_label(text, fs, maxw, max_lines=2):
    """Break a label into at most two lines, or return None. English category
    names ("Platforms and Runtimes") never fit one line, and dropping every label
    turned the map into unlabelled colour blocks."""
    lines, cur = [], ''
    for ch in text:
        if measure(cur + ch, fs) > maxw and cur:
            if ' ' in cur and ch != ' ':
                cut = cur.rfind(' ')
                lines.append(cur[:cut])
                cur = cur[cut + 1:] + ch
            else:
                lines.append(cur)
                cur = ch
            if len(lines) > max_lines:
                return None
        else:
            cur += ch
    if cur:
        lines.append(cur)
    if len(lines) > max_lines or any(measure(l, fs) > maxw for l in lines):
        return None
    return lines


def tile_svg(width, height, gap=2.4, labels=True, fs_small=11.5, fs_big=13, lang='zh'):
    """The binary treemap, same algorithm as the site's `treemap()`."""
    tiles = []
    for t in treemap(cat_stats(lang), 0, 0, width, height):
        x, y, w, h = t['x'] + gap, t['y'] + gap, t['w'] - gap * 2, t['h'] - gap * 2
        if w < 2 or h < 2:
            continue
        fs = fs_big if w > 150 else fs_small if w > 92 else 10
        label = ''
        if labels and w > 66 and h > 34:
            # Never truncate: a name either fits (one line, or two for long English
            # names) or is dropped. "平台与运行…" in a header is worse than silence.
            lines = wrap_label(t['name'], fs, w - 16)
            if lines and len(lines) * fs * 1.28 <= h - 12:
                step = fs * 1.24
                spans = ''.join(
                    f'<tspan x="{x + 6:.1f}" y="{y + fs + 6 + i * step:.1f}">{ln}</tspan>'
                    for i, ln in enumerate(lines))
                label = (f'<text font-size="{fs}" font-family="PingFang SC, Microsoft YaHei, sans-serif" '
                         f'font-weight="500" fill="{INK}">{spans}</text>')
        tiles.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'fill="rgb({",".join(map(str, health_rgb(t["health"])))})" stroke="{PAPER}" stroke-width="1.2"/>{label}'
        )
    return ''.join(tiles)


def chips(lang):
    """Five chips from the same ramp the tiles use — a legend drawn from a copy of
    the colours is the classic way for a chart to start lying."""
    return ''.join(
        f'<i style="background:rgb({",".join(map(str, health_rgb(LO + (HI - LO) * i / 4)))})"></i>'
        for i in range(5)
    )


# ---------------------------------------------------------------- copy
COPY = {
    'zh': {
        'mark_a': 'Awesome Atlas',
        'mark_b': '数据索引',
        'title': '精选清单地图',
        'tag': ('一份 {lines} 行的英文 README，从头滚到尾，才知道自己漏了什么。<br>'
                '译成中文、补上 Star 与最近提交——列表一份没少，只是终于有了形状。'),
        'foot': ('<b>odin1024.github.io/awesome-atlas</b> &nbsp;·&nbsp; 数据快照 {date} '
                 '&nbsp;·&nbsp; 中文 / EN'),
        'plate': '图 01 · 分类地图',
        'leg': '面积 = 清单数 · 颜色 = 平均健康分',
        'views': [('01', '分类地图'), ('02', '关系图谱'), ('03', '检索榜单'), ('04', '生态时间轴'), ('05', '数据洞察')],
        'social_kicker': 'Awesome Atlas · 数据索引',
        'social_h1': '精选清单地图',
        'social_sub': '把 {items} 份清单<br>变成一张<em>看得懂的地图</em>',
        'social_lede': ('一份 {lines} 行的英文 README，从头滚到尾，才知道自己漏了什么。<br>'
                        '译成中文、补上 Star 与最近提交——列表一份没少，只是终于有了形状。'),
        'stat_k': ['技术分类', '精选清单', '已验证仓库', '采样 Star'],
        'social_foot': '数据快照 {date} · 健康分 {lo}–{hi}',
    },
    'en': {
        'mark_a': 'Data Index',
        'mark_b': '',
        'title': 'Awesome Atlas',
        'tag': ('An {lines}-line README — you only learn what you missed at the bottom.<br>'
                'Translated, with stars and last-push dates: the same lists, finally given a shape.'),
        'foot': ('<b>odin1024.github.io/awesome-atlas</b> &nbsp;·&nbsp; snapshot {date} '
                 '&nbsp;·&nbsp; 中文 / EN'),
        'plate': 'FIG. 01 · CATEGORY MAP',
        'leg': 'area = lists · colour = health',
        'views': [('01', 'MAP'), ('02', 'GRAPH'), ('03', 'INDEX'), ('04', 'TIMELINE'), ('05', 'INSIGHT')],
        'social_kicker': 'Awesome Atlas · Data index',
        'social_h1': 'Awesome Atlas',
        'social_sub': 'Turn {items} lists<br>into a <em>map you can read</em>',
        'social_lede': ('An {lines}-line README — you only learn what you missed at the bottom.<br>'
                        'Translated, with stars and last-push dates: the same lists, given a shape.'),
        'stat_k': ['categories', 'lists', 'verified repos', 'stars sampled'],
        'social_foot': 'snapshot {date} · health {lo}–{hi}',
    },
}

FOOT_CSS = f"""
  * {{ box-sizing: border-box; margin: 0; }}
  body {{ width: 1600px; height: 460px; background: {PAPER}; color: {INK};
         font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
         display: grid; grid-template-columns: 829px 1fr; overflow: hidden; }}
  .left {{ padding: 44px 0 24px 64px; display: flex; flex-direction: column; }}
  .mark {{ display: flex; align-items: center; gap: 13px; }}
  .mark svg {{ flex: none; }}
  .mark b {{ font-family: Consolas, monospace; font-size: 17px; font-weight: 600;
             letter-spacing: .22em; text-transform: uppercase; }}
  .mark i {{ width: 42px; height: 1px; background: {ACCENT}; display: block; }}
  .mark span {{ font-family: Consolas, monospace; font-size: 17px; letter-spacing: .18em;
                text-transform: uppercase; color: {ACCENT}; }}
  h1 {{ font-family: "Songti SC", "Noto Serif SC", Georgia, "Times New Roman", serif; font-size: 96px;
        line-height: 1.06; font-weight: 700; margin: 22px 0 16px; letter-spacing: .01em; }}
  h1.en {{ font-size: 76px; letter-spacing: -.015em; }}
  .tag {{ font-size: 22px; line-height: 1.8; color: {INK2}; }}
  .tag.en {{ font-size: 19px; line-height: 1.85; }}
  .tag em {{ font-style: normal; color: {ACCENT}; }}
  .views {{ display: flex; margin-top: 26px; }}
  .views .it {{ display: flex; align-items: baseline; gap: 7px; padding: 0 16px;
                border-left: 1px solid {RULE}; font-family: Consolas, "PingFang SC", monospace;
                font-size: 21px; color: {INK3}; letter-spacing: .03em; }}
  .views .it:first-child {{ padding-left: 0; border-left: 0; }}
  .views .it b {{ color: {ACCENT}; font-size: 17px; font-weight: 600; letter-spacing: .1em; }}
  .foot {{ margin-top: auto; width: 690px; border-top: 1px solid {RULE}; padding-top: 14px;
           font-family: Consolas, monospace; font-size: 16.5px; color: {INK3}; letter-spacing: .02em; }}
  .foot b {{ color: {INK}; font-weight: 600; }}
  .band {{ border-left: 1px solid {INK}; display: flex; flex-direction: column; }}
  .band-head {{ height: 54px; flex: none; display: flex; align-items: center;
                justify-content: space-between; padding: 0 18px; border-bottom: 1px solid {INK};
                font-family: Consolas, "PingFang SC", monospace; font-size: 17px;
                letter-spacing: .1em; text-transform: uppercase; color: {INK3}; }}
  .band-head b {{ color: {ACCENT}; font-weight: 600; letter-spacing: .12em; }}
  .band-head span {{ display: flex; align-items: center; gap: 10px; letter-spacing: .04em;
                     text-transform: none; }}
  .band-head .chips {{ display: flex; }}
  .band-head i {{ display: block; width: 22px; height: 10px; }}
  .band svg {{ display: block; }}
"""


def masthead(lang):
    c = COPY[lang]
    lines = catalog['source']['lineCount']
    alt_date = catalog['generatedAt'][:10]
    return f"""<!doctype html><html lang="{'zh-CN' if lang == 'zh' else 'en'}"><head><meta charset="utf-8">
<style>{FOOT_CSS}</style></head><body>
  <div class="left">
    <div class="mark">
      <svg viewBox="0 0 32 32" width="40" height="40">
        <rect x="3.4" y="3.4" width="25.2" height="25.2" fill="none" stroke="{INK}" stroke-width="1.7"/>
        <path d="M17.2 3.4v25.2M17.2 15.6h11.4" stroke="{INK}" stroke-width="1.2" opacity=".45"/>
        <rect x="18.4" y="16.8" width="9" height="10.6" fill="{ACCENT}"/>
      </svg>
      <b>{c['mark_a']}</b>{(f"<i></i><span>{c['mark_b']}</span>") if c['mark_b'] else ''}
    </div>
    <h1 class="{lang}">{c['title']}</h1>
    <p class="tag {lang}">{c['tag'].format(lines=lines)}</p>
    <div class="views">{''.join(f'<span class="it"><b>{n}</b>{t}</span>' for n, t in c['views'])}</div>
    <div class="foot">{c['foot'].format(date=alt_date)}</div>
  </div>
  <div class="band">
    <div class="band-head"><b>{c['plate']}</b><span><span class="chips">{chips(lang)}</span>{c['leg']}</span></div>
    <svg viewBox="0 0 770 406" width="770" height="406" role="img" aria-label="category treemap">
      {tile_svg(770, 406, gap=3, fs_small=17, fs_big=19.5, lang=lang)}
    </svg>
  </div>
</body></html>"""


def social():
    c = COPY['zh']
    lines = catalog['source']['lineCount']
    verified = sum(1 for it in items if it.get('metrics'))
    stars = sum(it['metrics']['stars'] for it in items if it.get('metrics'))
    stats = [(str(catalog['stats']['categories']), c['stat_k'][0]),
             (str(catalog['stats']['items']), c['stat_k'][1]),
             (str(verified), c['stat_k'][2]),
             (f'{stars / 1e4:.0f} 万', c['stat_k'][3])]
    stat_html = ''.join(
        f'<div class="stat"><div class="stat-v">{v}</div><div class="stat-k">{k}</div></div>'
        for v, k in stats)
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  * {{ box-sizing: border-box; margin: 0; }}
  body {{ width: 1200px; height: 630px; background: {PAPER}; color: {INK};
         font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
         display: grid; grid-template-columns: 1fr 470px; gap: 56px; padding: 54px 56px 0;
         border-top: 10px solid {INK}; overflow: hidden; }}
  .eyebrow {{ font-family: Consolas, monospace; font-size: 13px; letter-spacing: .18em;
              text-transform: uppercase; color: {ACCENT}; display: flex; align-items: center; gap: 12px; }}
  .eyebrow i {{ width: 26px; height: 1px; background: currentColor; display: block; }}
  h1 {{ font-family: "Songti SC", "Noto Serif SC", Georgia, "Times New Roman", serif; font-size: 66px; line-height: 1.16;
        font-weight: 700; margin: 18px 0 14px; letter-spacing: .01em; }}
  .sub {{ font-size: 23px; line-height: 1.55; color: {INK2}; max-width: 24ch; }}
  .sub em {{ font-style: normal; color: {ACCENT}; }}
  .lede {{ font-size: 15px; line-height: 1.9; color: {INK3}; margin-top: 22px;
           padding-left: 13px; border-left: 2px solid {ACCENT}; }}
  .stats {{ display: flex; gap: 34px; position: absolute; left: 56px; bottom: 92px; padding-top: 18px;
            border-top: 1px solid {INK}; width: 640px; }}
  .stat-v {{ font-family: Consolas, monospace; font-size: 30px; font-weight: 700; letter-spacing: -.02em; }}
  .stat-k {{ font-size: 12px; color: {INK3}; margin-top: 2px; letter-spacing: .04em; }}
  .url {{ position: absolute; left: 56px; bottom: 34px; font-family: Consolas, monospace;
          font-size: 14px; color: {INK3}; letter-spacing: .02em; }}
  .url b {{ color: {INK}; font-weight: 600; }}
  .plate {{ border: 1px solid {INK}; padding: 12px; align-self: start; margin-top: 4px; }}
  .plate-head {{ display: flex; justify-content: space-between; font-family: Consolas, monospace;
                 font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: {INK3};
                 padding-bottom: 9px; }}
  .plate-head b {{ color: {ACCENT}; font-weight: 500; }}
  .plate svg {{ display: block; }}
  .plate-foot {{ display: flex; justify-content: space-between; font-size: 12px; color: {INK2};
                 border-top: 1px solid {RULE}; margin-top: 9px; padding-top: 9px; }}
  .plate-foot span:last-child {{ color: {ACCENT}; font-family: Consolas, monospace; }}
</style></head><body>
  <div>
    <div class="eyebrow"><svg viewBox="0 0 32 32" width="22" height="22" style="flex:none">
      <rect x="3.4" y="3.4" width="25.2" height="25.2" fill="none" stroke="{INK}" stroke-width="1.7"/>
      <path d="M17.2 3.4v25.2M17.2 15.6h11.4" stroke="{INK}" stroke-width="1.2" opacity=".45"/>
      <rect x="18.4" y="16.8" width="9" height="10.6" fill="{ACCENT}"/></svg>{c['social_kicker']}</div>
    <h1>{c['social_h1']}</h1>
    <p class="sub">{c['social_sub'].format(items=catalog['stats']['items'])}</p>
    <p class="lede">{c['social_lede'].format(lines=lines)}</p>
    <div class="stats">{stat_html}</div>
  </div>
  <div class="plate">
    <div class="plate-head"><b>图 01 · 分类地图</b><span>{catalog['stats']['categories']} 类 · {catalog['stats']['items']} 条</span></div>
    <svg viewBox="0 0 470 470" width="100%" role="img" aria-label="分类树状地图">{tile_svg(470, 470)}</svg>
    <div class="plate-foot"><span>{c['leg']}</span><span>→</span></div>
  </div>
  <div class="url"><b>odin1024.github.io/awesome-atlas</b> &nbsp;·&nbsp; {c['social_foot'].format(date=catalog['generatedAt'][:10], lo=LO, hi=HI)}</div>
</body></html>"""


# ---------------------------------------------------------------- render

jobs = [
    ('docs/banner.html', masthead('zh'), 1600, 460, 'docs/banner.png'),
    ('docs/banner-en.html', masthead('en'), 1600, 460, 'docs/banner-en.png'),
    ('docs/social-preview.html', social(), 1200, 630, 'docs/social-preview.png'),
]

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox'])
    for html_rel, html, w, h, out_rel in jobs:
        html_path = os.path.join(ROOT, html_rel)
        with open(html_path, 'w', encoding='utf-8') as fh:
            fh.write(html)
        ctx = browser.new_context(viewport={'width': w, 'height': h}, device_scale_factor=2)
        page = ctx.new_page()
        page.goto('file:///' + html_path.replace('\\', '/'), wait_until='load')
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(ROOT, out_rel))
        ctx.close()
        print(f'{out_rel}: {os.path.getsize(os.path.join(ROOT, out_rel)) // 1024} KB  {w}x{h}@2x')

    browser.close()

print('ok')
