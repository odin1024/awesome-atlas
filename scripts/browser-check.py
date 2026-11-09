"""Headless-browser cross-check: real DOM, real clicks, real screenshots."""
import json
import os
import re
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
# ATLAS_BASE points the same suite at a deployed origin; ATLAS_SHOTS redirects
# the screenshots so a production run cannot overwrite the README images.
BASE = os.environ.get('ATLAS_BASE', 'http://127.0.0.1:8765')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
SHOTS = os.environ.get('ATLAS_SHOTS') or os.path.join(ROOT, 'docs', 'screenshots')
os.makedirs(SHOTS, exist_ok=True)
# Frames for the README are produced by scripts/shots.py; this suite only
# asserts behaviour, so a failing check can never leave a half-taken gallery.

checks = []
def check(name, ok, detail=''):
    checks.append({'name': name, 'ok': bool(ok), 'detail': str(detail)})

errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox', '--disable-gpu'])
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1, accept_downloads=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text) if m.type == 'error' else None)

    page.goto(BASE, wait_until='networkidle', timeout=60000)
    page.wait_for_timeout(600)

    # --- initial render ---
    check('页面标题为中文', '精选清单地图' in page.title(), page.title())
    check('四张指标卡渲染', page.locator('.metric').count() == 4, page.locator('.metric').count())
    check('侧栏 28 行（全部 + 27 分类）', page.locator('.cat-row').count() == 28, page.locator('.cat-row').count())
    check('地图默认 27 个分类瓦片', page.locator('.tile').count() == 27, page.locator('.tile').count())
    # The map once painted all 27 tiles in one salmon, because the ramp itself
    # spanned ΔE 8 end to end. A palette can regress silently -- nothing errors,
    # the chart just stops encoding anything -- so measure the spread instead.
    spread = page.evaluate("""() => {
      const fills = [...document.querySelectorAll('.tile rect')].map(r => r.getAttribute('fill'));
      const rgb = fills.map(f => f.match(/\\d+/g).map(Number));
      const lum = c => {
        const f = v => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
      };
      const sorted = [...rgb].sort((a, b) => lum(a) - lum(b));
      const [a, b] = [sorted[0], sorted[sorted.length - 1]];
      return { distinct: new Set(fills).size, delta: Math.round(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])) };
    }""")
    check('分类瓦片颜色真的分得开', spread['distinct'] >= 12 and spread['delta'] >= 120,
          f"{spread['distinct']} 种颜色，最浅与最深相差 {spread['delta']}")
    # The description block used to start 5px under the count line, so 「77 条 ·
    # 健康 64」 printed through the category note. Compare the drawn baselines
    # rather than trusting the layout to have stayed put.
    collide = page.evaluate("""() => {
      const bad = [];
      document.querySelectorAll('.tile').forEach(g => {
        const notes = [...g.querySelectorAll('.tile-note')].map(e => +e.getAttribute('y'));
        const subs = [...g.querySelectorAll('.tile-sub')].map(e => +e.getAttribute('y'));
        for (const n of notes) for (const s of subs) {
          if (Math.abs(n - s) < 12) bad.push([g.getAttribute('aria-label'), Math.round(n - s)]);
        }
      });
      return bad;
    }""")
    check('瓦片内释义与计数行不重叠', len(collide) == 0, collide[:3])
    # Re-derive the expected domain from the page's own data instead of quoting a
    # snapshot number: the key must cover exactly the values the tiles were drawn
    # from, so a silent domain change shows up here as a mismatch.
    dom = page.evaluate("""() => {
      const D = window.__ATLAS_DATA__;
      const avgs = D.categories.map(c => {
        const a = D.items.filter(i => i.categoryId === c.id && i.metrics);
        return a.length ? Math.round(a.reduce((s, i) => s + i.metrics.health, 0) / a.length) : null;
      }).filter(v => v !== null);
      return { cap: document.querySelector('.map-scale-cap').textContent.trim(),
               expect: Math.min(...avgs) + ' – ' + Math.max(...avgs) };
    }""")
    check('图例区间等于当前视图的真实极值', dom['cap'] == dom['expect'], f"{dom['cap']} vs {dom['expect']}")
    # Narrow slivers rotate their label instead of truncating it to 「去中心…」.
    clipped = page.locator('.tile-label', has_text='…').all_inner_texts()
    check('瓦片标签无截断残词', len(clipped) == 0, clipped)
    check('窄瓦片改用竖排标签', page.locator('.tile-label[transform^="rotate"]').count() >= 1,
          page.locator('.tile-label[transform^="rotate"]').count())
    check('默认无空状态', page.locator('.empty-state').count() == 0, page.locator('.empty-state').count())
    check('分类显示为中文', '综合与其他' in page.locator('#categoryList').inner_text(), page.locator('#categoryList').inner_text()[:60].replace('\n', ' / '))
    check('四条数据洞察已算出', page.locator('.insight-card').count() == 4, page.locator('.insight-card').count())
    check('详情空态给出当前范围 Top 3', page.locator('.empty-row').count() == 3, page.locator('.empty-row').count())
    check('快捷分类行有「全部 27 类」出口', page.locator('.quick-chip.is-more').count() == 1,
          page.locator('.quick-chip.is-more').all_inner_texts())
    check('五个视图标签', page.locator('.view-tab').count() == 5, page.locator('.view-tab').count())
    check('数据说明已填充', len(page.locator('#aboutCoverage').inner_text()) > 60, page.locator('#aboutCoverage').inner_text()[:60])
    check('覆盖率标注为全量', '100%' in page.locator('#aboutMetricText').inner_text(), page.locator('#aboutMetricText').inner_text()[:90])


    # --- first screen: the preview plate and the shared grid ---
    check('首屏地图预览板渲染 27 个分类瓦片', page.locator('.plate-tile').count() == 27,
          page.locator('.plate-tile').count())
    check('预览板不冒充工作区瓦片（选择器不串）', page.locator('#heroPlate .tile').count() == 0,
          page.locator('#heroPlate .tile').count())
    edges = page.evaluate("""() => [Math.round(document.querySelector('#heroTitle').getBoundingClientRect().left),
                                        Math.round(document.querySelector('.metrics').getBoundingClientRect().left)]""")
    check('首屏与下方版块左边缘对齐', abs(edges[0] - edges[1]) <= 1, edges)
    check('预览板是进入地图的入口', page.locator('#heroPlate').get_attribute('href') == '#workspace',
          page.locator('#heroPlate').get_attribute('href'))
    page.locator('#heroPlate').click()
    page.wait_for_timeout(950)
    merged = page.evaluate("""() => {
      const ws = document.querySelector('#workspace').getBoundingClientRect();
      return {y: Math.round(window.scrollY), top: Math.round(ws.top),
              map: document.querySelector('.view-tab[data-view="map"]').classList.contains('is-active')};
    }""")
    check('点预览板真的落到分类地图', merged['y'] > 200 and merged['map'] and -8 <= merged['top'] <= 620, merged)
    check('分享卡片图已声明', 'docs/banner.png' in (page.locator('meta[property="og:image"]').get_attribute('content') or ''),
          page.locator('meta[property="og:image"]').get_attribute('content'))
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_timeout(400)

    # --- page chrome: brand, nav anchors, footer source link ---
    check('品牌副标题不再出现「中文版」',
          '中文版' not in page.locator('.brand-text').inner_text(),
          page.locator('.brand-text').inner_text().replace('\n', ' / '))

    # The mark must be the plate, not a monogram: one accent-filled tile inside a
    # frame, drawn at a square 30px box so it aligns with the icon buttons.
    mark = page.evaluate("""() => {
      const svg = document.querySelector('.brand-mark svg');
      if (!svg) return null;
      const box = svg.getBoundingClientRect();
      const tile = svg.querySelector('.mark-tile');
      const frame = svg.querySelector('rect:not(.mark-tile)');
      return {
        w: Math.round(box.width), h: Math.round(box.height),
        tileFill: tile ? getComputedStyle(tile).fill : null,
        tileArea: tile ? (tile.width.baseVal.value * tile.height.baseVal.value) : 0,
        frameFill: frame ? getComputedStyle(frame).fill : null,
        accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
        paths: svg.querySelectorAll('path').length,
      };
    }""")
    accent_rgb = page.evaluate("""() => {
      const d = document.createElement('div');
      d.style.color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      document.body.appendChild(d);
      const c = getComputedStyle(d).color; d.remove(); return c;
    }""")
    check('品牌标记为方形图幅（30×30）',
          mark and abs(mark['w'] - 30) <= 1 and abs(mark['h'] - 30) <= 1,
          f"{mark['w']}×{mark['h']}" if mark else '缺失')
    check('品牌标记有且仅有一格实色瓦片',
          mark and mark['tileFill'] == accent_rgb and 60 <= mark['tileArea'] <= 130
          and mark['frameFill'] in ('none', 'rgba(0, 0, 0, 0)'),
          f"瓦片 {mark['tileFill']} / 图幅 {mark['frameFill']}" if mark else '缺失')

    lede = page.evaluate("""() => {
      const el = document.querySelector('#heroSub');
      const s = getComputedStyle(el);
      const br = el.querySelector('br.wrap-only');
      const r = document.createRange();
      r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, el.firstChild.length);
      const rects = [...r.getClientRects()].filter(x => x.width > 1);
      return {
        lines: Math.round(el.clientHeight / parseFloat(s.lineHeight)),
        brShown: br ? getComputedStyle(br).display !== 'none' : false,
        firstLineEnd: el.firstChild.textContent.trim().slice(-1),
        text: el.textContent.trim(),
      };
    }""")
    check('首屏副标题两行、断在句号后',
          lede['lines'] == 2 and lede['brShown'] and lede['firstLineEnd'] == '。',
          f"{lede['lines']} 行，首行止于「{lede['firstLineEnd']}」")
    check('首屏副标题不含罗列式四维术语',
          not any(w in lede['text'] for w in ('四个维度', '层级、热度', '不重复列表')),
          lede['text'][:28] + '…')

    check('顶栏不再放外链按钮', page.locator('.topbar a[href^="http"]').count() == 0,
          page.locator('.topbar a[href^="http"]').count())
    upstream = page.locator('#upstreamLink')
    check('页脚上游入口指向源仓库且新窗口打开',
          upstream.count() == 1
          and 'github.com/sindresorhus/awesome' in (upstream.get_attribute('href') or '')
          and upstream.get_attribute('target') == '_blank',
          upstream.get_attribute('href'))

    landed = []
    for sel in ('#workspace', '#insights', '#about'):
        page.locator('.topnav-link[href="%s"]' % sel).click()
        page.wait_for_timeout(950)
        pos = page.evaluate("""() => {
          const el = document.querySelector('%s');
          return {top: Math.round(el.getBoundingClientRect().top), y: Math.round(window.scrollY)};
        }""" % sel)
        landed.append((sel, pos['top'], pos['y']))
    check('顶栏三个锚点都真的滚到对应区块',
          all(-8 <= t <= 620 and y > 0 for _, t, y in landed), landed)

    # --- scroll ownership: a reload must start at the top ---
    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    page.wait_for_timeout(250)
    deep = page.evaluate('window.scrollY')
    page.evaluate('setTimeout(() => location.reload(), 0)')
    page.wait_for_timeout(1600)
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(300)
    after_reload = page.evaluate('window.scrollY')
    check('刷新后自动回到页面顶部', deep > 600 and after_reload == 0,
          f'scrollY {deep} → {after_reload}')

    page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    page.wait_for_timeout(250)
    page.locator('#backToTop').click()
    page.wait_for_timeout(900)
    check('页脚「回到顶部」按钮生效', page.evaluate('window.scrollY') <= 2,
          page.evaluate('window.scrollY'))

    page.goto(BASE, wait_until='networkidle')
    page.wait_for_timeout(350)

    # --- map drill-down ---
    page.locator('.tile').first.click()
    page.wait_for_timeout(250)
    drilled = page.locator('.tile').count()
    check('点击瓦片可下钻到分类内部', drilled > 5 and 'drill=' in page.url, f'{drilled} 个条目瓦片')
    back = page.locator('[data-action="drill-back"]')
    check('下钻后出现返回面包屑', back.count() == 1, back.count())
    if back.count():
        back.click()
        page.wait_for_timeout(200)
        check('可返回全部分类', page.locator('.tile').count() == 27, page.locator('.tile').count())

    # The note and the colour key used to be laid out below a 100%-height SVG in
    # an `overflow: hidden` body, so both existed in the DOM and were never once
    # visible. Measure the boxes instead of trusting innerText.
    def foot_box():
        return page.evaluate("""() => {
          const b = document.querySelector('#canvasBody');
          const n = document.querySelector('.canvas-note');
          const s = document.querySelector('.map-scale-track');
          if (!b || !n) return {'ok': false, 'why': 'missing'};
          const rb = b.getBoundingClientRect(), rn = n.getBoundingClientRect();
          const inside = rn.top >= rb.top - 1 && rn.bottom <= rb.bottom + 1 && rn.height > 4;
          return {'ok': inside && !!s, 'inside': inside, 'scale': !!s,
                  'bottomGap': Math.round(rb.bottom - rn.bottom)};
        }""")

    foot = foot_box()
    check('地图脚注与色阶真的在画布内可见', foot['ok'], foot)

    # --- graph ---
    page.locator('.view-tab[data-view="graph"]').click()
    page.wait_for_timeout(250)
    nodes = page.locator('.graph-node').count()
    check('关系图谱渲染出节点与 27 条主轴', nodes > 100 and page.locator('.graph-spoke').count() == 27, f'{nodes} 个节点 / {page.locator(".graph-spoke").count()} 条主轴')
    # Two rings now: a reading guide at 0.66R and the node ring at R. The old
    # third ring sat exactly on the label radius and drew a line through the text.
    check('图谱有两层轨道环', page.locator('.graph-orbit').count() == 2, page.locator('.graph-orbit').count())
    gfoot = foot_box()
    check('图谱脚注同样落在画布内', gfoot['ok'], gfoot)

    # Labels must not collide with each other. A handful of label-vs-dot hits is
    # allowed because labels paint above the dots and carry a paper halo.
    geo = page.evaluate("""() => {
      const svg = document.querySelector('.graph-svg');
      const rects = (sel) => [...svg.querySelectorAll(sel)].map(e => e.getBoundingClientRect());
      const labels = rects('.graph-cat-label'), dots = rects('.graph-node circle');
      const overlap = (a, b) => Math.min(a.right,b.right) - Math.max(a.left,b.left) > 0
                             && Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top) > 0;
      let ll = 0, ln = 0;
      for (let i = 0; i < labels.length; i += 1)
        for (let j = i + 1; j < labels.length; j += 1) if (overlap(labels[i], labels[j])) ll += 1;
      labels.forEach(l => dots.forEach(d => { if (overlap(l, d)) ln += 1; }));
      const outside = labels.filter(l => l.left < 0 || l.right > innerWidth).length;
      return {labels: labels.length, ll, ln, outside};
    }""")
    check('27 个分类标签全部渲染', geo['labels'] == 27, geo['labels'])
    check('分类标签之间零重叠', geo['ll'] == 0, geo['ll'])
    check('标签不被圆点遮挡（≤2 且已由底色描边覆盖）', geo['ln'] <= 2, geo['ln'])
    check('标签未溢出视口', geo['outside'] == 0, geo['outside'])
    check('中心圆给出读图说明', page.locator('.graph-guide').count() == 3, page.locator('.graph-guide').count())

    # --- table ---
    page.locator('.view-tab[data-view="table"]').click()
    page.wait_for_timeout(250)
    rows = page.locator('tbody tr').count()
    check('榜单默认每页 40 行', rows == 40, rows)
    check('分页控件存在', page.locator('.pager button').count() == 2, page.locator('.pager button').count())
    first_row = page.locator('tbody tr').first.inner_text()
    check('榜单描述为中文', bool(re.search(r'[\u4e00-\u9fff]', first_row)), first_row[:60].replace('\n', ' / '))

    # The health column used to lose its number and the external-link column sat
    # past the container edge, both clipped by `table-layout: auto`.
    lay = page.evaluate("""() => {
      const wrap = document.querySelector('.table-wrap');
      const num = document.querySelector('.health-num');
      const ext = document.querySelector('.ext-link');
      const wr = wrap.getBoundingClientRect();
      const nr = num.getBoundingClientRect();
      return {overflow: wrap.scrollWidth - wrap.clientWidth,
              num: num.textContent, numInside: nr.right <= wr.right + 1 && nr.width > 0,
              extInside: ext ? ext.getBoundingClientRect().right <= wr.right + 1 : false};
    }""")
    check('榜单不横向溢出', lay['overflow'] == 0, lay['overflow'])
    check('健康分数值可见', lay['numInside'] and lay['num'].isdigit(), f"{lay['num']} / inside={lay['numInside']}")
    check('外链列在容器内', lay['extInside'], lay['extInside'])

    # --- empty result must not crash (regression for the old sort bug) ---
    page.locator('#searchInput').fill('这个关键词一定不存在zzzz')
    page.wait_for_timeout(250)
    check('空结果不崩溃并显示引导', page.locator('.empty-state').count() == 1, page.locator('.empty-state').count())
    check('空结果提供重置按钮', page.locator('[data-action="reset-all"]').count() == 1, page.locator('[data-action="reset-all"]').count())
    page.locator('[data-action="reset-all"]').click()
    page.wait_for_timeout(250)
    check('重置后恢复 40 行', page.locator('tbody tr').count() == 40, page.locator('tbody tr').count())

    # --- Chinese search ---
    page.locator('#searchInput').fill('安全')
    page.wait_for_timeout(250)
    cn_hits = page.locator('#searchCount').inner_text()
    check('中文关键词可检索', '匹配' in cn_hits and page.locator('tbody tr').count() > 0, cn_hits)
    page.locator('#searchClear').click()
    page.wait_for_timeout(180)
    check('可一键清空搜索', page.locator('#searchInput').input_value() == '', 'cleared')

    # --- search + URL sync ---
    page.locator('#searchInput').fill('python')
    page.wait_for_timeout(220)
    check('搜索实时过滤', '匹配' in page.locator('#searchCount').inner_text(), page.locator('#searchCount').inner_text())
    check('搜索状态写入 URL', 'q=python' in page.url, page.url.split('?')[-1][:70])
    page.locator('#searchClear').click()
    page.wait_for_timeout(180)

    # --- detail + favourite ---
    page.locator('tbody tr').first.click()
    page.wait_for_timeout(220)
    check('点击行打开详情画像', page.locator('#detailContent').is_visible() and len(page.locator('.detail-title').inner_text()) > 1, page.locator('.detail-title').inner_text()[:40])
    check('详情显示中文描述', len(page.locator('.detail-desc').inner_text()) > 6, page.locator('.detail-desc').inner_text()[:50])
    check('详情显示健康分环形图', page.locator('.score-ring').count() == 1, page.locator('.score-ring').count())
    page.locator('#detailContent [data-action="fav"]').click()
    page.wait_for_timeout(180)
    check('收藏可写入并即时反馈', 'is-on' in (page.locator('#detailContent [data-action="fav"]').get_attribute('class') or ''), 'is-on')
    check('侧栏收藏计数更新', '1' in page.locator('#favCount').inner_text(), page.locator('#favCount').inner_text())

    # --- export favourites ---
    with page.expect_download(timeout=8000) as dl:
        page.locator('#exportFav').click()
    download = dl.value
    check('收藏可导出为 Markdown', download.suggested_filename.endswith('.md'), download.suggested_filename)

    # --- timeline ---
    page.locator('.view-tab[data-view="timeline"]').click()
    page.wait_for_timeout(280)
    check('时间轴含真实上游变更', page.locator('.commit-item').count() >= 5, page.locator('.commit-item').count())
    # 18 monthly bars plus one bar per repository creation year (33 in total).
    hist = page.locator('.hist-chart')
    check('时间轴两张直方图（推送 18 个月 + 创建年份）',
          page.locator('.hist-col').count() == 32 and hist.count() == 2,
          f"{page.locator('.hist-col').count()} 柱 / {hist.count()} 图")
    check('收录量增长曲线来自历史版本', page.locator('.growth-svg').count() == 1, page.locator('.growth-svg').count())
    check('增删事件带真实清单名', page.locator('.commit-diff span.add, .commit-diff span.del').count() >= 2, page.locator('.commit-diff span').count())
    check('切换视图后详情画像保持', page.locator('#detailContent').is_visible(), 'detail persists')

    # --- insight dashboard ---
    page.locator('.view-tab[data-view="insight"]').click()
    page.wait_for_timeout(280)
    check('数据洞察四张图卡', page.locator('.iv-card').count() == 4, page.locator('.iv-card').count())
    check('健康分分布 10 个分桶', page.locator('.iv-bucket').count() == 10, page.locator('.iv-bucket').count())
    check('语言标签云非空', page.locator('.iv-tag').count() >= 5, page.locator('.iv-tag').count())

    # --- language: two states only ---
    check('语言切换只有中文与 EN 两个选项',
          page.locator('#langSwitch button').count() == 2,
          page.locator('#langSwitch button').all_inner_texts())
    page.locator('#langSwitch [data-lang="en"]').click()
    page.wait_for_timeout(280)
    check('英文模式恢复英文分类',
          'Miscellaneous' in page.locator('#categoryList').inner_text(),
          page.locator('#categoryList').inner_text()[:60].replace('\n', ' / '))
    check('英文模式界面文案切换',
          'Insight' in page.locator('.view-tab.is-active').inner_text(),
          page.locator('.view-tab.is-active').inner_text())
    check('英文模式首屏与栏目同步翻译',
          'curated lists' in page.locator('#heroTitle').inner_text()
          and 'speaks for itself' in page.locator('#insights').inner_text(),
          page.locator('#heroTitle').inner_text().replace('\n', ' | ')[:50])
    # The `||` fallback used to treat EN's empty countSuffix as missing and print
    # "total 678 条" in English mode.
    check('英文模式不再残留中文量词',
          '条' not in page.locator('.search-meta').inner_text(),
          page.locator('.search-meta').inner_text())
    check('语言状态写入 URL', 'lang=en' in page.url, page.url.split('?')[-1][:80])
    page.locator('#langSwitch [data-lang="zh"]').click()
    page.wait_for_timeout(280)
    check('可切回中文', '综合与其他' in page.locator('#categoryList').inner_text(), 'zh restored')
    check('中文首屏文案恢复', '份清单' in page.locator('#heroTitle').inner_text(),
          page.locator('#heroTitle').inner_text()[:40])

    # --- command palette ---
    page.keyboard.press('Control+k')
    page.wait_for_timeout(220)
    check('Ctrl+K 打开命令面板', page.locator('#cmdk').is_visible(), page.locator('#cmdk').is_visible())
    page.locator('#cmdkInput').fill('react')
    page.wait_for_timeout(220)
    check('命令面板实时检索', page.locator('.cmdk-item').count() >= 1, page.locator('.cmdk-item').count())
    page.keyboard.press('Enter')
    page.wait_for_timeout(260)
    check('命令面板可跳转到条目', page.locator('#cmdk').is_hidden() and page.locator('#detailContent').is_visible(), 'jumped')

    # --- theme: assert the switch really changes both the attribute and the paint ---
    theme_before = page.locator('html').get_attribute('data-theme')
    bg_before = page.evaluate("getComputedStyle(document.body).backgroundColor")
    page.locator('#themeToggle').click()
    page.wait_for_timeout(260)
    theme_after = page.locator('html').get_attribute('data-theme')
    bg_after = page.evaluate("getComputedStyle(document.body).backgroundColor")
    check('深浅色主题可切换',
          theme_before != theme_after and theme_after in ('light', 'dark') and bg_before != bg_after,
          f'{theme_before}→{theme_after} / {bg_before} → {bg_after}')
    if theme_after != 'light':
        page.locator('#themeToggle').click()
        page.wait_for_timeout(260)
    check('浅色主题可显式选中', page.locator('html').get_attribute('data-theme') == 'light', page.locator('html').get_attribute('data-theme'))

    # --- every interactive control must produce a response ---
    page.goto(BASE, wait_until='networkidle')
    page.wait_for_timeout(350)

    # Sidebar category used to highlight the row and change nothing on canvas.
    page.locator('#categoryList .cat-row[data-cat="security"]').click()
    page.wait_for_timeout(360)
    focused = page.evaluate("""() => ({
      tiles: document.querySelectorAll('.tile').length,
      dim: document.querySelectorAll('.tile.is-dim').length,
      crumb: (document.querySelector('.breadcrumb') || {}).textContent || '',
      catItems: window.__ATLAS_DATA__.items.filter(i => i.categoryId === 'security').length,
    })""")
    check('侧栏选分类后地图聚焦到该分类',
          focused['tiles'] == focused['catItems'] and focused['dim'] == 0
          and '网络安全' in focused['crumb'] and 'cat=security' in page.url,
          f"{focused['tiles']} 个瓦片 / 该分类 {focused['catItems']} 条 / 面包屑 {focused['crumb'].strip()[:24]}")
    page.locator('#resetFilters').click()
    page.wait_for_timeout(360)
    check('「重置」清空分类与搜索',
          page.locator('.tile').count() == 27
          and page.locator('#searchInput').input_value() == '' and 'cat=' not in page.url,
          page.evaluate('location.search') or '(empty)')

    page.locator('#catSearch').fill('安全')
    page.wait_for_timeout(240)
    narrowed = page.locator('.cat-row').count()
    check('侧栏分类筛选框生效', 1 < narrowed < 28, f'{narrowed} 行')
    page.locator('#catSearch').fill('')
    page.wait_for_timeout(220)
    check('清空分类筛选后恢复 28 行', page.locator('.cat-row').count() == 28,
          page.locator('.cat-row').count())

    counts = page.evaluate("""() => {
      const D = window.__ATLAS_DATA__;
      return {all: D.items.length,
              verified: D.items.filter(i => i.metrics).length,
              archived: D.items.filter(i => i.metrics && i.metrics.archived).length};
    }""")
    page.locator('label.switch-row', has=page.locator('#enrichedOnly')).click()
    page.wait_for_timeout(280)
    check('「仅显示已验证仓库」改变结果集',
          str(counts['verified']) in page.locator('#searchCount').inner_text(),
          f"{page.locator('#searchCount').inner_text()} / 期望 {counts['verified']}")
    page.locator('label.switch-row', has=page.locator('#enrichedOnly')).click()
    page.wait_for_timeout(220)
    page.locator('label.switch-row', has=page.locator('#hideArchived')).click()
    page.wait_for_timeout(280)
    check('「隐藏已归档仓库」改变结果集',
          str(counts['all'] - counts['archived']) in page.locator('#searchCount').inner_text(),
          f"{page.locator('#searchCount').inner_text()} / 期望 {counts['all'] - counts['archived']}")
    page.locator('label.switch-row', has=page.locator('#hideArchived')).click()
    page.wait_for_timeout(220)
    fav_n = page.evaluate("JSON.parse(localStorage.getItem('atlas-favorites') || '[]').length")
    page.locator('label.switch-row', has=page.locator('#favoritesOnly')).click()
    page.wait_for_timeout(280)
    check('「仅显示我的收藏」按收藏集过滤',
          str(fav_n) in page.locator('#searchCount').inner_text(),
          f"{page.locator('#searchCount').inner_text()} / 收藏 {fav_n} 条")
    page.locator('label.switch-row', has=page.locator('#favoritesOnly')).click()
    page.wait_for_timeout(220)

    # map: the area-basis toggle has to re-lay the treemap, not just restyle
    before_geom = page.evaluate("document.querySelector('.tile rect').getAttribute('width')")
    page.locator('[data-metric="stars"]').click()
    page.wait_for_timeout(320)
    after_geom = page.evaluate("document.querySelector('.tile rect').getAttribute('width')")
    check('地图「面积依据」切换会重排瓦片',
          before_geom != after_geom and 'metric=stars' in page.url,
          f'first tile {before_geom} → {after_geom}')
    page.locator('[data-metric="count"]').click()
    page.wait_for_timeout(260)

    # graph: the scope select must change the dot cloud
    page.locator('.view-tab[data-view="graph"]').click()
    page.wait_for_timeout(320)
    dots_curated = page.locator('.graph-node circle').count()
    page.locator('#scopeSelect').select_option('all')
    page.wait_for_timeout(380)
    dots_all = page.locator('.graph-node circle').count()
    check('图谱「显示范围」下拉改变节点数', dots_all > dots_curated,
          f'{dots_curated} → {dots_all} 个节点')
    page.locator('#scopeSelect').select_option('curated')
    page.wait_for_timeout(260)

    # table: sort, pagination, row-level favourite
    page.locator('.view-tab[data-view="table"]').click()
    page.wait_for_timeout(320)
    row_before = page.locator('tbody tr').first.inner_text()
    page.locator('#sortSelect').select_option('name')
    page.wait_for_timeout(320)
    check('榜单排序下拉真的重新排序',
          page.locator('tbody tr').first.inner_text() != row_before,
          page.locator('tbody tr').first.inner_text()[:40].replace('\n', ' / '))
    page.locator('#sortSelect').select_option('stars')
    page.wait_for_timeout(260)

    pager_next, pager_prev = page.locator('.pager [data-action="page"]').nth(1), page.locator('.pager [data-action="page"]').nth(0)
    pager_next.click()
    page.wait_for_timeout(300)
    check('分页「下一页」可用',
          '2 /' in page.locator('.pager').inner_text() and 'page=2' in page.url,
          page.locator('.pager').inner_text().replace('\n', ' '))
    pager_prev.click()
    page.wait_for_timeout(260)
    check('分页「上一页」可返回第一页', '1 /' in page.locator('.pager').inner_text(),
          page.locator('.pager').inner_text().replace('\n', ' '))

    fav_before = page.evaluate("JSON.parse(localStorage.getItem('atlas-favorites') || '[]').length")
    star = page.locator('tbody tr').first.locator('.star-btn')
    icon_before = star.inner_text().strip()
    star.click()
    page.wait_for_timeout(240)
    fav_after = page.evaluate("JSON.parse(localStorage.getItem('atlas-favorites') || '[]').length")
    icon_after = page.locator('tbody tr').first.locator('.star-btn').inner_text().strip()
    check('榜单行内 ☆ 可切换收藏',
          abs(fav_after - fav_before) == 1 and icon_after != icon_before,
          f"{fav_before} → {fav_after} 条 / {icon_before} → {icon_after}")
    page.locator('tbody tr').first.locator('.star-btn').click()
    page.wait_for_timeout(220)

    # detail rail actions
    page.locator('tbody tr').first.click()
    page.wait_for_timeout(260)
    page.locator('#detailContent [data-action="copy-link"]').click()
    page.wait_for_timeout(280)
    check('详情「复制链接」给出反馈',
          page.locator('#toast').is_visible(),
          page.locator('#toast').inner_text())
    page.locator('#detailContent [data-action="focus-cat"]').click()
    page.wait_for_timeout(320)
    check('详情「看同分类」跳到该分类榜单',
          'cat=' in page.url and 'is-active' in (page.locator('.view-tab[data-view="table"]').get_attribute('class') or ''),
          page.url.split('?')[-1][:60])
    page.locator('#detailContent [data-action="close"]').click()
    page.wait_for_timeout(240)
    check('详情关闭按钮恢复空态', page.locator('#detailEmpty').is_visible(), 'empty restored')

    # timeline ranked list and insight bars are buttons too
    page.locator('.view-tab[data-view="timeline"]').click()
    page.wait_for_timeout(340)
    stale_first = page.locator('.stale-list button').first.inner_text()
    page.locator('.stale-list button').first.click()
    page.wait_for_timeout(320)
    check('时间轴「最久未更新」条目可打开详情',
          page.locator('#detailContent').is_visible(), stale_first[:30].replace('\n', ' '))

    page.locator('.view-tab[data-view="insight"]').click()
    page.wait_for_timeout(340)
    page.locator('.iv-bar-label').first.click()
    page.wait_for_timeout(340)
    check('洞察条形的分类标签可跳回地图',
          page.locator('.treemap-svg').count() == 1, page.evaluate('location.search')[:50] or '(empty)')

    # command palette via the toolbar button, arrow keys and the backdrop
    page.locator('#cmdkOpen').click()
    page.wait_for_timeout(280)
    check('顶栏搜索按钮可打开命令面板', page.locator('#cmdk').is_visible(), 'visible')
    page.keyboard.press('ArrowDown')
    page.keyboard.press('ArrowDown')
    page.wait_for_timeout(200)
    check('命令面板方向键移动高亮', page.locator('.cmdk-item.is-active').count() == 1,
          page.locator('.cmdk-item.is-active').count())
    page.keyboard.press('Escape')
    page.wait_for_timeout(220)
    check('Esc 可关闭命令面板', page.locator('#cmdk').is_hidden(), 'hidden')
    page.locator('#cmdkOpen').click()
    page.wait_for_timeout(260)
    page.locator('#cmdk').click(position={'x': 6, 'y': 6})
    page.wait_for_timeout(240)
    check('点击遮罩可关闭命令面板', page.locator('#cmdk').is_hidden(), 'hidden')

    # --- direct URL state restore ---
    page.goto(BASE + '/?view=graph&cat=security&q=web&lang=zh', wait_until='networkidle')
    page.wait_for_timeout(300)
    check('URL 参数可还原视图与筛选', 'is-active' in (page.locator('.view-tab[data-view="graph"]').get_attribute('class') or '') and page.locator('#searchInput').input_value() == 'web', page.url.split('?')[-1])

    # --- mobile ---
    mobile = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=1, is_mobile=True, has_touch=True)
    mp = mobile.new_page()
    mp.on('pageerror', lambda e: errors.append('mobile pageerror: ' + str(e)))
    mp.goto(BASE, wait_until='networkidle', timeout=60000)
    mp.wait_for_timeout(500)
    overflow = mp.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    check('移动端无横向溢出', overflow <= 2, f'overflow={overflow}px')
    check('移动端地图仍渲染', mp.locator('.tile').count() == 27, mp.locator('.tile').count())
    check('移动端底部视图栏', mp.locator('.mobile-tabs button').count() == 5, mp.locator('.mobile-tabs button').count())
    for view, sel, label in [('table', 'tbody tr', '榜单'), ('graph', '.graph-svg', '图谱'),
                             ('timeline', '.tl-grid', '时间轴'), ('insight', '.iv-card', '洞察')]:
        mp.locator('.mobile-tabs [data-view="%s"]' % view).click()
        mp.wait_for_timeout(340)
        check('移动端可切换到%s' % label, mp.locator(sel).count() > 0, mp.locator(sel).count())
    mp.locator('.mobile-tabs [data-view="map"]').click()
    mp.wait_for_timeout(300)
    check('移动端可切回地图', mp.locator('.tile').count() == 27, mp.locator('.tile').count())
    # A 420px rule used to hide the second language button; with 双语 gone that
    # selector would have hidden EN instead.
    check('移动端两个语言按钮都可见',
          mp.locator('#langSwitch button').count() == 2
          and mp.locator('#langSwitch [data-lang="en"]').is_visible(),
          mp.locator('#langSwitch button').count())
    mp.locator('#langSwitch [data-lang="en"]').click()
    mp.wait_for_timeout(320)
    check('移动端可切到英文', 'Miscellaneous' in mp.locator('#categoryList').inner_text(),
          mp.locator('#categoryList').inner_text()[:40].replace('\n', ' / '))
    mp.locator('#langSwitch [data-lang="zh"]').click()
    mp.wait_for_timeout(320)
    mobile.close()

    check('浏览器控制台无 JS 异常', len(errors) == 0, '; '.join(errors[:3]) if errors else '0 errors')
    browser.close()

passed = sum(1 for c in checks if c['ok'])
result = {'passed': passed, 'total': len(checks), 'allPassed': passed == len(checks), 'checks': checks, 'consoleErrors': errors}
with open(os.path.join(ROOT, 'data', 'browser-check.json'), 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

report_path = os.path.join(ROOT, 'docs', 'VALIDATION.md')
with open(report_path, 'r', encoding='utf-8') as f:
    previous = f.read()
base = previous.split('## 浏览器实机验证')[0].rstrip() + '\n\n'
with open(report_path, 'w', encoding='utf-8') as f:
    f.write(base + '## 浏览器实机验证（Playwright + Chrome headless）\n\n')
    f.write(f'结果：**{passed} / {len(checks)} 项通过**；控制台异常 {len(errors)} 条。\n')
    # The same suite runs locally and against the deployed origin, so the report
    # has to say which one produced these numbers.
    origin = '线上' if not BASE.startswith('http://127.0.0.1') else '本地'
    f.write(f'环境：`{BASE}`（{origin}）\n\n')
    f.write('| 检查项 | 结果 | 观察值 |\n| --- | --- | --- |\n')
    for c in checks:
        f.write(f"| {c['name']} | {'通过' if c['ok'] else '**失败**'} | {str(c['detail']).replace('|', '\\|')[:110]} |\n")
    f.write('\n截图：`docs/screenshots/hero.png`（首屏）、`desktop-map.png`、`desktop-graph.png`、`desktop-table.png`、`desktop-timeline.png`、`desktop-insight.png`、`desktop-detail.png`、`desktop-dark.png`、`mobile-hero.png`、`mobile-map.png`，全部由 `scripts/shots.py` 生成。\n')

print(json.dumps({'passed': passed, 'total': len(checks), 'errors': errors[:5]}, ensure_ascii=False, indent=2))
for c in checks:
    if not c['ok']:
        print('FAIL:', c['name'], c['detail'])
sys.exit(0 if result['allPassed'] else 1)
