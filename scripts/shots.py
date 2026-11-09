"""Regenerate docs/screenshots/ — one deterministic frame per view.

Screenshots are part of the deliverable (README, validation report), so they are
produced by a script rather than by hand: same viewport, same scroll offset, same
wait, every time.
"""
import os
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SHOTS = os.path.join(ROOT, 'docs', 'screenshots')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
BASE = os.environ.get('ATLAS_BASE', 'http://127.0.0.1:8765')
os.makedirs(SHOTS, exist_ok=True)


def shot(page, name):
    page.screenshot(path=os.path.join(SHOTS, name))


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox'])
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900}, device_scale_factor=1)
    page = ctx.new_page()
    page.goto(BASE, wait_until='networkidle', timeout=60000)
    page.wait_for_timeout(900)

    shot(page, 'hero.png')

    page.evaluate("document.querySelector('#workspace').scrollIntoView({behavior:'instant', block:'start'})")
    page.wait_for_timeout(450)
    shot(page, 'desktop-map.png')

    for view, name in (('graph', 'desktop-graph.png'), ('table', 'desktop-table.png'),
                       ('timeline', 'desktop-timeline.png'), ('insight', 'desktop-insight.png')):
        page.locator('.view-tab[data-view="%s"]' % view).click()
        page.wait_for_timeout(600)
        shot(page, name)

    # Dark theme, back on the map.
    page.locator('.view-tab[data-view="map"]').click()
    page.wait_for_timeout(400)
    page.locator('#themeToggle').click()
    page.wait_for_timeout(500)
    page.evaluate("document.querySelector('#workspace').scrollIntoView({behavior:'instant', block:'start'})")
    page.wait_for_timeout(350)
    shot(page, 'desktop-dark.png')
    page.locator('#themeToggle').click()
    page.wait_for_timeout(300)

    # Detail rail: open one entry so the README shows what a profile looks like.
    page.locator('.view-tab[data-view="table"]').click()
    page.wait_for_timeout(450)
    page.locator('tbody tr').first.click()
    page.wait_for_timeout(600)
    page.evaluate("document.querySelector('#workspace').scrollIntoView({behavior:'instant', block:'start'})")
    page.wait_for_timeout(350)
    shot(page, 'desktop-detail.png')

    ctx.close()

    mctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2,
                              is_mobile=True, has_touch=True)
    mpage = mctx.new_page()
    mpage.goto(BASE, wait_until='networkidle')
    mpage.wait_for_timeout(800)
    shot(mpage, 'mobile-hero.png')
    mpage.evaluate("document.querySelector('#canvas').scrollIntoView({behavior:'instant', block:'start'})")
    mpage.wait_for_timeout(500)
    shot(mpage, 'mobile-map.png')
    print('overflow:', mpage.evaluate('document.documentElement.scrollWidth - window.innerWidth'))
    browser.close()

for f in sorted(os.listdir(SHOTS)):
    print(f, os.path.getsize(os.path.join(SHOTS, f)) // 1024, 'KB')
