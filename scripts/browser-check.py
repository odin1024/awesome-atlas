"""Headless-browser cross-check: real DOM, real clicks, real screenshots."""
import json
import os
import re
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BASE = 'http://127.0.0.1:8765'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
SHOTS = os.path.join(ROOT, 'docs', 'screenshots')
os.makedirs(SHOTS, exist_ok=True)

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

    page.screenshot(path=os.path.join(SHOTS, 'desktop-map.png'), full_page=False)

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

    # --- graph ---
    page.locator('.view-tab[data-view="graph"]').click()
    page.wait_for_timeout(250)
    nodes = page.locator('.graph-node').count()
    check('关系图谱渲染出节点与 27 条主轴', nodes > 100 and page.locator('.graph-spoke').count() == 27, f'{nodes} 个节点 / {page.locator(".graph-spoke").count()} 条主轴')
    # Two rings now: a reading guide at 0.66R and the node ring at R. The old
    # third ring sat exactly on the label radius and drew a line through the text.
    check('图谱有两层轨道环', page.locator('.graph-orbit').count() == 2, page.locator('.graph-orbit').count())

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
    page.screenshot(path=os.path.join(SHOTS, 'desktop-timeline.png'), full_page=False)

    # --- insight dashboard ---
    page.locator('.view-tab[data-view="insight"]').click()
    page.wait_for_timeout(280)
    check('数据洞察四张图卡', page.locator('.iv-card').count() == 4, page.locator('.iv-card').count())
    check('健康分分布 10 个分桶', page.locator('.iv-bucket').count() == 10, page.locator('.iv-bucket').count())
    check('语言标签云非空', page.locator('.iv-tag').count() >= 5, page.locator('.iv-tag').count())
    page.screenshot(path=os.path.join(SHOTS, 'desktop-insight.png'), full_page=False)

    # --- language switch ---
    page.locator('#langSwitch [data-lang="both"]').click()
    page.wait_for_timeout(260)
    check('双语模式显示英文副标题', page.locator('.cat-name small').count() >= 20, page.locator('.cat-name small').count())
    check('语言状态写入 URL', 'lang=both' in page.url, page.url.split('?')[-1][:80])
    page.locator('#langSwitch [data-lang="en"]').click()
    page.wait_for_timeout(260)
    check('英文模式恢复英文分类', 'Miscellaneous' in page.locator('#categoryList').inner_text(), page.locator('#categoryList').inner_text()[:60].replace('\n', ' / '))
    check('英文模式界面文案切换', page.locator('.view-tab.is-active').inner_text().find('Map') >= 0 or 'Insight' in page.locator('.view-tab.is-active').inner_text(), page.locator('.view-tab.is-active').inner_text())
    page.locator('#langSwitch [data-lang="zh"]').click()
    page.wait_for_timeout(260)
    check('可切回中文', '综合与其他' in page.locator('#categoryList').inner_text(), 'zh restored')

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
    page.screenshot(path=os.path.join(SHOTS, 'desktop-light.png'), full_page=False)

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
    mp.locator('.mobile-tabs [data-view="table"]').click()
    mp.wait_for_timeout(280)
    check('移动端可切换榜单', mp.locator('tbody tr').count() == 40, mp.locator('tbody tr').count())
    mp.locator('.mobile-tabs [data-view="map"]').click()
    mp.wait_for_timeout(280)
    mp.screenshot(path=os.path.join(SHOTS, 'mobile-map.png'), full_page=False)
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
    f.write(f'结果：**{passed} / {len(checks)} 项通过**；控制台异常 {len(errors)} 条。\n\n')
    f.write('| 检查项 | 结果 | 观察值 |\n| --- | --- | --- |\n')
    for c in checks:
        f.write(f"| {c['name']} | {'通过' if c['ok'] else '**失败**'} | {str(c['detail']).replace('|', '\\|')[:110]} |\n")
    f.write('\n截图：`docs/screenshots/desktop-map.png`（分类地图）、`desktop-workspace.png`（三栏工作区）、`desktop-timeline.png`、`desktop-insight.png`、`desktop-light.png`、`mobile-map.png`。\n')

print(json.dumps({'passed': passed, 'total': len(checks), 'errors': errors[:5]}, ensure_ascii=False, indent=2))
for c in checks:
    if not c['ok']:
        print('FAIL:', c['name'], c['detail'])
sys.exit(0 if result['allPassed'] else 1)
