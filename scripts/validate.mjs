#!/usr/bin/env node
/**
 * Multi-dimensional cross-validation of the generated site.
 * Every check re-derives its expectation from an independent source: the raw
 * README text, filesystem layout, translation file, or the generated bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
const raw = read('source/readme.md');
const lines = raw.split(/\r?\n/);
const catalog = JSON.parse(read('data/catalog.json'));
const upstream = JSON.parse(read('data/upstream.json'));
const history = JSON.parse(read('data/history.json'));
const i18n = JSON.parse(read('data/i18n.json'));
const html = read('index.html');
const css = read('assets/styles.css');
const js = read('assets/app.js');
const bundle = read('data/catalog.js');

const checks = [];
const add = (group, name, ok, detail) => checks.push({ group, name, ok: Boolean(ok), detail: String(detail) });

/* --- 1. source integrity --- */
const sha = crypto.createHash('sha256').update(raw).digest('hex');
add('来源', 'README sha256 与 catalog 记录一致', sha === catalog.source.sha256, `${sha.slice(0, 16)}…`);
add('来源', 'README 行数与字节数一致', lines.length - 1 === catalog.source.lineCount && Buffer.byteLength(raw) === catalog.source.byteCount, `${lines.length - 1} 行 / ${Buffer.byteLength(raw)} 字节`);

/* --- 2. independent re-count of raw markdown --- */
const rawH2 = lines.filter((l) => /^##\s+/.test(l)).length;
const rawList = lines.filter((l) => /^[\t ]*[-*+]\s+/.test(l)).length;
const rawLinked = lines.filter((l) => /^[\t ]*[-*+]\s+\[[^\]]+\]\([^)]+\)/.test(l)).length;
const cStart = lines.findIndex((l) => /^##\s+Contents/.test(l));
const cEnd = lines.findIndex((l, i) => i > cStart && /^##\s+/.test(l));
const anchors = lines.slice(cStart + 1, cEnd).filter((l) => /^[-*+]\s+\[[^\]]+\]\(#[^)]+\)/.test(l)).length;
add('解析', 'H2 章节数一致', rawH2 === catalog.stats.raw.h2Count && rawH2 === catalog.h2Headings.length, `${rawH2} 个 H2`);
add('解析', '列表行 − 目录锚点 = 条目数', rawList - anchors === catalog.stats.items, `${rawList} − ${anchors} = ${rawList - anchors}`);
add('解析', '带链接行 − 目录锚点 = 有 URL 条目', rawLinked - anchors === catalog.stats.withUrl, `${rawLinked} − ${anchors} = ${rawLinked - anchors}`);
add('解析', '分类数 = H2 − 目录', catalog.categories.length === rawH2 - 1, `${catalog.categories.length} 个分类`);
add('解析', '各分类计数之和 = 总条目数', catalog.categories.reduce((s, c) => s + c.itemCount, 0) === catalog.stats.items, `${catalog.stats.items} 条`);
add('解析', '解析告警为 0', catalog.warnings.length === 0, `${catalog.warnings.length} 条告警`);
const reserved = catalog.items.filter((it) => it.repo && /^(topics|orgs|sponsors|collections|features|settings|marketplace)\//.test(it.repo));
add('解析', 'GitHub 站点保留路径未被误判为仓库', reserved.length === 0, `${reserved.length} 条误判`);

/* --- 3. structural integrity --- */
let badLine = 0, badParent = 0, badChild = 0, badUrl = 0, badId = 0;
const ids = new Set();
const byId = new Map(catalog.items.map((it) => [it.id, it]));
for (const it of catalog.items) {
  if (ids.has(it.id)) badId += 1;
  ids.add(it.id);
  const src = lines[it.sourceLine - 1] || '';
  if (!/^[\t ]*[-*+]\s+/.test(src)) badLine += 1;
  if (it.url) {
    try { const u = new URL(it.url); if (!/^https?:$/.test(u.protocol)) badUrl += 1; } catch (_) { badUrl += 1; }
  }
  if (it.level === 1) {
    const p = byId.get(it.parentId);
    if (!p || p.level !== 0 || p.categoryId !== it.categoryId || !p.children.includes(it.id)) badParent += 1;
  }
  for (const cid of it.children) {
    const c = byId.get(cid);
    if (!c || c.parentId !== it.id) badChild += 1;
  }
}
add('结构', '每条记录都能回溯到源 README 的列表行', badLine === 0, `${badLine} 条异常`);
add('结构', '子条目的父级与反向引用互相一致', badParent === 0 && badChild === 0, `父级异常 ${badParent} / 子级异常 ${badChild}`);
add('结构', '所有 URL 可解析且为 http(s)', badUrl === 0, `${badUrl} 条异常`);
add('结构', '条目 ID 全局唯一', badId === 0 && ids.size === catalog.stats.items, `${ids.size} 个唯一 ID`);
add('结构', '分类 ID 与目录锚点一一对应', anchors === catalog.categories.length, `${anchors} 个目录锚点`);

/* --- 4. full-coverage metrics integrity --- */
let badMetric = 0;
const repos = catalog.items.filter((it) => it.repo);
const enriched = repos.filter((it) => it.metrics);
for (const it of enriched) {
  const m = it.metrics;
  if (!(m.health >= 0 && m.health <= 100) || !(m.stars >= 0) || !(m.forks >= 0) || Number.isNaN(Date.parse(m.pushedAt))) badMetric += 1;
  if (m.parts && ['freshness', 'popularity', 'activity'].some((k) => !(m.parts[k] >= 0 && m.parts[k] <= 100))) badMetric += 1;
}
add('指标', '健康分 / star / 日期均在合法范围', badMetric === 0, `${enriched.length} 条指标，异常 ${badMetric}`);
add('指标', '全量覆盖：每个 GitHub 仓库都有真实指标', enriched.length === repos.length && catalog.enrichment.coverage.coveragePct === 100, `${enriched.length}/${repos.length}（${catalog.enrichment.coverage.coveragePct}%）`);
add('指标', '覆盖率可从条目独立重算', Math.round((enriched.length / repos.length) * 1000) / 10 === catalog.enrichment.coverage.coveragePct, `${catalog.enrichment.coverage.coveragePct}%`);
add('指标', 'star 总量可由明细独立重算', catalog.enrichment.coverage.totalStarsSampled === enriched.reduce((s, it) => s + it.metrics.stars, 0), `${catalog.enrichment.coverage.totalStarsSampled.toLocaleString('en-US')} star`);
add('指标', '授权抓取未产生解析错误', catalog.enrichment.method.includes('GraphQL') && (JSON.parse(read('data/enrich-full-report.json')).errors || []).length === 0, 'GraphQL 批量核验，0 错误');
add('指标', '上游提交按时间倒序且 sha 有效', upstream.commits.every((c, i, a) => i === 0 || Date.parse(a[i - 1].date) >= Date.parse(c.date)) && upstream.commits.every((c) => /^[0-9a-f]{7}$/.test(c.sha || '')), `${upstream.commits.length} 条提交`);

/* --- 5. Chinese localisation --- */
const needDesc = new Set(catalog.items.filter((it) => it.description).map((it) => it.id));
const gotDesc = new Set(Object.keys(i18n.descriptions));
const noDesc = catalog.items.filter((it) => !it.description);
const missingDesc = [...needDesc].filter((id) => !gotDesc.has(id));
const extraDesc = [...gotDesc].filter((id) => !needDesc.has(id));
const emptyDesc = [...gotDesc].filter((id) => !String(i18n.descriptions[id]).trim());
const unhinted = noDesc.filter((it) => !i18n.hints[it.name]);
const missingCats = catalog.categories.filter((c) => !i18n.categories[c.id] || !i18n.categories[c.id].zh || !i18n.categories[c.id].note);
add('中文', '466 条英文描述全部有中文译文', needDesc.size === gotDesc.size && missingDesc.length === 0 && extraDesc.length === 0 && emptyDesc.length === 0, `${gotDesc.size}/${needDesc.size}，缺 ${missingDesc.length}，多 ${extraDesc.length}，空 ${emptyDesc.length}`);
add('中文', '212 条无描述条目全部有中文提示', unhinted.length === 0, `${noDesc.length} 条无描述，未覆盖 ${unhinted.length}`);
add('中文', '27 个分类均有中文名与释义', missingCats.length === 0, `${Object.keys(i18n.categories).length} 个分类`);
add('中文', '界面默认语言为中文', /<html lang="zh-CN"/.test(html) && /data-lang="zh" class="is-on"/.test(html), 'lang=zh-CN / 中文按钮默认选中');
add('中文', '中英两态切换与双方字典齐备', /data-lang="zh"/.test(html) && /data-lang="en"/.test(html) && !/data-lang="both"/.test(html) && /const UI = \{[\s\S]*?zh: \{[\s\S]*?en: \{/.test(js), '中文 / EN');
add('中文', '语言状态回退不会落入无效值', /!\['zh', 'en'\]\.includes\(lang\)\) lang = 'zh'/.test(js) && /\['zh', 'en'\]\.includes\(P\.get\('lang'\)\)/.test(js), 'localStorage 与 URL 均校验为 zh | en');
add('中文', '中文检索索引包含译名与提示', /__search/.test(js) && /I18N\.descriptions/.test(js) && /I18N\.hints/.test(js), '名称 + 译文 + 提示 + 分类均入索引');
add('中文', '国内友好：万位计数与中文日期', /fmtAbbr/.test(js) && /' 万'/.test(js) && /cnDate/.test(js), '万 / 亿、年月日');

/* --- 6. historical diff integrity --- */
const snaps = history.snapshots || [];
const series = history.series || [];
const sumAdd = snaps.reduce((s, x) => s + x.added.length, 0);
const sumRemove = snaps.reduce((s, x) => s + x.removed.length, 0);
const sumRelink = snaps.reduce((s, x) => s + (x.relinked || []).length, 0);
const monotone = series.every((p, i) => i === 0 || Date.parse(p.date) >= Date.parse(series[i - 1].date));
const sameNamePair = snaps.some((s) => s.added.some((a) => (s.removed || []).some((r) => r.name === a.name)));
add('历史', '历史版本数量与解析跨度一致', snaps.length === history.summary.revisions && snaps.length >= 20, `${snaps.length} 个版本 / ${history.summary.spanDays} 天`);
add('历史', '收录量曲线按时间单调递增排列', monotone && series.length === snaps.length, `${series.length} 个数据点`);
add('历史', '增删计数与快照明细可独立重算', sumAdd === history.summary.additions && sumRemove === history.summary.removals && sumRelink === history.summary.relinks, `+${sumAdd} / −${sumRemove} / ↗${sumRelink}`);
add('历史', '换链接不再被误报为「删了又加」', !sameNamePair && sumRelink > 0, `${sumRelink} 次链接更新已单列`);
add('历史', '净变化与首末版本总数一致', series.length > 1 && series[series.length - 1].total - series[0].total === history.summary.netChange, `${history.summary.firstTotal} → ${history.summary.lastTotal}`);
add('历史', '每条提交都有中文说明', snaps.every((s) => s.messageZh && s.messageZh.length > 1), `${snaps.length} 条`);

/* --- 7. bundle / asset integrity --- */
const globals = ['__ATLAS_DATA__', '__ATLAS_UPSTREAM__', '__ATLAS_HISTORY__', '__ATLAS_I18N__'];
add('产物', '数据包含 4 组独立数据段', globals.every((g) => bundle.includes('window.' + g + ' = ')), globals.join(' / '));
const marker = 'window.__ATLAS_DATA__ = ';
const from = bundle.indexOf(marker);
const to = bundle.indexOf(';\nwindow.__ATLAS_UPSTREAM__', from);
let bundleOk = false, bundleDetail = '未找到数据段';
if (from >= 0 && to > from) {
  try {
    const parsed = JSON.parse(bundle.slice(from + marker.length, to));
    bundleOk = parsed.stats.items === catalog.stats.items && parsed.items.length === catalog.items.length && parsed.items.filter((i) => i.metrics).length === enriched.length;
    bundleDetail = `${parsed.items.length} 条 / ${parsed.items.filter((i) => i.metrics).length} 条已验证，与 catalog.json 一致`;
  } catch (e) { bundleDetail = String(e.message); }
}
add('产物', 'catalog.js 与 catalog.json 数据一致', bundleOk, bundleDetail);
const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1].replace(/^\.\//, ''));
const missing = refs.filter((r) => !exists(r));
add('产物', 'index.html 引用的本地资源全部存在', missing.length === 0, `${refs.length} 个引用，缺失 ${missing.length}`);
/* Metadata links (canonical, og:image) are allowed to be absolute; runtime
   dependencies are not. The check has to name what it forbids, or a rel=canonical
   tag would read as an external stylesheet. */
add('产物', '无外部运行时依赖', !/<script[^>]+src="https?:/.test(html) && !/<link[^>]+rel="stylesheet"[^>]+href="https?:/.test(html), '脚本与样式均本地加载');
add('产物', '页面无占位文本与调试残留', !/TODO|FIXME|lorem ipsum|console\.log\(/i.test(html + js + css), '无 TODO / console.log');
add('产物', '五个视图与命令面板齐备', (html.match(/data-view="(map|graph|table|timeline|insight)"/g) || []).length === 5 && html.includes('id="cmdk"') && html.includes('id="mobileTabs"'), '地图 / 图谱 / 榜单 / 时间轴 / 洞察');
add('产物', '数据包体积适合静态托管', fs.statSync(path.join(ROOT, 'data/catalog.js')).size < 1024 * 1024, `${(fs.statSync(path.join(ROOT, 'data/catalog.js')).size / 1024).toFixed(0)} KB`);
add('产物', '部署所需文件齐备', ['.nojekyll', '.github/workflows/validate.yml', 'README.md', 'scripts/deploy-pages.mjs'].every(exists), '.nojekyll / CI 校验 / README / REST 部署脚本');
add('产物', 'Pages 分支发布与 CI 不冲突', !fs.existsSync(path.join(ROOT, '.github/workflows/pages.yml')) && /Deploy from a branch|分支发布/.test(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')), '采用 main/root 分支发布，CI 只做数据校验');

/* --- 7b. page chrome, navigation and scroll ownership --- */
const headerHtml = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];
const footerHtml = (html.match(/<footer[\s\S]*?<\/footer>/) || [''])[0];
add('界面', '品牌副标题不再出现「中文版」', /data-ui="brandSub"/.test(html) && !/中文版/.test(html + js) && /brandSub: 'AWESOME ATLAS'/.test(js), 'AWESOME ATLAS');
add('界面', '上游仓库入口已移出顶栏、落在页脚', !/sindresorhus/.test(headerHtml) && /id="upstreamLink"/.test(footerHtml) && footerHtml.indexOf('id="upstreamLink"') > 0, '顶栏 0 个外链，页脚 1 个来源入口');
add('界面', '刷新页面不恢复旧滚动位置', /'scrollRestoration' in history/.test(html) && /scrollRestoration = 'manual'/.test(html) && /if \(!location\.hash\) window\.scrollTo\(0, 0\)/.test(js), 'head 内 manual + 初始化回顶');
add('界面', '回到顶部按钮有真实事件绑定', /id="backToTop"/.test(footerHtml) && /\$\('#backToTop'\)\.addEventListener\('click'/.test(js), '页脚按钮 → scrollTo(0)');
add('界面', '语言切换仅保留中文与 EN 两态', (html.match(/data-lang="/g) || []).length === 2, `${(html.match(/data-lang="/g) || []).length} 个语言按钮`);

/* The brand mark is a plate of tiles, not a monogram. A letter A inside a square
   is the default placeholder every project starts with; this asserts the mark
   actually carries the product's own geometry, and that the favicon is cut from
   the same plate rather than drawn separately. */
const brandBlock = (html.match(/<span class="brand-mark"[\s\S]*?<\/span>/) || [''])[0];
const favicon = (html.match(/<link rel="icon" href="([^"]+)"/) || ['', ''])[1];
add('界面', '品牌标记为图幅式而非字母 A', /class="mark-tile"/.test(brandBlock) && /fill="var\(--accent\)"/.test(brandBlock) && !/M7 23/.test(brandBlock) && (brandBlock.match(/<rect/g) || []).length === 2, '图幅 + 三格区划 + 一格实色');
add('界面', 'favicon 与品牌标记同源', /%23a82d22/.test(favicon) && /M17\.2 3\.2v25\.6/.test(favicon) && !/M7 23/.test(favicon), '同一套坐标，仅按 16px 加粗描边');
add('界面', '首屏副标题两行在句末断行', /漏了什么。<br class="wrap-only">译成中文/.test(html) && /\.hero-sub br\.wrap-only \{ display: none; \}/.test(css), '桌面显式断点，600px 以下交还浏览器');
add('界面', '首屏文案在静态 HTML 与运行时逐字一致', (() => {
  const a = (html.match(/id="heroSub">([\s\S]*?)<\/p>/) || ['', ''])[1].trim();
  const b = (js.match(/heroSub: '([^']*)'/) || ['', ''])[1].trim();
  return a.length > 40 && a === b;
})(), '静态首屏不会被脚本改写，避免闪一版旧文案');
add('界面', '文案里的数字与数据一致', /466 条中文译述/.test(js) && /866 行的英文 README/.test(js) && Object.keys(i18n.descriptions).length === 466 && lines.length - 1 === 866, `466 条译述 / 866 行源文件`);

/* --- 7c. first screen, share card and README as the project home --- */
const readme = read('README.md');
const readmeHead = readme.split('\n').slice(0, 16).join('\n');
const shotRefs = [...readme.matchAll(/docs\/screenshots\/([\w-]+\.png)/g)].map((m) => `docs/screenshots/${m[1]}`);
const missingShots = [...new Set(shotRefs)].filter((p) => !exists(p));
add('界面', '首屏地图预览板由真实数据渲染', /id="heroPlateMap"/.test(html) && /function renderHeroPlate/.test(js) && /const cells = treemap\(entries/.test(js), '预览板复用同一套 treemap 与色阶');
add('界面', '首屏与下方版块共用同一条栅格', /\.hero-inner \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 356px/.test(css) && !/\.hero-inner \{ max-width: 1080px/.test(css), 'hero 双栏，左边缘与指标带对齐');
add('界面', '社交卡片图已生成并被 og:image 引用', exists('docs/banner.png') && /og:image" content="https:\/\/odin1024\.github\.io\/awesome-atlas\/docs\/banner\.png"/.test(html) && /docs\/banner\.png/.test(readmeHead), `${exists('docs/banner.png') ? Math.round(fs.statSync(path.join(ROOT, 'docs/banner.png')).size / 1024) + ' KB' : '缺文件'}`);
add('界面', 'README 顶部给出线上地址与横幅', /odin1024\.github\.io\/awesome-atlas/.test(readmeHead) && /docs\/banner\.png/.test(readmeHead), '项目主页 = 在线入口 + 横幅 + 截图');
add('界面', 'README 引用的截图全部存在', shotRefs.length >= 6 && missingShots.length === 0, `${new Set(shotRefs).size} 张，缺 ${missingShots.length}`);
add('界面', '画布脚注有独立布局位，不再被裁剪', /\.canvas-fill \{ position: absolute; inset: 16px/.test(css) && /id="canvasFoot"/.test(js) && /\.canvas-foot \{/.test(css), '.canvas-fill / .canvas-main / .canvas-foot 三段式');
add('界面', '图例色阶由 RAMP 生成而非硬编码', /function rampGradient/.test(js) && /scaleEl\.style\.background = rampGradient\(\)/.test(js) && !/#cdb3ac/.test(css), '一处色阶，图例与瓦片同源');

/* --- 8. design system (UI/UX Pro Max checklist, mechanically verified) --- */
function themeTokens(name) {
  const m = css.match(new RegExp(`:root\\[data-theme="${name}"\\]\\s*\\{([\\s\\S]*?)\\n\\}`));
  const out = {};
  if (m) for (const [, k, v] of m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)) out[k] = v.trim();
  return out;
}
const hex2rgb = (h) => {
  const s = String(h).replace('#', '').trim();
  const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
};
const relLum = (rgb) => {
  const f = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (a, b) => {
  const [hi, lo] = [relLum(hex2rgb(a)), relLum(hex2rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

for (const theme of ['light', 'dark']) {
  const t = themeTokens(theme);
  const pairs = [
    ['正文 ink/paper', t.ink, t.paper],
    ['次级 ink-2/paper', t['ink-2'], t.paper],
    ['三级 ink-3/paper', t['ink-3'], t.paper],
    ['强调 accent/paper', t.accent, t.paper],
    ['反白 accent-ink/accent', t['accent-ink'], t.accent],
  ].filter(([, a, b]) => a && b && a.startsWith('#') && b.startsWith('#'));
  const worst = pairs.map(([n, a, b]) => [n, contrast(a, b)]).sort((x, y) => x[1] - y[1])[0];
  const fails = pairs.filter(([, a, b]) => contrast(a, b) < 4.5).map(([n]) => n);
  add('设计', `${theme === 'light' ? '浅色' : '深色'}主题文字对比度 ≥ 4.5:1`, pairs.length >= 5 && fails.length === 0,
    fails.length ? `不达标：${fails.join('、')}` : `最低 ${worst[1].toFixed(2)}:1（${worst[0]}）`);
}

const hue = (h) => { const [r, g, b] = hex2rgb(h).map((v) => v / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return 0; return ((mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d) * 60 + 360) % 360; };
const lightT = themeTokens('light'), darkT = themeTokens('dark');

/* --- 7d. the health ramp has to carry a real range, and keep text legible ---
   The map once painted 27 tiles in one salmon because the ramp itself spanned
   ΔE 8 from end to end; no amount of domain tuning could fix that. These checks
   re-derive the numbers from the RAMP literals, so the palette cannot quietly
   collapse back into a single tone. */
const rampOf = (name) => {
  const m = js.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  return m ? [...m[1].matchAll(/\[(\d+),\s*(\d+),\s*(\d+)\]/g)].map(([, r, g, b]) => [+r, +g, +b]) : [];
};
const rgb2lab = (rgb) => {
  const f = (v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = rgb.map(f);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const [fx, fy, fz] = [t(X), t(Y), t(Z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const deltaE = (a, b) => {
  const [x, y] = [rgb2lab(a), rgb2lab(b)];
  return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]) ** 2, 0));
};
const contrastRgb = (a, b) => {
  const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const lightRamp = rampOf('RAMP_LIGHT');
const darkRamp = rampOf('RAMP_DARK');
add('设计', '数据色阶两端有真实落差', lightRamp.length === 5 && darkRamp.length === 5 && deltaE(lightRamp[0], lightRamp[lightRamp.length - 1]) >= 45 && deltaE(darkRamp[0], darkRamp[darkRamp.length - 1]) >= 45,
  `浅色 ΔE ${deltaE(lightRamp[0], lightRamp[4]).toFixed(0)} / 深色 ΔE ${deltaE(darkRamp[0], darkRamp[4]).toFixed(0)}（旧色阶仅 8）`);
add('设计', '最深瓦片上的文字仍过 4.5:1', lightRamp.every((c) => contrastRgb(c, hex2rgb(themeTokens('light').ink)) >= 4.5) && darkRamp.every((c) => contrastRgb(c, hex2rgb(themeTokens('dark').ink)) >= 4.5),
  `浅色最低 ${Math.min(...lightRamp.map((c) => contrastRgb(c, hex2rgb(themeTokens('light').ink)))).toFixed(2)}:1 / 深色最低 ${Math.min(...darkRamp.map((c) => contrastRgb(c, hex2rgb(themeTokens('dark').ink)))).toFixed(2)}:1`);
add('设计', '最浅瓦片不与页面底色糊在一起', deltaE(lightRamp[0], hex2rgb(themeTokens('light').paper)) >= 8 && deltaE(darkRamp[0], hex2rgb(themeTokens('dark').surface)) >= 8,
  `浅色 ΔE ${deltaE(lightRamp[0], hex2rgb(themeTokens('light').ink)).toFixed(1)} / 深色 ΔE ${deltaE(darkRamp[0], hex2rgb(themeTokens('dark').surface)).toFixed(1)}`);
add('界面', '地图色阶按当前视图的数值定标', /function rampDomain\(/.test(js) && /const dom = rampDomain\(entries\.map/.test(js) && /healthColor\(e\.health, dom\)/.test(js) && /scaleHtml\(dom\)/.test(js) && /mapScale: '健康分 · 相对'/.test(js),
  'rampDomain + healthColor(value, domain)，图例打印同一区间');
add('界面', '小样本不做百分位截尾', /vs\.length >= 40 \? pick\(0\.03\)/.test(js), '27 个分类用真实极值，图例区间覆盖全部瓦片');
const hueGap = Math.abs(hue(lightT.accent) - hue(darkT.accent));
add('设计', '单一强调色相（浅/深色同一色相）', Math.min(hueGap, 360 - hueGap) < 22, `浅色 ${Math.round(hue(lightT.accent))}° / 深色 ${Math.round(hue(darkT.accent))}°`);
add('设计', '无渐变文字与玻璃拟态', !/background-clip:\s*text/.test(css) && !/backdrop-filter/.test(css), '无 gradient text / backdrop-filter');
add('设计', '圆角系统为 0（Swiss 网格）', /--r:\s*0px/.test(css) && !/border-radius:\s*(?:[1-9]\d*(?:px|rem))/.test(css), '仅进度条与开关保留功能性圆角');
add('设计', '基础字号与触控目标达标', /body\s*\{[^}]*font-size:\s*1[5-9]px/.test(css) && /min-height:\s*44px/.test(css), '正文 15px / 移动端标签 44px');
add('设计', '无 emoji 充当图标', !/[\u{1F000}-\u{1FAFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u.test(html + js), '图标均为 SVG 或编号');
add('设计', '键盘焦点与减少动效均已覆盖', /:focus-visible/.test(css) && /prefers-reduced-motion/.test(css), 'focus-visible + reduced-motion');
add('设计', '深色主题不依赖浅色瓦片', /RAMP_DARK/.test(js) && /isDark\(\)/.test(js), '数据色阶随主题反转');

/* --- README layer: two language editions that must not drift apart --- */
const readmeZh = read('README.md');
const readmeEn = read('README.en.md');
const h2count = (md) => (md.match(/^## .+$/gm) || []).length;
const pngSize = (rel) => {
  const b = fs.readFileSync(path.join(ROOT, rel));
  if (b.slice(1, 4).toString() !== 'PNG') return { w: 0, h: 0 };
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};
const localRefs = (md) => [...md.matchAll(/(?:src="|!\[[^\]]*\]\(|\[[^\]]*\]\()([^")\s]+)/g)]
  .map((m) => m[1])
  .filter((p) => !/^(?:https?:|#|mailto:)/.test(p));

add('文档', '中英两版 README 相互链接', /README\.en\.md/.test(readmeZh) && /(?:\]\(|href=")README\.md/.test(readmeEn),
  '中文版指向 README.en.md，英文版指回 README.md');
add('文档', '两版章节数一致', h2count(readmeZh) === h2count(readmeEn) && h2count(readmeZh) >= 10,
  `${h2count(readmeZh)} / ${h2count(readmeEn)} 个 H2`);
const keyNumbers = ['27', '678', '673', '466', '212', '224', '24', '597', '81', '5,979,356'];
const numberGaps = keyNumbers.filter((n) => !readmeZh.includes(n) || !readmeEn.includes(n));
add('文档', '两版共享同一组关键数字', numberGaps.length === 0,
  numberGaps.length ? `缺 ${numberGaps.join('、')}` : `${keyNumbers.length} 个数字两版都在`);
const dangling = [...new Set([...localRefs(readmeZh), ...localRefs(readmeEn)])].filter((p) => !exists(p));
add('文档', '两版引用的本地文件全部存在', dangling.length === 0,
  dangling.length ? `缺失 ${dangling.join('、')}` : `${new Set([...localRefs(readmeZh), ...localRefs(readmeEn)]).size} 个引用均可解析`);
const startsWithBanner = (md) => /^<p align="center"><img src="docs\/banner(?:-en)?\.png" alt="[^"]{10,}" width="100%"><\/p>/.test(md.trimStart());
add('文档', '首行即横幅且 alt 文本可读', startsWithBanner(readmeZh) && startsWithBanner(readmeEn),
  '横幅是第一行，alt 描述图形而非文件名');
const zhBanner = pngSize('docs/banner.png');
const enBanner = pngSize('docs/banner-en.png');
const social = pngSize('docs/social-preview.png');
add('文档', '横幅与社交卡尺寸各自正确',
  zhBanner.w === 3200 && zhBanner.h === 920 && enBanner.w === 3200 && enBanner.h === 920 && social.w === 2400 && social.h === 1260,
  `中文 ${zhBanner.w}×${zhBanner.h} / 英文 ${enBanner.w}×${enBanner.h} / 社交卡 ${social.w}×${social.h}（均为 2x）`);
const badgeNames = ['index', 'verified', 'tests', 'dependency'];
const badgeOk = ['zh', 'en'].every((lang) => badgeNames.every((n) => {
  const s = pngSize(`docs/badges/${lang}/${n}.png`);
  return s.h === 60 && s.w > 300 && s.w < 700;
}));
add('文档', '徽章为自托管 PNG 且同高', badgeOk, '8 枚，逻辑高 30px（2x 输出 60px）');
add('文档', 'README 不引用第三方图片服务', !/shields\.io|badgen\.net|img\.shields/.test(readmeZh + readmeEn) && !/src="https?:/.test(readmeZh + readmeEn),
  '徽章与横幅全部随仓库分发，不受第三方限流或墙影响');

/* These two need the final check count, so they come last and count themselves. */
const totalChecks = checks.length + 2;
const browserPassed = exists('data/browser-check.json') ? JSON.parse(read('data/browser-check.json')).passed : 0;
add('文档', '文案里的断言数等于实测', readmeZh.includes(`${totalChecks} / ${totalChecks}`) && readmeEn.includes(`${totalChecks} / ${totalChecks}`),
  `README 必须写 ${totalChecks} / ${totalChecks}`);
add('文档', '徽章文案与实测同步', read('docs/badges-zh.html').includes(`${totalChecks} + ${browserPassed}`) && read('docs/badges-en.html').includes(`${totalChecks} + ${browserPassed}`),
  `徽章应显示 ${totalChecks} + ${browserPassed}，否则重跑 npm run banner`);

const passed = checks.filter((c) => c.ok).length;
const report = {
  validatedAt: new Date().toISOString(),
  passed, total: checks.length, allPassed: passed === checks.length,
  source: { sha256: sha, lines: lines.length - 1, bytes: Buffer.byteLength(raw) },
  coverage: catalog.enrichment.coverage,
  localisation: { descriptions: gotDesc.size, hints: Object.keys(i18n.hints).length, categories: Object.keys(i18n.categories).length },
  history: history.summary,
  checks,
};
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data/validation.json'), JSON.stringify(report, null, 2));

/* The browser suite appends its own section to this file. Re-running the data
   check used to overwrite the whole report and silently delete that section, so
   the two scripts had an undocumented order dependency. Keep the tail. */
const reportPath = path.join(ROOT, 'docs/VALIDATION.md');
const previousReport = exists('docs/VALIDATION.md') ? read('docs/VALIDATION.md') : '';
const browserMarker = '## 浏览器实机验证';
const browserAt = previousReport.indexOf(browserMarker);
const browserTail = browserAt >= 0 ? previousReport.slice(browserAt) : '';

const groups = [...new Set(checks.map((c) => c.group))];
let md = `# 交叉验证报告\n\n`;
md += `- 验证时间：${report.validatedAt}\n- 结果：**${passed} / ${checks.length} 项通过**${report.allPassed ? '（全部通过）' : '（存在失败项）'}\n`;
md += `- 数据源：\`sindresorhus/awesome/readme.md\`，${lines.length - 1} 行 / ${Buffer.byteLength(raw)} 字节，sha256 \`${sha.slice(0, 16)}…\`\n`;
md += `- 解析结果：${catalog.stats.categories} 个分类、${catalog.stats.items} 条清单、${catalog.stats.githubRepos} 个 GitHub 仓库\n`;
md += `- 指标覆盖：**${enriched.length} / ${repos.length}（${catalog.enrichment.coverage.coveragePct}%）**，合计 ${catalog.enrichment.coverage.totalStarsSampled.toLocaleString('zh-CN')} star\n`;
md += `- 中文层：${gotDesc.size} 条描述译文、${Object.keys(i18n.hints).length} 条中文提示、${Object.keys(i18n.categories).length} 个分类译名\n`;
md += `- 历史层：${snaps.length} 个 README 历史版本，新增 ${sumAdd} / 移除 ${sumRemove} / 换链接 ${sumRelink}\n\n`;
for (const g of groups) {
  md += `## ${g}\n\n| 检查项 | 结果 | 依据 |\n| --- | --- | --- |\n`;
  for (const c of checks.filter((x) => x.group === g)) md += `| ${c.name} | ${c.ok ? '通过' : '**失败**'} | ${c.detail.replace(/\|/g, '\\|')} |\n`;
  md += '\n';
}
md += `## 已知边界（非缺陷）\n\n`;
md += `1. 中文为本站人工译述，不是上游官方译本；专有名词保留英文原名，界面提供「中文 / EN」两态切换以便逐条核对。\n`;
md += `2. 源清单里有 ${noDesc.length} 条完全没有描述，本站补写中文提示并显式标注，不冒充上游内容。\n`;
md += `3. 仓库指标来自带授权的 GitHub GraphQL 全量核验；仓库可能改名、归档或删除，页面对此显式标注，不按 0 分处理。\n`;
md += `4. 历史增删对 ${snaps.length} 个真实 README 版本逐版解析比对，仅覆盖最近约 ${history.summary.spanDays} 天；更早的演化不在数据范围内。\n`;
md += `5. 活跃度时间轴展示仓库最近 push 的分布，不是本站的版本历史。\n`;
if (browserTail) md += '\n' + browserTail;
fs.writeFileSync(reportPath, md);
console.log(`${passed}/${checks.length} passed`);
for (const c of checks.filter((x) => !x.ok)) console.log('FAIL:', c.group, c.name, c.detail);
process.exitCode = report.allPassed ? 0 : 1;
