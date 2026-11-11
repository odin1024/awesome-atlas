"""Record a scripted product tour and encode it to MP4.

Run:  python scripts/demo-video.py
Out:  docs/demo/awesome-atlas-demo.mp4

The tour is driven, not filmed by hand: Chromium records the viewport while the
script scrolls, searches, drills into a category, opens a detail panel, switches
all five views, opens the command palette and toggles the theme. Captions are
injected into the page so the video explains itself without a voice track.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BASE = os.environ.get('ATLAS_BASE', 'http://127.0.0.1:8765')
OUT_DIR = os.path.join(ROOT, 'docs', 'demo')
OUT_MP4 = os.path.join(OUT_DIR, 'awesome-atlas-demo.mp4')
INTRO = os.path.join(ROOT, 'docs', 'social-preview.png')
CHROME = os.environ.get('CHROME_PATH') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'

W, H = 1440, 900
server = None


def ensure_server():
    global server
    try:
        urllib.request.urlopen(BASE, timeout=2).read(1)
        return
    except Exception:
        pass
    server = subprocess.Popen(
        [sys.executable, '-m', 'http.server', '8765', '--bind', '127.0.0.1'],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    for _ in range(40):
        time.sleep(0.25)
        try:
            urllib.request.urlopen(BASE, timeout=1).read(1)
            return
        except Exception:
            continue
    raise SystemExit('local server did not start')


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True)


def main():
    ensure_server()
    os.makedirs(OUT_DIR, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix='atlas-demo-')
    launch = {'headless': True, 'args': ['--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1']}
    if os.path.exists(CHROME):
        launch['executable_path'] = CHROME

    with sync_playwright() as p:
        browser = p.chromium.launch(**launch)
        ctx = browser.new_context(
            viewport={'width': W, 'height': H},
            device_scale_factor=1,
            record_video_dir=tmp,
            record_video_size={'width': W, 'height': H},
        )
        page = ctx.new_page()
        page.goto(BASE, wait_until='networkidle', timeout=60000)

        page.add_style_tag(content="""
          #demo-caption{position:fixed;left:50%;bottom:30px;transform:translateX(-50%);
            max-width:min(880px,84vw);padding:11px 20px;background:var(--paper);
            color:var(--ink);border:1px solid var(--line);box-shadow:0 10px 30px rgba(0,0,0,.10);
            font:500 15px/1.5 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;
            letter-spacing:.02em;opacity:0;transition:opacity .4s ease;z-index:99999;
            pointer-events:none;text-align:center}
        """)
        page.evaluate("""() => {
          const c = document.createElement('div');
          c.id = 'demo-caption';
          document.body.appendChild(c);
        }""")

        def caption(text, hold=2.6, fade=0.45):
            page.evaluate("(t)=>{const c=document.getElementById('demo-caption');c.textContent=t;c.style.opacity='1';}", text)
            page.wait_for_timeout(int(hold * 1000))
            page.evaluate("()=>{document.getElementById('demo-caption').style.opacity='0';}")
            page.wait_for_timeout(int(fade * 1000))

        def scroll_to(sel, offset=72, wait=950):
            page.evaluate(
                """(a)=>{const el=document.querySelector(a.sel);if(!el)return;
                   window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-a.offset,behavior:'smooth'});}""",
                {'sel': sel, 'offset': offset},
            )
            page.wait_for_timeout(wait)

        def scroll_top(wait=950, smooth=True):
            page.evaluate(
                "(s)=>window.scrollTo({top:0,behavior:s?'smooth':'auto'})", smooth)
            page.wait_for_timeout(wait)

        # Every scene starts from the same state. Without this the search term
        # from scene 03 and the category from scene 05 leaked into the graph,
        # the table and the insight view — each of them then showed a single row
        # and read as if the product had no data.
        def reset(wait=520):
            page.evaluate("()=>{const b=document.querySelector('#resetFilters');if(b)b.click();}")
            page.wait_for_timeout(wait)

        def close_detail(wait=420):
            if page.locator('.detail-close').count():
                page.locator('.detail-close').click()
                page.wait_for_timeout(wait)

        def hover_el(sel, idx=0, steps=16, wait=380):
            box = page.locator(sel).nth(idx).bounding_box()
            if not box:
                return
            page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2, steps=steps)
            page.wait_for_timeout(wait)

        def hover_sweep(sel, n=5, gap=420):
            total = page.locator(sel).count()
            for i in range(min(n, total)):
                hover_el(sel, i, wait=gap)

        # --- 01 hero -------------------------------------------------------
        page.wait_for_timeout(900)
        caption('678 份精选清单，27 个分类 —— 原入口是一篇 866 行的英文 README', 3.0)
        page.wait_for_timeout(400)

        # --- 02 insights ---------------------------------------------------
        scroll_to('#insights', 60)
        caption('四条结论由当前快照实时计算，点击可直接跳到对应条目', 3.0)
        page.wait_for_timeout(400)

        # --- 03 search -----------------------------------------------------
        scroll_top()
        page.locator('#searchInput').click()
        page.wait_for_timeout(300)
        page.keyboard.type('前端', delay=180)
        page.wait_for_timeout(900)
        caption('中文检索：分类、描述、名称与仓库名一起匹配', 2.6)
        page.evaluate("()=>document.querySelector('#searchClear').click()")
        page.wait_for_timeout(600)

        # --- 04 map --------------------------------------------------------
        scroll_to('#workspace', 8)
        caption('分类地图：面积 = 清单数，颜色 = 平均健康分', 2.6)
        hover_sweep('.tile', n=5, gap=380)

        # drill into one category
        page.locator('.tile').nth(3).click()
        page.wait_for_timeout(900)
        caption('点瓦片下钻：从分类层进入该分类的清单层', 2.4)
        hover_sweep('.tile', n=4, gap=330)

        # open detail
        page.locator('.tile').nth(1).click()
        page.wait_for_timeout(900)
        caption('详情面板：仓库指标、健康分构成与上下游关系', 3.0)
        close_detail()
        reset()

        # --- 05 graph ------------------------------------------------------
        page.locator('.view-tab[data-view="graph"]').click()
        page.wait_for_timeout(900)
        scroll_to('#canvas', 60, 700)
        caption('关系图谱：中心是源索引，外圈 27 个分类，圆点大小 = Star', 2.8)
        hover_sweep('.graph-node', n=4, gap=420)
        # SVG <g> nodes near the viewBox edge never satisfy Playwright's
        # actionability checks, so fire the same click the handler listens for.
        clicked = page.evaluate("""() => {
          const ns = document.querySelectorAll('.graph-node[data-action="filter-cat"]');
          if (ns.length < 3) return 0;
          ns[2].dispatchEvent(new MouseEvent('click', {bubbles: true}));
          return ns.length;
        }""")
        if clicked:
            page.wait_for_timeout(900)
            caption('点分类节点即过滤，地图 / 榜单同步收窄', 2.4)
        reset()

        # --- 06 table ------------------------------------------------------
        page.locator('.view-tab[data-view="table"]').click()
        page.wait_for_timeout(900)
        caption('检索榜单：7 种排序、分页、收藏与一键导出', 2.6)
        hover_sweep('tbody tr', n=3, gap=360)
        if page.locator('tbody tr').count():
            page.locator('tbody tr').first.click()
            page.wait_for_timeout(800)
            caption('任意一行都能展开同一套详情', 2.2)
            close_detail(400)

        # --- 07 palette ----------------------------------------------------
        page.keyboard.press('Control+k')
        page.wait_for_timeout(600)
        page.keyboard.type('安全', delay=150)
        page.wait_for_timeout(900)
        caption('Ctrl+K 命令面板：搜索清单、切视图、换分类', 2.6)
        page.keyboard.press('Escape')
        page.wait_for_timeout(500)

        # --- 08 timeline ---------------------------------------------------
        page.locator('.view-tab[data-view="timeline"]').click()
        page.wait_for_timeout(900)
        caption('生态时间轴：上游 24 次真实修订，9 增 27 减', 2.8)
        hover_sweep('.commit-item', n=3, gap=380)

        # --- 09 insight ----------------------------------------------------
        page.locator('.view-tab[data-view="insight"]').click()
        page.wait_for_timeout(900)
        caption('数据洞察：分类权重、健康分分布、语言构成与停滞清单', 2.8)
        page.wait_for_timeout(300)

        # --- 10 dark -------------------------------------------------------
        page.locator('#themeToggle').click()
        page.wait_for_timeout(700)
        caption('深色主题：文字对比度仍全部高于 4.5:1', 2.6)
        page.locator('#themeToggle').click()
        page.wait_for_timeout(500)

        # --- 11 close ------------------------------------------------------
        page.locator('.view-tab[data-view="map"]').click()
        page.wait_for_timeout(900)
        reset(600)
        page.wait_for_timeout(900)
        # Jumping instead of smooth-scrolling here: a composited smooth scroll
        # made headless Chromium drop the treemap for half a second, which read
        # as a blank canvas in the closing frames.
        scroll_top(700, smooth=False)
        caption('odin1024.github.io/awesome-atlas · 无需登录，打开即用', 3.2)

        video = page.video
        ctx.close()
        browser.close()
        raw = video.path()
        shutil.copyfile(raw, os.path.join(tmp, 'raw.webm'))

    raw_webm = os.path.join(tmp, 'raw.webm')
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', raw_webm],
        capture_output=True, text=True, check=True,
    )
    dur = float(probe.stdout.strip())
    fade_out = max(0.5, dur - 1.1)

    args = ['-loop', '1', '-t', '2.6', '-i', INTRO, '-i', raw_webm, '-filter_complex',
            # The social card carries its own 10px masthead rule (20px at the 2x
            # render). Cropping it off lets the card sit on the same paper as the
            # padding, instead of showing a floating black bar above the frame.
            ('[0:v]crop=iw:ih-20:0:20,scale=%d:%d:force_original_aspect_ratio=decrease,'
             'pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=0xfaf9f5,setsar=1,fps=30,'
             'fade=t=in:st=0:d=0.5,fade=t=out:st=2.1:d=0.5[v0];'
             '[1:v]scale=%d:%d,setsar=1,fps=30,fade=t=in:st=0:d=0.4,fade=t=out:st=%.2f:d=0.9[v1];'
             '[v0][v1]concat=n=2:v=1:a=0[out]') % (W, H, W, H, W, H, fade_out),
            '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20',
            '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT_MP4]
    ffmpeg(*args)
    shutil.rmtree(tmp, ignore_errors=True)
    size = os.path.getsize(OUT_MP4) / 1024 / 1024
    print(json.dumps({'out': OUT_MP4, 'duration_s': round(dur + 2.6, 1), 'size_mb': round(size, 2)}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    finally:
        if server:
            server.terminate()


