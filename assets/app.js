/* 精选清单地图 — all views, zero runtime dependencies */
(function () {
  'use strict';

  const DATA = window.__ATLAS_DATA__;
  const UPSTREAM = window.__ATLAS_UPSTREAM__ || {};
  const HISTORY = window.__ATLAS_HISTORY__ || { snapshots: [], series: [], summary: {} };
  const I18N = window.__ATLAS_I18N__ || { categories: {}, descriptions: {}, hints: {} };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  if (!DATA) {
    $('#canvasBody').innerHTML = '<div class="empty-state"><strong>数据文件未加载</strong><span>请确认 data/catalog.js 存在。</span></div>';
    return;
  }

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtInt = (n) => (n || 0).toLocaleString('zh-CN');
  const fmtAbbr = (n, en) => {
    if (en) return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0);
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return (n / 1e4).toFixed(n >= 1e6 ? 0 : 1) + ' 万';
    return fmtInt(n);
  };
  const dateOnly = (s) => (s ? String(s).slice(0, 10) : '—');
  const cnDate = (s, en) => {
    if (!s) return '—';
    const [y, m, d] = String(s).slice(0, 10).split('-');
    if (en) return `${Number(d)} ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[Number(m) - 1]} ${y}`;
    return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`;
  };
  const daysSince = (s) => Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
  /* Two language states, so every human-readable unit needs two spellings. The
     English detail panel used to print "Age · 2 个月前" because this function
     only had a Chinese branch. */
  const ago = (s, en) => {
    const d = daysSince(s);
    if (!Number.isFinite(d)) return '—';
    if (d < 1) return en ? 'today' : '今天';
    if (d < 30) return en ? `${d} day${d > 1 ? 's' : ''} ago` : d + ' 天前';
    if (d < 365) {
      const m = Math.floor(d / 30);
      return en ? `${m} month${m > 1 ? 's' : ''} ago` : m + ' 个月前';
    }
    const y = (d / 365).toFixed(1);
    return en ? `${y} years ago` : y + ' 年前';
  };
  const safeUrl = (u) => (/^https?:\/\//.test(u || '') ? esc(u) : '#');
  /* Sequential health scale.
     The ramp holds lightness inside the band where ink text still clears 4.5:1
     (measured: 5.3 – 13.5 on light, 4.9 – 12.3 on dark) and spends its range on hue
     and saturation instead — warm paper → sand → apricot → clay → terracotta.
     The previous ramp stayed inside one material (ΔE 8 across its whole length),
     so every tile read as the same salmon no matter the value. Dark mode lifts
     toward the accent rather than the surface, for the same reason.
     Every tile prints its numeric score, so colour is never the only cue. */
  const RAMP_LIGHT = [[226, 220, 202], [224, 207, 174], [222, 185, 140], [219, 151, 102], [216, 105, 65]];
  const RAMP_DARK = [[52, 43, 35], [69, 53, 39], [112, 69, 41], [149, 78, 40], [174, 75, 36]];
  let _domain = null;
  function healthDomain() {
    if (!_domain) {
      const hs = DATA.items.filter((i) => i.metrics).map((i) => i.metrics.health);
      _domain = hs.length ? [Math.min(...hs), Math.max(...hs)] : [0, 100];
    }
    return _domain;
  }
  /* Colour is scaled to the values a view actually draws. Category averages span
     29–77 while individual repos span 22–100: one global domain left the two
     deepest stops unused and flattened 27 tiles into a single wash. Trimming the
     tails keeps one outlier from re-flattening the rest; every key prints the
     domain it is drawn with, so the scale never lies about its range. */
  function rampDomain(values) {
    const vs = values.filter((v) => v != null).sort((a, b) => a - b);
    if (!vs.length) return [0, 100];
    const pick = (p) => vs[Math.max(0, Math.min(vs.length - 1, Math.round((vs.length - 1) * p)))];
    /* Trimming only pays off on a big population. With 27 categories a 3% cut
       throws away two real values, and the key would then quote a range that
       does not contain every tile it paints. */
    let lo = vs.length >= 40 ? pick(0.03) : vs[0];
    let hi = vs.length >= 40 ? pick(0.97) : vs[vs.length - 1];
    /* Amplifying a three-point spread to full ramp would turn noise into signal. */
    if (hi - lo < 6) { const mid = (lo + hi) / 2; lo = mid - 3; hi = mid + 3; }
    return [lo, hi];
  }
  let _catDomain = null;
  const categoryDomain = () => (_catDomain || (_catDomain = rampDomain(DATA.categories.map((c) => avgHealth(c.id)))));
  const isDark = () => document.documentElement.dataset.theme === 'dark';
  function healthRgb(h, domain) {
    if (h == null) return [138, 134, 126];
    const [lo, hi] = domain || healthDomain();
    const t = hi > lo ? (Math.max(lo, Math.min(hi, h)) - lo) / (hi - lo) : 0.5;
    const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT;
    const pos = t * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(pos));
    const k = pos - i;
    return ramp[i].map((v, j) => Math.round(v + (ramp[i + 1][j] - v) * k));
  }
  const healthColor = (h, domain) => `rgb(${healthRgb(h, domain).join(',')})`;
  /* One source of truth for the legend swatches, so the key cannot drift away
     from the ramp the map and the graph dots actually use. The anchors are
     placed at even steps and blended, because the fill interpolates rather than
     snapping to five buckets -- a banded key would promise classes that do not
     exist. */
  function rampGradient() {
    const ramp = isDark() ? RAMP_DARK : RAMP_LIGHT;
    const step = 100 / (ramp.length - 1);
    return 'linear-gradient(90deg,' + ramp.map((c, i) => `rgb(${c.join(',')}) ${(i * step).toFixed(1)}%`).join(',') + ')';
  }
  const scoreColor = (h) => h == null ? 'var(--ink-3)' : h >= 70 ? 'var(--accent)' : h >= 45 ? 'var(--ink-2)' : 'var(--ink-3)';
  const tipAttr = (name, lines) => esc(name) + '||' + esc(lines.filter(Boolean).join(' · '));

  /* ---------- bilingual UI strings ---------- */
  const UI = {
    zh: {
      brandName: '精选清单地图', brandSub: 'AWESOME ATLAS',
      navStart: '开始探索', navInsight: '今日发现', navAbout: '数据说明',
      eyebrow1: '按结构读，不按顺序读', eyebrow2: '466 条中文译述', eyebrow3: 'CC0 数据',
      heroTitle: '把 <span class="hero-num" id="heroCount">678</span> 份清单<br>变成一张<span class="hero-accent">看得懂的地图</span>',
      heroSub: '一份 866 行的英文 README，从头滚到尾，才知道自己漏了什么。<br class="wrap-only">译成中文、补上 Star 与最近提交——列表一份没少，只是终于有了形状。',
      footerNote: '为国内读者优化：中文检索 · 万位计数 · 仅访问量统计走外部 CDN · 外链已标注',
      footerCreditA: '· 基于', footerCreditB: '（CC0-1.0）结构化与中文译述',
      insightsKicker: '今日发现', insightsTitle: '这份数据自己会说话',
      insightsLead: '以下结论全部由当前快照实时计算，点击可直接跳到对应条目。',
      upstreamRepo: '上游仓库', backTop: '回到顶部',
      tabMap: '分类地图', tabGraph: '关系图谱', tabTable: '检索榜单', tabTimeline: '生态时间轴', tabInsight: '数据洞察',
      sideNav: '分类导航', reset: '重置', scopeTitle: '数据范围', enrichedOnly: '仅显示已验证仓库',
      favoritesOnly: '仅显示我的收藏', hideArchived: '隐藏已归档仓库', favTitle: '我的收藏', exportFav: '导出清单',
      legendTitle: '健康分图例', legendLow: '低 · 已停滞', legendHigh: '高 · 活跃',
      detailEmptyTitle: '点一个节点看看',
      detailEmptyText: '地图上任意瓦片、图谱里的圆点或榜单中的一行，都会在这里展开它的仓库画像、健康分构成与上下游关系。',
      aboutTitle: '关于这份数据', aboutLead: '每个数字都能追溯到源 README 或 GitHub 公开 API，没有估算值混入展示。',
      aboutSource: '来源与许可', aboutParseTitle: '解析口径', aboutMetricTitle: '指标与健康分', aboutBoundaryTitle: '诚实的边界',
      aboutFoot: '纯静态站点 · 无后端 · 无追踪脚本 · 数据快照可复现',
      searchPlaceholder: '搜中文或英文：前端、安全、响应式、React…', searchHint: '支持中文分类、中文描述、名称与仓库名',
      catPlaceholder: '筛选分类…', cmdkPlaceholder: '搜索清单、跳转视图、切换分类…', share: '分享此视图',
      allCategories: '全部分类', all: '全部', starDesc: 'Star 从高到低', healthDesc: '健康分',
      updatedDesc: '最近更新', nameDesc: '名称 A–Z', categoryDesc: '分类', createdDesc: '最早创建', staleDesc: '最久未更新',
      sort: '排序', metricBase: '面积依据', count: '清单数量', stars: '采样 Star', clickRow: '点击一行查看详情',
      scope: '显示范围', topPerCat: '每类热门 10 个', allVerified: '全部已验证', allLists: '全部清单', myFavorites: '我的收藏',
      scopeLine: '上游提交 + 仓库活跃度分布', drillBack: '全部分类', nameDescCol: '名称 / 描述', catCol: '分类',
      updatedCol: '最近更新', healthCol: '健康分', prev: '上一页', next: '下一页', noMatch: '没有匹配的清单',
      noMatchHint: '试试清空搜索词或重置筛选条件。', clearSearch: '清空搜索', resetAll: '重置筛选',
      mainEntry: '主条目', subEntry: '子条目', noSample: '未采集', archived: '已归档', unavailable: '链接失效',
      hintLabel: '中文提示 · 源清单未提供描述', openGithub: '在 GitHub 打开',
      fav: '收藏', faved: '已收藏', sameCat: '看同分类', metrics: '仓库指标', relations: '来源与关系',
      close: '关闭详情', viewMap: '地图', viewGraph: '图谱', viewTable: '榜单', viewTimeline: '时间', viewInsight: '洞察',
      copyOk: '链接已复制，可直接分享', copyFail: '复制失败，请手动复制地址栏链接',
      cardBtn: '存为卡片图', cardOk: '卡片图已保存（1200×630 PNG）', cardFail: '卡片图生成失败，请重试',
      exportEmpty: '还没有收藏，先在榜单里点 ☆ 收藏几条吧', exportOk: '收藏清单已导出为 Markdown',
      favAdded: '已加入收藏', favRemoved: '已取消收藏', langZh: '已切换为中文', langEn: '已切换为英文原文',
      legendNote: '健康分只对已验证仓库计算；未命中或已失效的条目始终标注「未采集」，不按 0 分处理。',
      countSuffix: '条', matchedPrefix: '匹配', totalPrefix: '共', inScope: '条在当前范围内',
      plateKicker: '图 01 · 分类地图', plateFoot: '点按进入地图', mapScale: '健康分 · 相对',
    },
    en: {
      brandName: 'Awesome Atlas', brandSub: 'CURATED INDEX',
      navStart: 'Explore', navInsight: 'Insights', navAbout: 'About',
      eyebrow1: 'Read by structure, not by order', eyebrow2: '673 repos scored', eyebrow3: 'CC0 data',
      heroTitle: 'Turn <span class="hero-num" id="heroCount">678</span> curated lists<br>into a <span class="hero-accent">readable map</span>',
      heroSub: 'An 866-line README — you only learn what you missed at the bottom. Stars, last push, and a map: the same lists, finally given a shape.',
      footerNote: 'Built for readers in mainland China: Chinese search · only the analytics beacon uses an external CDN · external links labelled',
      footerCreditA: '· structure and Chinese translation based on', footerCreditB: '(CC0-1.0)',
      insightsKicker: 'Insights', insightsTitle: 'This dataset speaks for itself',
      insightsLead: 'Every conclusion below is computed from the current snapshot; click one to jump to the entries behind it.',
      upstreamRepo: 'Upstream repo', backTop: 'Back to top',
      tabMap: 'Category Map', tabGraph: 'Relation Graph', tabTable: 'Search & Rank', tabTimeline: 'Ecosystem Timeline', tabInsight: 'Data Insights',
      sideNav: 'Categories', reset: 'Reset', scopeTitle: 'Data scope', enrichedOnly: 'Verified repos only',
      favoritesOnly: 'My favorites only', hideArchived: 'Hide archived repos', favTitle: 'Favorites', exportFav: 'Export',
      legendTitle: 'Health score', legendLow: 'Low / stale', legendHigh: 'High / active',
      detailEmptyTitle: 'Pick a node',
      detailEmptyText: 'Every tile, dot or row opens a repository profile with its health breakdown and hierarchy.',
      aboutTitle: 'About this data', aboutLead: 'Every number traces back to the source README or the public GitHub API. No estimates.',
      aboutSource: 'Source & license', aboutParseTitle: 'Parsing', aboutMetricTitle: 'Metrics & health', aboutBoundaryTitle: 'Honest limits',
      aboutFoot: 'Static site · no backend · no trackers · reproducible snapshot',
      searchPlaceholder: 'Search lists, descriptions, repos or categories…', searchHint: 'Matches names, descriptions, repos and categories',
      catPlaceholder: 'Filter categories…', cmdkPlaceholder: 'Search lists, jump to a view, switch category…', share: 'Share this view',
      allCategories: 'All categories', all: 'All', starDesc: 'Stars (high to low)', healthDesc: 'Health score',
      updatedDesc: 'Recently pushed', nameDesc: 'Name A–Z', categoryDesc: 'Category', createdDesc: 'Oldest first', staleDesc: 'Stalest first',
      sort: 'Sort', metricBase: 'Area by', count: 'List count', stars: 'Sampled stars', clickRow: 'Click a row for details',
      scope: 'Scope', topPerCat: 'Top 10 per category', allVerified: 'All verified', allLists: 'All lists', myFavorites: 'My favorites',
      scopeLine: 'Upstream commits + repository activity', drillBack: 'All categories', nameDescCol: 'Name / description', catCol: 'Category',
      updatedCol: 'Last push', healthCol: 'Health', prev: 'Previous', next: 'Next', noMatch: 'No lists match',
      noMatchHint: 'Try clearing the search or resetting the filters.', clearSearch: 'Clear search', resetAll: 'Reset filters',
      mainEntry: 'Top-level', subEntry: 'Nested', noSample: 'not sampled', archived: 'archived', unavailable: 'link dead',
      hintLabel: 'Editor hint · no upstream description', openGithub: 'Open on GitHub',
      fav: 'Save', faved: 'Saved', sameCat: 'Same category', metrics: 'Repository metrics', relations: 'Source & relations',
      close: 'Close', viewMap: 'Map', viewGraph: 'Graph', viewTable: 'Table', viewTimeline: 'Time', viewInsight: 'Insight',
      copyOk: 'Link copied', copyFail: 'Copy failed, please copy the address bar manually',
      cardBtn: 'Save card', cardOk: 'Card saved (1200×630 PNG)', cardFail: 'Could not generate the card',
      exportEmpty: 'No favorites yet — star a few rows first', exportOk: 'Favorites exported as Markdown',
      favAdded: 'Added to favorites', favRemoved: 'Removed from favorites', langZh: 'Switched to Chinese', langEn: 'Switched to English',
      legendNote: 'Health is computed only for verified repositories. Missing entries are labelled, never treated as zero.',
      countSuffix: '', matchedPrefix: 'matched', totalPrefix: 'total', inScope: 'in current scope',
      plateKicker: 'Plate 01 · Map', plateFoot: 'Open the map', mapScale: 'health · relative',
    },
  };
  const LANG_KEY = 'atlas-lang';
  /* Safari private mode, a filed `file://` origin and enterprise policy all make
     storage throw on access. A bare `localStorage.getItem` used to abort the
     whole IIFE before the first render, leaving a blank canvas; reads and writes
     now degrade to in-memory defaults instead. */
  function readStore(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) { return fallback; }
  }
  function writeStore(key, value) {
    try { localStorage.setItem(key, value); } catch (_) { /* storage unavailable */ }
  }
  let lang = readStore(LANG_KEY, 'zh') || 'zh';
  /* Two states only. A stored 'both' from an older visit has to degrade to a
     valid state or the whole UI would render with the 'both' code paths gone. */
  if (!['zh', 'en'].includes(lang)) lang = 'zh';
  const isEn = () => lang === 'en';
  /* `||` would treat a deliberate empty string (EN has countSuffix: '') as a
     missing key and fall back to the Chinese value, which printed "total 678 条". */
  const ui = (k) => {
    const dict = UI[isEn() ? 'en' : 'zh'];
    const v = dict[k];
    if (v !== undefined && v !== null) return v;
    return UI.zh[k] !== undefined ? UI.zh[k] : k;
  };

  function catName(c) { return isEn() ? c.name : (I18N.categories[c.id]?.zh || c.name); }
  function catNote(c) { return I18N.categories[c.id]?.note || ''; }
  function catLabel(c) { return esc(catName(c)); }
  function descOf(it) {
    const zh = I18N.descriptions[it.id] || I18N.hints[it.name] || '';
    if (isEn()) return { main: it.description || '', orig: '', hint: false };
    return { main: zh, orig: '', hint: !it.description };
  }
  function plainDesc(it) { return descOf(it).main; }

  const CAPTIONS = {
    zh: {
      map: '面积 = 清单数量或采样 Star，颜色 = 分类平均健康分；点击分类可下钻到具体清单',
      graph: '中心为源索引，外圈为 27 个分类，圆点是清单；大小对应 Star，颜色对应健康分',
      table: '678 条清单全文检索、排序、收藏；中文描述配英文原名，切到 EN 可核对原文',
      timeline: '来自 README 24 个真实历史版本的增删记录，以及已验证仓库的最近 push 分布',
      insight: '把全量指标重新聚合：分类热度、健康分分布、语言偏好与需要留意的清单',
    },
    en: {
      map: 'Area = list count or sampled stars; colour = average health. Click a category to drill down.',
      graph: 'The source index at the centre, 27 categories outside; dot size = stars, colour = health.',
      table: 'Full-text search, sorting and favorites across all 678 curated lists.',
      timeline: 'Real added/removed lists from 24 historical README revisions, plus push activity.',
      insight: 'Aggregated metrics: category weight, health distribution, languages and stale lists.',
    },
  };

  /* ---------- data index ---------- */
  const catById = new Map(DATA.categories.map((c) => [c.id, c]));
  const itemById = new Map(DATA.items.map((it) => [it.id, it]));
  const itemsOf = (cid) => DATA.items.filter((it) => it.categoryId === cid);
  const enrichedOf = (cid) => itemsOf(cid).filter((it) => it.metrics);
  const avgHealth = (cid) => {
    const a = enrichedOf(cid);
    return a.length ? Math.round(a.reduce((s, it) => s + it.metrics.health, 0) / a.length) : null;
  };
  const totalStarsOf = (cid) => enrichedOf(cid).reduce((s, it) => s + it.metrics.stars, 0);

  for (const it of DATA.items) {
    const c = catById.get(it.categoryId);
    it.__search = [
      it.name, it.description, it.repo, it.url,
      c ? c.name : '', c ? catName(c) : '', c ? catNote(c) : '',
      I18N.descriptions[it.id] || '', I18N.hints[it.name] || '',
      it.metrics ? (it.metrics.topics || []).join(' ') : '',
      it.metrics ? (it.metrics.language || '') : '',
    ].join(' ').toLowerCase();
  }

  const cov = (DATA.enrichment && DATA.enrichment.coverage) || UPSTREAM.coverage || {};
  const VERIFIED = DATA.items.filter((it) => it.metrics);
  const TOTAL_STARS = VERIFIED.reduce((s, it) => s + it.metrics.stars, 0);
  const ARCHIVED = VERIFIED.filter((it) => it.metrics.archived);
  const LANG_COUNT = new Map();
  const LICENSE_COUNT = new Map();
  for (const it of VERIFIED) {
    if (it.metrics.language) LANG_COUNT.set(it.metrics.language, (LANG_COUNT.get(it.metrics.language) || 0) + 1);
    if (it.metrics.license && it.metrics.license !== 'NOASSERTION') LICENSE_COUNT.set(it.metrics.license, (LICENSE_COUNT.get(it.metrics.license) || 0) + 1);
  }
  const recentlyPushed = VERIFIED.filter((it) => daysSince(it.metrics.pushedAt) <= 365).length;

  /* ---------- state ---------- */
  const P = new URLSearchParams(location.search);
  const VIEWS = ['map', 'graph', 'table', 'timeline', 'insight'];
  const SORTS = ['stars', 'health', 'updated', 'name', 'category', 'created', 'stale'];
  const SCOPES = ['curated', 'enriched', 'all', 'favorites'];
  let favorites = new Set();
  try { favorites = new Set(JSON.parse(readStore('atlas-favorites', '[]'))); } catch (_) { /* ignore */ }
  for (const id of [...favorites]) if (!itemById.has(id)) favorites.delete(id);

  const state = {
    view: VIEWS.includes(P.get('view')) ? P.get('view') : 'map',
    cat: catById.has(P.get('cat')) ? P.get('cat') : 'all',
    q: P.get('q') || '',
    catQuery: '',
    sort: SORTS.includes(P.get('sort')) ? P.get('sort') : 'stars',
    metric: P.get('metric') === 'stars' ? 'stars' : 'count',
    scope: SCOPES.includes(P.get('scope')) ? P.get('scope') : 'curated',
    drill: catById.has(P.get('drill')) ? P.get('drill') : null,
    selected: itemById.has(P.get('id')) ? P.get('id') : null,
    page: Math.max(1, Number(P.get('page')) || 1),
    enrichedOnly: P.get('enriched') === '1',
    favoritesOnly: P.get('fav') === '1',
    hideArchived: P.get('archived') === '0',
    theme: readStore('atlas-theme', 'light') === 'dark' ? 'dark' : 'light',
  };
  if (['zh', 'en'].includes(P.get('lang'))) lang = P.get('lang');
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.lang = isEn() ? 'en' : 'zh-CN';

  function filteredItems() {
    const q = state.q.trim().toLowerCase();
    return DATA.items.filter((it) => {
      if (state.cat !== 'all' && it.categoryId !== state.cat) return false;
      if (state.enrichedOnly && !it.metrics) return false;
      if (state.favoritesOnly && !favorites.has(it.id)) return false;
      if (state.hideArchived && it.metrics && it.metrics.archived) return false;
      if (q && !it.__search.includes(q)) return false;
      return true;
    });
  }

  /* Mirrors the last value written to the address bar, so popstate can tell a
     real state change from an in-page #anchor hop. */
  let lastSearch = location.search;

  /* `push` is true only for deliberate navigations (view, category, selection,
     sort, scope, language). Typing in the search box replaces the current entry
     instead, otherwise every keystroke would become a separate history step. */
  function writeURL(push) {
    const p = new URLSearchParams();
    if (state.view !== 'map') p.set('view', state.view);
    if (state.cat !== 'all') p.set('cat', state.cat);
    if (state.q) p.set('q', state.q);
    if (state.sort !== 'stars') p.set('sort', state.sort);
    if (state.metric !== 'count') p.set('metric', state.metric);
    if (state.scope !== 'curated') p.set('scope', state.scope);
    if (state.drill) p.set('drill', state.drill);
    if (state.selected) p.set('id', state.selected);
    if (state.page > 1) p.set('page', String(state.page));
    if (state.enrichedOnly) p.set('enriched', '1');
    if (state.favoritesOnly) p.set('fav', '1');
    if (state.hideArchived) p.set('archived', '0');
    if (lang !== 'zh') p.set('lang', lang);
    const next = p.toString() ? '?' + p.toString() : '';
    const target = (next || location.pathname) + (location.hash || '');
    try {
      if (push && next !== lastSearch) history.pushState(null, '', target);
      else history.replaceState(null, '', target);
    } catch (_) { /* file:// */ }
    lastSearch = next;
  }

  /* The controls live in static HTML, so a popstate or a deep link has to push
     state back into them; otherwise the sidebar shows a filter it is not using. */
  function syncControls() {
    $('#searchInput').value = state.q;
    const scope = $('#scopeSelect');
    if (scope) scope.value = state.scope;
    const sort = $('#sortSelect');
    if (sort) sort.value = state.sort;
    $('#enrichedOnly').checked = state.enrichedOnly;
    $('#favoritesOnly').checked = state.favoritesOnly;
    $('#hideArchived').checked = state.hideArchived;
  }

  /* Back / forward restores the previous view. This used to be a blunt
     `location.reload()`, which also fired for in-page #anchor navigation and
     turned every top-nav click into a full reload that lost its own target. */
  function applyURL() {
    const q = new URLSearchParams(location.search);
    state.view = VIEWS.includes(q.get('view')) ? q.get('view') : 'map';
    state.cat = catById.has(q.get('cat')) ? q.get('cat') : 'all';
    state.q = q.get('q') || '';
    state.sort = SORTS.includes(q.get('sort')) ? q.get('sort') : 'stars';
    state.metric = q.get('metric') === 'stars' ? 'stars' : 'count';
    state.scope = SCOPES.includes(q.get('scope')) ? q.get('scope') : 'curated';
    state.drill = catById.has(q.get('drill')) ? q.get('drill') : null;
    state.selected = itemById.has(q.get('id')) ? q.get('id') : null;
    state.page = Math.max(1, Number(q.get('page')) || 1);
    state.enrichedOnly = q.get('enriched') === '1';
    state.favoritesOnly = q.get('fav') === '1';
    state.hideArchived = q.get('archived') === '0';
    const nextLang = q.get('lang');
    if (['zh', 'en'].includes(nextLang) && nextLang !== lang) {
      lang = nextLang;
      writeStore(LANG_KEY, lang);
    }
    document.documentElement.lang = isEn() ? 'en' : 'zh-CN';
    syncControls();
    renderAll();
  }

  /* ---------- binary treemap ---------- */
  function treemap(entries, x, y, w, h, out) {
    if (!entries.length) return out || [];
    const res = out || [];
    if (entries.length === 1) { res.push(Object.assign({}, entries[0], { x, y, w, h })); return res; }
    const total = entries.reduce((s, e) => s + e.value, 0) || 1;
    let acc = 0, split = 1, best = Infinity;
    for (let i = 1; i < entries.length; i += 1) {
      acc += entries[i - 1].value;
      const diff = Math.abs(total / 2 - acc);
      if (diff < best) { best = diff; split = i; }
    }
    const left = entries.slice(0, split), right = entries.slice(split);
    const ratio = (left.reduce((s, e) => s + e.value, 0) || 0.001) / total;
    if (w >= h) {
      treemap(left, x, y, w * ratio, h, res);
      treemap(right, x + w * ratio, y, w * (1 - ratio), h, res);
    } else {
      treemap(left, x, y, w, h * ratio, res);
      treemap(right, x, y + h * ratio, w, h * (1 - ratio), res);
    }
    return res;
  }

  /* ---------- static UI text ---------- */
  let chromeLang = null;
  function renderStaticUI() {
    $$('[data-ui]').forEach((el) => { el.textContent = ui(el.dataset.ui); });
    /* The hero copy carries markup (the live count and the accent span), so it
       cannot go through the textContent loop above. Rebuild it only when the
       language actually changes, not on every keystroke. */
    if (chromeLang !== lang) {
      chromeLang = lang;
      $('#heroTitle').innerHTML = ui('heroTitle');
      /* innerHTML, not textContent: the Chinese lede carries a deliberate line break.
       CJK wraps between any two characters, so the browser was splitting 「补上」
       across lines at desktop width. The <br> is a composition decision, not data. */
    $('#heroSub').innerHTML = ui('heroSub');
      $('#upstreamLink').title = isEn() ? 'Open the upstream repository on GitHub' : '打开上游仓库（境外站点，可能较慢）';
      $('#backToTop').title = isEn() ? 'Back to the top of the page' : '回到页面顶部';
      $('#heroPlate').setAttribute('aria-label', isEn() ? 'Open the full category map' : '查看完整的分类地图');
    }
    $('#searchInput').placeholder = ui('searchPlaceholder');
    $('#searchHint').textContent = ui('searchHint');
    $('#catSearch').placeholder = ui('catPlaceholder');
    $('#cmdkInput').placeholder = ui('cmdkPlaceholder');
    $('#shareBtn span').textContent = ui('share');
    $$('#langSwitch button').forEach((b) => b.classList.toggle('is-on', b.dataset.lang === lang));
    $('#legendNote').textContent = ui('legendNote');
    const scaleEl = $('.legend-scale');
    if (scaleEl) scaleEl.style.background = rampGradient();
    if ($('#plateMeta')) {
      $('#plateMeta').textContent = isEn()
        ? `${DATA.categories.length} categories · ${DATA.stats.items} lists`
        : `${DATA.categories.length} 类 · ${DATA.stats.items} 条`;
    }
    /* The sidebar key is a category scale: it sits next to the 27 category
       swatches, so it must show the range those swatches are drawn over. The
       map carries its own key for the population it is currently drawing. */
    const [cLo, cHi] = categoryDomain();
    if ($('#legendLow')) $('#legendLow').textContent = `${Math.round(cLo)} · ${isEn() ? 'weaker' : '偏弱'}`;
    if ($('#legendHigh')) $('#legendHigh').textContent = `${Math.round(cHi)} · ${isEn() ? 'stronger' : '偏强'}`;
    document.title = isEn() ? 'Awesome Atlas · A Visual Index of Curated Lists' : '精选清单地图 · Awesome 中文可视化索引';
  }

  /* ---------- headline metrics ----------
     No decorative sparklines here: the four numbers are counts and totals, and a
     trend line for them would have to be invented. Real series live in the
     timeline view, which is driven by data/history.json. */
  let metricAnimated = false;
  function renderMetrics() {
    const cards = [
      { label: isEn() ? 'Categories' : '技术分类', value: DATA.stats.categories, note: isEn() ? `${DATA.stats.raw.h2Count} H2 sections incl. TOC & Related` : `${DATA.stats.raw.h2Count} 个 H2 章节，含目录与 Related` },
      { label: isEn() ? 'Curated lists' : '精选清单', value: DATA.stats.items, note: isEn() ? `${DATA.stats.level0} top-level · ${DATA.stats.level1} nested` : `${DATA.stats.level0} 主条目 · ${DATA.stats.level1} 子条目` },
      { label: isEn() ? 'Verified repos' : '已验证仓库', value: cov.reposEnriched || VERIFIED.length, unit: '/ ' + (cov.reposTotal || DATA.stats.githubRepos), note: isEn() ? `${cov.coveragePct || 0}% coverage · full GitHub API sweep` : `全量核验，覆盖率 ${cov.coveragePct || 0}%` },
      { label: isEn() ? 'Stars in sample' : '采样 Star 总量', value: TOTAL_STARS, fmt: true, note: isEn() ? `across ${VERIFIED.length} verified repositories` : `来自 ${VERIFIED.length} 个已验证仓库` },
    ];
    $('#metrics').innerHTML = cards.map((c) => `<div class="metric"><div class="metric-label">${esc(c.label)}</div>
      <div class="metric-value" data-target="${c.value}" data-fmt="${c.fmt ? 1 : 0}">${c.fmt ? fmtAbbr(c.value, isEn()) : fmtInt(c.value)}${c.unit ? `<small>${esc(c.unit)}</small>` : ''}</div>
      <div class="metric-note">${esc(c.note)}</div></div>`).join('');
    $('#heroCount').textContent = DATA.stats.items;
    if (!metricAnimated) { metricAnimated = true; animateNumbers(); }
  }
  function animateNumbers() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    $$('.metric-value[data-target]').forEach((el) => {
      const target = Number(el.dataset.target), fmt = el.dataset.fmt === '1';
      const unit = el.querySelector('small');
      const unitHtml = unit ? unit.outerHTML : '';
      const start = performance.now(), dur = 900;
      const step = (now) => {
        const k = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - k, 3);
        const v = Math.round(target * eased);
        el.innerHTML = (fmt ? fmtAbbr(v, isEn()) : fmtInt(v)) + unitHtml;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /* ---------- changes since this browser last looked ---------- */
  /* There is no backend, so the only honest baseline is the copy of the
     catalogue this browser saw last time. One compact record per list is kept
     under `atlas-seen`; diffing it against the current snapshot answers the four
     questions a returning reader actually has: what appeared, what disappeared,
     what got archived, and how far the star total moved. A first visit records
     the baseline and says so instead of inventing a diff. */
  const SEEN_KEY = 'atlas-seen';
  function seenSnapshot() {
    return {
      at: DATA.generatedAt,
      items: DATA.items.map((it) => [
        it.id, it.name, it.categoryId,
        it.metrics && it.metrics.stars != null ? it.metrics.stars : null,
        it.metrics && it.metrics.archived ? 1 : 0,
        it.url || '',
      ]),
    };
  }
  function diffSince(prev) {
    const prevMap = new Map(prev.items.map((r) => [r[0], r]));
    const current = new Set(DATA.items.map((it) => it.id));
    const added = [], archived = [];
    let starDelta = 0;
    for (const it of DATA.items) {
      const p = prevMap.get(it.id);
      if (!p) { added.push(it); continue; }
      if (!it.metrics) continue;
      /* A list that was unenriched last time has no baseline star count, and
         treating null as 0 would report the whole repository as growth. */
      if (p[3] != null) starDelta += it.metrics.stars - p[3];
      if (it.metrics.archived && !p[4]) archived.push(it);
    }
    const removed = prev.items
      .filter((r) => !current.has(r[0]))
      .map((r) => ({ name: r[1], catId: r[2], url: r[5] }));
    return { added, removed, archived, starDelta };
  }
  /* Computed once at boot: reading it again on every re-render would compare the
     freshly written baseline with itself and report no change. */
  let SINCE = null;
  function computeSince() {
    let prev = null;
    try { prev = JSON.parse(readStore(SEEN_KEY, 'null')); } catch (_) { /* corrupt payload */ }
    const first = !prev || !Array.isArray(prev.items) || !prev.at;
    const newer = !first && Date.parse(DATA.generatedAt) > Date.parse(prev.at);
    SINCE = first ? { mode: 'first' } : (newer ? { mode: 'diff', prev, diff: diffSince(prev) } : { mode: 'none' });
    writeStore(SEEN_KEY, JSON.stringify(seenSnapshot()));
  }
  function renderSince() {
    const host = $('#since');
    if (!host || !SINCE) return;
    if (SINCE.mode === 'first') {
      host.hidden = false;
      host.innerHTML = `<div class="since-row"><span class="since-kicker">${isEn() ? 'Since your last visit' : '自上次查看以来'}</span><span class="since-quiet">${isEn()
        ? `Snapshot ${dateOnly(DATA.generatedAt)} recorded. Come back after the next data update to see what was added, removed or archived.`
        : `已记录本次快照（${dateOnly(DATA.generatedAt)}）。下次数据更新后再来，这里会列出新增、移除、新归档与 Star 变化。`}</span></div>`;
      return;
    }
    if (SINCE.mode !== 'diff') { host.hidden = true; return; }
    const d = SINCE.diff;
    if (!d.added.length && !d.removed.length && !d.archived.length && !d.starDelta) { host.hidden = true; return; }

    const stat = (value, label, down) => `<li${down ? ' class="is-down"' : ''}><b>${value}</b><span>${label}</span></li>`;
    const stats = [
      stat((d.added.length ? '+' : '') + d.added.length, isEn() ? 'added' : '新增'),
      stat((d.removed.length ? '−' : '') + d.removed.length, isEn() ? 'removed' : '移除', d.removed.length > 0),
      stat(String(d.archived.length), isEn() ? 'newly archived' : '新归档'),
    ];
    if (d.starDelta) {
      stats.push(stat((d.starDelta > 0 ? '+' : '−') + fmtAbbr(Math.abs(d.starDelta), isEn()),
        isEn() ? 'stars' : 'Star', d.starDelta < 0));
    }

    const items = (rows) => rows.slice(0, 6).join('')
      + (rows.length > 6 ? `<li class="since-more">${isEn() ? `+ ${rows.length - 6} more` : `另有 ${rows.length - 6} 条`}</li>` : '');
    const openable = (it) => `<li><button type="button" class="since-item" data-action="insight-item" data-id="${esc(it.id)}"><span class="since-name">${esc(it.name)}</span><span class="since-cat">${esc(catName(catById.get(it.categoryId)))}</span></button></li>`;
    const groups = [
      d.added.length && `<div class="since-group"><div class="since-group-title">${isEn() ? 'Added' : '新增'}</div><ul class="since-list">${items(d.added.map(openable))}</ul></div>`,
      d.removed.length && `<div class="since-group"><div class="since-group-title">${isEn() ? 'Removed upstream' : '上游已移除'}</div><ul class="since-list">${items(d.removed.map((r) => {
        const c = catById.get(r.catId);
        return `<li><a class="since-item" href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer"><span class="since-name">${esc(r.name)}</span><span class="since-cat">${c ? esc(catName(c)) : '—'}</span></a></li>`;
      }))}</ul></div>`,
      d.archived.length && `<div class="since-group"><div class="since-group-title">${isEn() ? 'Newly archived' : '新归档'}</div><ul class="since-list">${items(d.archived.map(openable))}</ul></div>`,
    ].filter(Boolean);

    host.hidden = false;
    host.innerHTML = `<div class="since-row">
        <span class="since-kicker">${isEn() ? 'Since your last visit' : '自上次查看以来'}</span>
        <span class="since-date">${dateOnly(SINCE.prev.at)} → ${dateOnly(DATA.generatedAt)}</span>
        <ul class="since-stats">${stats.join('')}</ul>
        ${groups.length ? `<details class="since-details"><summary>${isEn() ? 'Show every change' : '展开全部变化'}</summary><div class="since-groups">${groups.join('')}</div></details>` : ''}
      </div>`;
  }

  /* ---------- insight strip ---------- */
  function renderInsights() {
    const byCount = DATA.categories.slice().sort((a, b) => b.itemCount - a.itemCount)[0];
    const byStars = DATA.categories.slice().sort((a, b) => totalStarsOf(b.id) - totalStarsOf(a.id))[0];
    const freshest = VERIFIED.slice().sort((a, b) => (b.metrics.health - a.metrics.health) || (b.metrics.stars - a.metrics.stars))[0];
    const staleCount = VERIFIED.filter((it) => daysSince(it.metrics.pushedAt) > 730).length;
    const cards = [
      { ico: '◈', glow: 'var(--accent)', kicker: isEn() ? 'LARGEST CATEGORY' : '条目最多的分类', value: catName(byCount), desc: isEn() ? `${byCount.itemCount} curated lists · ${byCount.childCount} nested` : `收录 ${byCount.itemCount} 份清单，其中 ${byCount.childCount} 个子条目`, action: 'insight-cat', id: byCount.id },
      { ico: '★', glow: 'var(--accent-2)', kicker: isEn() ? 'MOST STARS' : '星标最集中的分类', value: catName(byStars), desc: isEn() ? `${fmtAbbr(totalStarsOf(byStars.id), true)} stars across ${enrichedOf(byStars.id).length} verified repos` : `合计 ${fmtAbbr(totalStarsOf(byStars.id), false)} Star，来自 ${enrichedOf(byStars.id).length} 个已验证仓库`, action: 'insight-stars', id: byStars.id },
      { ico: '↗', glow: 'var(--accent-3)', kicker: isEn() ? 'HEALTHIEST LIST' : '综合表现最好的清单', value: freshest ? freshest.name : '—', desc: freshest ? (isEn() ? `Health ${freshest.metrics.health}/100 · ${fmtAbbr(freshest.metrics.stars, true)} stars` : `健康分 ${freshest.metrics.health}，${fmtAbbr(freshest.metrics.stars, false)} Star`) : '—', action: 'insight-item', id: freshest ? freshest.id : '' },
      { ico: '!', glow: 'var(--warn)', kicker: isEn() ? 'WORTH A CHECK' : '值得留意的角落', value: isEn() ? `${ARCHIVED.length + staleCount} lists` : `${ARCHIVED.length + staleCount} 份清单`, desc: isEn() ? `${ARCHIVED.length} archived, ${staleCount} with no push for 2+ years` : `${ARCHIVED.length} 份已归档、${staleCount} 份超过两年未更新，可在数据洞察里逐一查看`, action: 'insight-view', id: 'insight' },
    ];
    $('#insightGrid').innerHTML = cards.map((c) => `<button class="insight-card" type="button" data-action="${c.action}" data-id="${esc(c.id)}" style="--iglow:${c.glow}">
      <div class="insight-top"><span>${esc(c.kicker)}</span><span class="insight-ico">${c.ico}</span></div>
      <div class="insight-value">${esc(c.value)}</div><div class="insight-desc">${esc(c.desc)}</div><span class="insight-arrow">↗</span></button>`).join('');
  }

  function renderQuickChips() {
    const top = DATA.categories.slice().sort((a, b) => b.itemCount - a.itemCount).slice(0, 6);
    const chips = [{ id: 'all', name: ui('all') }].concat(top.map((c) => ({ id: c.id, name: catName(c) })));
    /* The row only shows the six largest categories, so it ends with an explicit
       way out instead of silently implying that six is all there is. */
    const more = `<a class="quick-chip is-more" href="#workspace">${isEn() ? `all ${DATA.categories.length} →` : `全部 ${DATA.categories.length} 类 →`}</a>`;
    $('#quickChips').innerHTML = chips.map((c) => `<button class="quick-chip ${state.cat === c.id ? 'is-on' : ''}" type="button" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join('') + more;
  }

  function renderSidebar() {
    const cq = state.catQuery.trim().toLowerCase();
    const max = Math.max(...DATA.categories.map((c) => c.itemCount));
    const rows = DATA.categories.filter((c) => !cq || (c.name + catName(c) + catNote(c)).toLowerCase().includes(cq));
    const allRow = `<button class="cat-row ${state.cat === 'all' ? 'is-on' : ''}" type="button" data-cat="all"><span class="cat-swatch" style="background:var(--accent)"></span><span class="cat-name">${esc(ui('allCategories'))}</span><span class="cat-count">${DATA.stats.items}</span></button>`;
    $('#categoryList').innerHTML = allRow + rows.map((c) => {
      const h = avgHealth(c.id);
      return `<button class="cat-row ${state.cat === c.id ? 'is-on' : ''}" type="button" data-cat="${esc(c.id)}" data-tip="${tipAttr(catName(c), [catNote(c), c.itemCount + ' ' + ui('countSuffix'), h == null ? ui('noSample') : (isEn() ? 'avg health ' : '平均健康分 ') + h])}"><span class="cat-swatch" style="background:${healthColor(h, categoryDomain())}"></span><span class="cat-name">${catLabel(c)}</span><span class="cat-count">${c.itemCount}</span><span class="cat-bar" style="width:${Math.round((c.itemCount / max) * 100)}%"></span></button>`;
    }).join('');
    $('#enrichedOnly').checked = state.enrichedOnly;
    $('#favoritesOnly').checked = state.favoritesOnly;
    $('#hideArchived').checked = state.hideArchived;
    $('#favCount').textContent = favorites.size + ' ' + ui('countSuffix');
  }

  function renderToolbar() {
    let html = '';
    if (state.view === 'map') {
      html = `<span class="toolbar-label">${ui('metricBase')}</span><span class="seg"><button type="button" data-metric="count" class="${state.metric === 'count' ? 'is-on' : ''}">${ui('count')}</button><button type="button" data-metric="stars" class="${state.metric === 'stars' ? 'is-on' : ''}">${ui('stars')}</button></span>`;
      /* The sidebar, the quick chips, the command palette and the insight cards
         all set `cat`. The map now treats that as "focus this category" instead
         of highlighting one tile out of 27, so the breadcrumb has to follow it. */
      const focusCat = state.drill || (state.cat !== 'all' ? state.cat : null);
      html += focusCat
        ? `<span class="breadcrumb"><button type="button" data-action="drill-back">${ui('drillBack')}</button> / <span>${esc(catName(catById.get(focusCat)))}</span></span>`
        : `<span class="breadcrumb"><span>${isEn() ? `${DATA.categories.length} categories · click a tile to drill down` : `${DATA.categories.length} 个分类 · 点击瓦片下钻`}</span></span>`;
    } else if (state.view === 'graph') {
      html = `<span class="toolbar-label">${ui('scope')}</span><select class="tool-select" id="scopeSelect" aria-label="${ui('scope')}"><option value="curated" ${state.scope === 'curated' ? 'selected' : ''}>${ui('topPerCat')}</option><option value="enriched" ${state.scope === 'enriched' ? 'selected' : ''}>${ui('allVerified')}</option><option value="all" ${state.scope === 'all' ? 'selected' : ''}>${ui('allLists')}</option><option value="favorites" ${state.scope === 'favorites' ? 'selected' : ''}>${ui('myFavorites')}</option></select>`;
    } else if (state.view === 'table') {
      const opts = [['stars', ui('starDesc')], ['health', ui('healthDesc')], ['updated', ui('updatedDesc')], ['name', ui('nameDesc')], ['category', ui('categoryDesc')], ['created', ui('createdDesc')], ['stale', ui('staleDesc')]];
      html = `<span class="toolbar-label">${ui('sort')}</span><select class="tool-select" id="sortSelect" aria-label="${ui('sort')}">${opts.map(([v, l]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><span class="toolbar-label">${ui('clickRow')}</span>`;
    } else if (state.view === 'timeline') {
      html = `<span class="toolbar-label">${ui('scopeLine')}</span>`;
    } else {
      html = `<span class="toolbar-label">${isEn() ? 'Aggregated from all verified repositories' : `基于 ${VERIFIED.length} 个已验证仓库的全量聚合`}</span>`;
    }
    html += `<span class="toolbar-spacer"></span><span class="toolbar-label" id="toolbarCount"></span>`;
    $('#canvasToolbar').innerHTML = html;
  }

  function renderViewState() {
    $$('.view-tab').forEach((b) => {
      const on = b.dataset.view === state.view;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', String(on));
      /* Roving tabindex: the tab strip is one stop in the tab order, arrows move
         between views. Without it every tab was a separate stop. */
      b.tabIndex = on ? 0 : -1;
      b.querySelector('[data-ui]').textContent = ui('tab' + b.dataset.view.charAt(0).toUpperCase() + b.dataset.view.slice(1));
    });
    $('#viewCaption').textContent = (CAPTIONS[isEn() ? 'en' : 'zh'])[state.view];
    positionGlider();
    renderMobileTabs();
  }
  function positionGlider() {
    const g = $('#tabGlider'), active = $('.view-tab.is-active');
    if (!g || !active || window.innerWidth <= 760) return;
    const parent = g.parentElement;
    g.style.width = active.offsetWidth + 'px';
    g.style.transform = `translateX(${active.offsetLeft - parent.offsetLeft}px)`;
  }
  function renderMobileTabs() {
    /* Numeric indices match the desktop tab numbering and avoid font-dependent
       dingbats, which render differently on every Chinese IME/font stack. */
    const conf = [['map', ui('viewMap'), '01'], ['graph', ui('viewGraph'), '02'], ['table', ui('viewTable'), '03'], ['timeline', ui('viewTimeline'), '04'], ['insight', ui('viewInsight'), '05']];
    $('#mobileTabs').innerHTML = conf.map(([v, l, ico]) => `<button type="button" data-view="${v}" aria-pressed="${state.view === v}" class="${state.view === v ? 'is-on' : ''}"><span class="mt-ico">${ico}</span><span>${esc(l)}</span></button>`).join('');
  }

  function renderSearchMeta() {
    const n = filteredItems().length;
    $('#searchCount').textContent = (n === DATA.stats.items ? ui('totalPrefix') + ' ' : ui('matchedPrefix') + ' ') + n + ' ' + ui('countSuffix');
    $('#searchClear').hidden = !state.q;
    const tc = $('#toolbarCount');
    if (tc) tc.textContent = n + ' ' + ui('inScope');
  }

  /* Both the map and the table can end up with nothing to draw. Sharing one
     block keeps the copy and the two escape hatches identical. */
  function emptyStateHtml() {
    return `<div class="empty-state"><strong>${ui('noMatch')}</strong><span>${ui('noMatchHint')}</span><div class="empty-actions"><button type="button" data-action="clear-search">${ui('clearSearch')}</button><button type="button" data-action="reset-all">${ui('resetAll')}</button></div></div>`;
  }

  /* ---------- view 1: treemap ---------- */
  function clipLabel(text, w, fs) {
    const perChar = /[\u4e00-\u9fa5]/.test(text) ? fs * 1.02 : fs * 0.62;
    const chars = Math.max(3, Math.floor((w - 18) / perChar));
    return text.length > chars ? text.slice(0, chars - 1) + '…' : text;
  }
  /* SVG text does not wrap. On the largest tiles a two-line editorial note fills
     what used to be dead space; clipping is done by width, never by guesswork. */
  function wrapCJK(text, perLine, maxLines) {
    const s = String(text || '');
    const out = [];
    for (let i = 0; i < s.length && out.length < maxLines; i += perLine) out.push(s.slice(i, i + perLine));
    if (out.length === maxLines && s.length > perLine * maxLines) {
      out[maxLines - 1] = out[maxLines - 1].slice(0, Math.max(1, perLine - 1)) + '…';
    }
    return out;
  }
  function renderMap() {
    const body = $('#canvasBody');
    const visible = filteredItems();
    if (!visible.length) { body.innerHTML = emptyStateHtml(); return; }
    /* Shell first, then measure: the footer is part of the canvas now, so the
       treemap must be drawn into the box that is actually left for it. */
    body.innerHTML = '<div class="canvas-fill"><div class="canvas-main" id="canvasMain"></div><div class="canvas-foot" id="canvasFoot"></div></div>';
    const main = $('#canvasMain');
    const W = Math.max(320, main.clientWidth);
    const H = Math.max(360, main.clientHeight);
    const matched = new Set(visible.map((it) => it.id));
    const catMatched = new Set(visible.map((it) => it.categoryId));
    /* Same rule as the graph: a selected category means "show me this one".
       Dimming 26 of 27 tiles turned the canvas into a pale wash that read like a
       rendering failure, and it hid the thing the reader had just asked for. */
    const focusCat = state.drill || (state.cat !== 'all' ? state.cat : null);
    let entries;
    if (!focusCat) {
      entries = DATA.categories.map((c) => ({
        key: 'cat:' + c.id, label: catName(c), en: c.name,
        sub: c.itemCount + ' ' + ui('countSuffix') + ' · ' + (avgHealth(c.id) == null ? ui('noSample') : (isEn() ? 'health ' : '健康 ') + avgHealth(c.id)),
        subShort: c.itemCount + ' ' + ui('countSuffix'),
        note: isEn() ? '' : catNote(c),
        /* A 400px-tall tile with two lines of text at the top is mostly void.
           The inset lists the category's real headline repos, so the largest
           block carries data instead of emptiness. */
        top: enrichedOf(c.id).slice().sort((a, b) => b.metrics.stars - a.metrics.stars).slice(0, 4).map((it) => ({ name: it.name, stars: it.metrics.stars })),
        value: state.metric === 'stars' ? Math.log10(totalStarsOf(c.id) + 10) : c.itemCount,
        health: avgHealth(c.id),
        /* Any active filter has to be visible on the canvas. This used to be
           gated on `state.q`, so choosing a category in the sidebar or turning on
           「仅显示已验证仓库」 changed the counts but left the map untouched. */
        dim: !catMatched.has(c.id),
        tip: tipAttr(catName(c), [catNote(c), c.itemCount + ' ' + ui('countSuffix'), avgHealth(c.id) == null ? ui('noSample') : (isEn() ? 'avg health ' : '平均健康分 ') + avgHealth(c.id), (isEn() ? 'stars ' : '采样 Star ') + fmtAbbr(totalStarsOf(c.id), isEn())]),
        action: 'drill', id: c.id,
      }));
    } else {
      const cid = focusCat;
      entries = itemsOf(cid).map((it) => ({
        key: 'item:' + it.id, label: it.name, en: '',
        sub: it.metrics ? fmtAbbr(it.metrics.stars, isEn()) + ' ★ · ' + (isEn() ? 'health ' : '健康 ') + it.metrics.health : ui('noSample'),
        subShort: it.metrics ? fmtAbbr(it.metrics.stars, isEn()) + ' ★' : ui('noSample'),
        note: '',
        value: state.metric === 'stars' ? Math.log10((it.metrics ? it.metrics.stars : 0) + 10) : 1,
        health: it.metrics ? it.metrics.health : null,
        dim: !matched.has(it.id),
        tip: tipAttr(it.name, [catName(catById.get(cid)), it.level ? ui('subEntry') : ui('mainEntry'), it.metrics ? '★ ' + fmtAbbr(it.metrics.stars, isEn()) + ' · ' + (isEn() ? 'health ' : '健康 ') + it.metrics.health : ui('noSample')]),
        action: 'select', id: it.id,
      }));
    }
    entries.sort((a, b) => b.value - a.value);
    /* One domain per render, taken from the tiles on screen. */
    const dom = rampDomain(entries.map((e) => e.health));
    entries.forEach((e) => { e.color = healthColor(e.health, dom); });
    const tiles = treemap(entries, 0, 0, W, H);
    const dimmed = tiles.filter((t) => t.dim).length;
    const rects = tiles.map((t) => {
      const gap = Math.min(3, Math.max(1, Math.min(t.w, t.h) * 0.02));
      const x = t.x + gap, y = t.y + gap, w = Math.max(0, t.w - gap * 2), h = Math.max(0, t.h - gap * 2);
      if (w < 2 || h < 2) return '';
      /* Below ~58px a Chinese category name can only survive as an ellipsis
         fragment, which reads as a bug. Hide it and keep the tile as a block. */
      const fs = w > 230 ? 17 : w > 150 ? 14.5 : w > 96 ? 12 : w > 62 ? 10.5 : 9;
      const need = t.label.length * fs + 18;
      /* A narrow but tall sliver is the one case where a truncated name hurts
         most, and the one case where a rotated label fits perfectly. */
      const vertical = need > w && h > need + 16;
      /* A name only appears if it fits whole: an ellipsis fragment of a Chinese
         category name reads as a rendering bug, not as an abbreviation. */
      const showName = vertical || (need <= w && w > 44 && h > 18);
      const showSub = !vertical && w > 96 && h > 52;
      const selected = state.selected === t.id;
      /* Narrow tiles get the bare count; only wide tiles can afford the health
         suffix without an ellipsis landing mid-word. */
      const baseSub = w > 158 ? t.sub : t.subShort;
      const x1 = x.toFixed(1), y1 = y.toFixed(1), w1 = w.toFixed(1), h1 = h.toFixed(1);
      const nameY = y + fs + 7;
      /* Very tall tiles anchor the metadata to the bottom edge so the name and
         the numbers frame the block instead of both crowding the top corner. */
      const subY = h > 210 ? y + h - 9 : nameY + 15;
      /* Rotated labels run along the tile height, so the clip budget is `h`,
         not `w` -- otherwise a long repo name spills into the tile below. */
      const nameEl = vertical
        ? `<text class="tile-label" x="${(x + 12).toFixed(1)}" y="${(y + h - 10).toFixed(1)}" font-size="${fs}" transform="rotate(-90 ${(x + 12).toFixed(1)} ${(y + h - 10).toFixed(1)})">${esc(clipLabel(t.label, h, fs))}</text>`
        : `<text class="tile-label ${fs >= 14 ? 'is-serif' : ''}" x="${(x + 8).toFixed(1)}" y="${nameY.toFixed(1)}" font-size="${fs}">${esc(clipLabel(t.label, w, fs))}</text>`;
      /* Room for a note only exists on genuinely large tiles; everywhere else the
         name plus the count is the whole story. */
      const noteLines = !vertical && t.note && w > 200 && h > 150
        ? wrapCJK(t.note, Math.max(6, Math.floor((w - 20) / 11)), 2)
        : [];
      /* The count line owns the slot directly under the name, so the note block
         starts below that slot. Starting it at nameY+20 printed the description
         on top of 「77 条 · 健康 64」. */
      const noteEl = noteLines.map((line, i) => `<text class="tile-note" x="${(x + 8).toFixed(1)}" y="${(nameY + 33 + i * 15).toFixed(1)}" font-size="10.5" fill-opacity=".85">${esc(line)}</text>`).join('');
      /* Only tiles with room get the inset; below this the four rows would
         collide with the note. Anchored to the bottom edge so the block frames
         the tile instead of floating in its middle. 220×240 was so strict that
         the second-largest tile sat half empty while the biggest one carried a
         list. */
      const insetRows = !vertical && t.top && w > 176 && h > 158 ? t.top : [];
      const insetEl = insetRows.map((it, i) => {
        const rowY = y + h - 26 - (insetRows.length - 1 - i) * 17;
        return `<text class="tile-sub" x="${(x + 8).toFixed(1)}" y="${rowY.toFixed(1)}" font-size="10" fill-opacity=".8">${esc(clipLabel(it.name, w * 0.58, 10))}</text>` +
          `<text class="tile-sub" x="${(x + w - 8).toFixed(1)}" y="${rowY.toFixed(1)}" font-size="10" text-anchor="end" fill-opacity=".72">${esc(fmtAbbr(it.stars, isEn()))} ★</text>`;
      }).join('');
      return `<g class="tile ${t.dim ? 'is-dim' : ''} ${selected ? 'is-selected' : ''}" data-action="${t.action}" data-id="${esc(t.id)}" data-tip="${t.tip}" tabindex="0" role="button" aria-label="${esc(t.label)}">
        <rect class="tile-bg" x="${x1}" y="${y1}" width="${w1}" height="${h1}" fill="${t.color}" stroke="var(--ink)" stroke-opacity=".16" stroke-width="1"/>
        ${showName ? nameEl : ''}
        ${noteEl}
        ${insetEl}
        ${showSub ? `<text class="tile-sub" x="${(x + 8).toFixed(1)}" y="${subY.toFixed(1)}" font-size="10.5" fill-opacity=".9">${esc(clipLabel(baseSub, w, 10.5))}</text>` : ''}
      </g>`;
    }).join('');
    main.innerHTML = `<svg class="treemap-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="${isEn() ? 'Treemap of categories and lists' : '分类与清单的树状地图'}">${rects}</svg>`;
    $('#canvasFoot').innerHTML = `<p class="canvas-note">${state.metric === 'stars'
      ? (isEn() ? 'Area uses a log scale of sampled stars so a few mega-repos do not swallow the map.' : '面积按采样 Star 的对数缩放，避免个别超级项目吞掉整张图。')
      : (isEn() ? `Area = number of lists; colour = health relative to the ${dom[0]}–${dom[1]} on screen; grey = no sampled metrics.` : `面积按清单条目数；颜色按当前视图 ${dom[0]}–${dom[1]} 区间内的相对健康分，灰色表示没有健康分采样。`)}${dimmed
      ? (isEn() ? ` ${dimmed} tiles outside the current filter are dimmed.` : ` 当前筛选外的 ${dimmed} 个瓦片已淡化。`)
      : ''}</p>${scaleHtml(dom)}`;
  }
  /* The same key serves the map and the graph, both of which colour by health.
     The domain is passed in rather than assumed, so the caption always matches
     the values that were actually painted. */
  function scaleHtml(domain) {
    const [lo, hi] = domain || healthDomain();
    return `<div class="map-scale"><span>${ui('mapScale')}</span><span class="map-scale-track" style="background:${rampGradient()}"></span><span class="map-scale-cap">${Math.round(lo)} – ${Math.round(hi)}</span></div>`;
  }

  /* ---------- hero plate ---------- */
  /* Not a decorative image: the same treemap algorithm, the same counts and the
     same health ramp as the workspace map, so the fold shows exactly what the
     click-through delivers. The plate only labels tiles big enough to hold a
     name; everything else stays a block with a hover title. */
  function renderHeroPlate() {
    const host = $('#heroPlateMap');
    if (!host) return;
    const W = 340, H = 300;
    const entries = DATA.categories
      .map((c) => ({ key: c.id, label: catName(c), value: c.itemCount, health: avgHealth(c.id), count: c.itemCount }))
      .sort((a, b) => b.value - a.value);
    const focus = state.cat !== 'all' ? state.cat : null;
    const plateDomain = categoryDomain();
    const cells = treemap(entries, 0, 0, W, H).map((t) => {
      const gap = 2;
      const x = t.x + gap, y = t.y + gap, w = Math.max(0, t.w - gap * 2), h = Math.max(0, t.h - gap * 2);
      if (w < 2 || h < 2) return '';
      const fs = w > 126 ? 11 : w > 78 ? 9.5 : 8;
      const showName = w > 60 && h > 26;
      return `<g class="plate-tile ${focus === t.key ? 'is-focus' : ''}"><title>${esc(t.label)} · ${t.count} ${isEn() ? 'lists' : '条'}</title>
        <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${healthColor(t.health, plateDomain)}" stroke="var(--surface)" stroke-width="1.2"/>
        ${showName ? `<text x="${(x + 5).toFixed(1)}" y="${(y + fs + 5).toFixed(1)}" font-size="${fs}">${esc(clipLabel(t.label, w, fs))}</text>` : ''}
      </g>`;
    }).join('');
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-hidden="true">${cells}</svg>`;
  }

  /* ---------- view 2: radial graph ---------- */
  function renderGraph() {
    const body = $('#canvasBody');
    body.innerHTML = '<div class="canvas-fill"><div class="canvas-main" id="canvasMain"></div><div class="canvas-foot" id="canvasFoot"></div></div>';
    const main = $('#canvasMain');
    const W = Math.max(340, main.clientWidth);
    const H = Math.max(360, main.clientHeight);
    const cx = W / 2, cy = H / 2;
    const R = Math.min(W, H) * 0.35;
    const cats = DATA.categories;
    const visibleCats = state.cat === 'all' ? cats : cats.filter((c) => c.id === state.cat);
    const matched = new Set(filteredItems().map((it) => it.id));
    let spokes = '', links = '', labels = '', nodes = '', catNodes = '', orbits = '';
    const labelItems = [];
    let pointCount = 0;
    /* Two rings only: the inner one is a reading guide, the outer one passes
       through the 27 category nodes. A third ring outside the label radius just
       drew a line through the labels, so it is gone. */
    [R * 0.66, R].forEach((r) => { orbits += `<circle class="graph-orbit" cx="${cx}" cy="${cy}" r="${r.toFixed(1)}"/>`; });

    visibleCats.forEach((c, ci) => {
      const single = visibleCats.length === 1;
      const angle = single ? -Math.PI / 2 : (ci / visibleCats.length) * Math.PI * 2 - Math.PI / 2;
      const px = single ? cx : cx + Math.cos(angle) * R;
      const py = single ? cy : cy + Math.sin(angle) * R;
      if (!single) {
        spokes += `<line class="graph-spoke" x1="${cx}" y1="${cy}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}"/>`;
        /* Collect first, place later. Several Chinese category names land within a
           few degrees of each other near the vertical axis, so a single radial
           radius can never keep them apart on its own. The radius also sits one
           dot-cluster clear of R so labels stop sharing space with the nodes. */
        const lr = R + 50 + (ci % 2 ? 16 : 0);
        labelItems.push({
          x: cx + Math.cos(angle) * lr,
          y: cy + Math.sin(angle) * lr,
          anchor: Math.cos(angle) > 0.25 ? 'start' : Math.cos(angle) < -0.25 ? 'end' : 'middle',
          text: clipLabel(catName(c), 150, 11),
        });
      }
      let list = itemsOf(c.id).filter((it) => it.url);
      if (state.scope === 'favorites') list = list.filter((it) => favorites.has(it.id));
      if (state.scope === 'enriched') list = list.filter((it) => it.metrics);
      if (state.scope === 'curated') list = list.filter((it) => it.metrics).sort((a, b) => b.metrics.stars - a.metrics.stars).slice(0, 10);
      if (state.scope === 'all') list = list.slice(0, 20);
      if (state.q) list = list.filter((it) => matched.has(it.id));
      const showLinks = list.length <= 14;
      const catR = single ? 9 : 5 + Math.min(7, Math.sqrt(c.itemCount));
      catNodes += `<g class="graph-node" data-action="filter-cat" data-id="${esc(c.id)}" data-tip="${tipAttr(catName(c), [c.itemCount + ' ' + ui('countSuffix'), isEn() ? 'click to focus' : '点击聚焦该分类'])}" tabindex="0" role="button" aria-label="${esc(catName(c))} · ${c.itemCount} ${ui('countSuffix')}"><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${catR.toFixed(1)}" fill="${healthColor(avgHealth(c.id))}" stroke="var(--surface)" stroke-width="2"/></g>`;

      list.forEach((it, i) => {
        const a = single ? i * 2.39996 : i * 2.39996 + angle;
        const rr = (single ? 26 : 14) + Math.sqrt(i) * (single ? 12 : 9.5);
        const nx = px + Math.cos(a) * rr;
        const ny = py + Math.sin(a) * rr;
        const r = it.metrics ? Math.max(1.8, Math.min(6.5, 1.8 + Math.sqrt(it.metrics.stars) / 45)) : 1.9;
        if (showLinks) links += `<line class="graph-link" x1="${px.toFixed(1)}" y1="${py.toFixed(1)}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}"/>`;
        const selected = state.selected === it.id;
        nodes += `<g class="graph-node ${selected ? 'is-selected' : ''}" data-action="select" data-id="${esc(it.id)}" data-tip="${tipAttr(it.name, [catName(c), it.metrics ? '★ ' + fmtAbbr(it.metrics.stars, isEn()) + ' · ' + (isEn() ? 'health ' : '健康 ') + it.metrics.health : ui('noSample')])}"><circle cx="${nx.toFixed(1)}" cy="${ny.toFixed(1)}" r="${r.toFixed(1)}" fill="${healthColor(it.metrics ? it.metrics.health : null)}" fill-opacity="${it.metrics ? '.9' : '.5'}"/></g>`;
        pointCount += 1;
      });
    });

    /* Label layout pass: group by text-anchor, sort by y, enforce a 14px baseline
       gap, then shift the whole group back inside the viewport so nothing clips. */
    labels = ['start', 'middle', 'end'].map((anchor) => {
      const group = labelItems.filter((it) => it.anchor === anchor).sort((a, b) => a.y - b.y);
      const MIN = 14;
      for (let i = 1; i < group.length; i += 1) {
        group[i].y = Math.max(group[i].y, group[i - 1].y + MIN);
      }
      const last = group.length - 1;
      if (last >= 0 && group[last].y > H - 12) {
        group[last].y = H - 12;
        for (let i = last - 1; i >= 0; i -= 1) group[i].y = Math.min(group[i].y, group[i + 1].y - MIN);
      }
      if (group.length && group[0].y < 14) {
        group[0].y = 14;
        for (let i = 1; i < group.length; i += 1) group[i].y = Math.max(group[i].y, group[i - 1].y + MIN);
      }
      return group.map((it) => `<text class="graph-cat-label" x="${it.x.toFixed(1)}" y="${it.y.toFixed(1)}" text-anchor="${it.anchor}">${esc(it.text)}</text>`).join('');
    }).join('');

    /* The donut hole is a large empty area, so it carries the reading key instead
       of nothing. When one category is focused, the centre names it. */
    const focused = state.cat === 'all' ? null : cats.find((c) => c.id === state.cat);
    const coreText = focused ? clipLabel(catName(focused), 116, 11) : (isEn() ? 'awesome' : '总索引');
    const coreNote = focused
      ? `${focused.itemCount} ${ui('countSuffix')}`
      : `${cats.length} ${isEn() ? 'categories' : '个分类'} · ${DATA.items.length} ${ui('countSuffix')}`;
    const guide = R >= 150
      ? `<text class="graph-guide" x="${cx}" y="${cy + 52}" text-anchor="middle">${coreNote}</text>`
        + `<text class="graph-guide" x="${cx}" y="${cy + 70}" text-anchor="middle">${isEn() ? 'one dot = one list' : '每个圆点 = 一条清单'}</text>`
        + `<text class="graph-guide" x="${cx}" y="${cy + 88}" text-anchor="middle">${isEn() ? 'colour = health · area = stars' : '颜色 = 健康分 · 面积 = Star'}</text>`
      : '';
    const core = `<circle class="graph-core" cx="${cx}" cy="${cy}" r="27" fill="var(--ink)"/><text class="graph-center-label" x="${cx}" y="${cy + 4}" text-anchor="middle" fill="var(--paper)">${esc(coreText)}</text>${guide}`;
    main.innerHTML = `<svg class="graph-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="${isEn() ? 'Radial graph of categories and lists' : '分类与清单的径向关系图谱'}">${orbits}${spokes}${links}${catNodes}${nodes}${labels}${core}</svg>`;
    $('#canvasFoot').innerHTML = `<p class="canvas-note">${isEn() ? `${pointCount} dots shown.` : `当前显示 ${pointCount} 个圆点。`}${state.scope === 'curated' ? (isEn() ? ' Default shows the 10 highest-starred verified lists per category.' : ` 默认每类只画 Star 最高的 10 个已验证清单，避免 ${DATA.items.length} 条清单糊成一团。`) : ''}${isEn() ? ' Colour is paired with text labels, never used alone.' : ' 颜色同时配有文字提示，不单独依赖颜色编码。'}</p>${scaleHtml()}`;
  }

  /* ---------- view 3: table ---------- */
  function renderTable() {
    const body = $('#canvasBody');
    let list = filteredItems().slice();
    const numKey = (it, k) => {
      if (k === 'stars') return it.metrics ? it.metrics.stars : -1;
      if (k === 'health') return it.metrics ? it.metrics.health : -1;
      if (k === 'updated') return it.metrics ? new Date(it.metrics.pushedAt).getTime() : 0;
      if (k === 'created') return it.metrics ? -new Date(it.metrics.createdAt).getTime() : 0;
      if (k === 'stale') return it.metrics ? -new Date(it.metrics.pushedAt).getTime() : 0;
      return null;
    };
    if (['stars', 'health', 'updated', 'created', 'stale'].includes(state.sort)) {
      list.sort((a, b) => numKey(b, state.sort) - numKey(a, state.sort));
    } else if (state.sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => a.category.localeCompare(b.category) || a.index - b.index);

    const per = 40;
    const pages = Math.max(1, Math.ceil(list.length / per));
    if (state.page > pages) state.page = pages;
    const rows = list.slice((state.page - 1) * per, state.page * per);
    const tr = rows.map((it) => {
      const m = it.metrics;
      const d = descOf(it);
      const desc = d.main || (isEn() ? '' : (d.hint ? ui('hintLabel') : '该条目在源清单中没有描述'));
      const sub = d.orig ? `${esc(desc)} <em>· ${esc(d.orig)}</em>` : esc(desc);
      return `<tr class="${state.selected === it.id ? 'is-selected' : ''}" data-action="select" data-id="${esc(it.id)}" tabindex="0">
        <td><button class="star-btn ${favorites.has(it.id) ? 'is-on' : ''}" type="button" data-action="fav" data-id="${esc(it.id)}" aria-label="${ui('fav')} ${esc(it.name)}">${favorites.has(it.id) ? '★' : '☆'}</button></td>
        <td class="td-name"><strong>${esc(it.name)}</strong><small>${sub}</small></td>
        <td><span class="cat-tag">${esc(catName(catById.get(it.categoryId)))}</span></td>
        <td class="td-num col-star">${m ? fmtAbbr(m.stars, isEn()) : '<span class="muted">—</span>'}</td>
        <td class="td-num col-updated">${m ? dateOnly(m.pushedAt) : `<span class="muted">${ui('noSample')}</span>`}</td>
        <td>${m ? `<div class="health-cell"><div class="health-track"><div class="health-fill" style="width:${m.health}%;background:${scoreColor(m.health)}"></div></div><span class="health-num">${m.health}</span></div>` : '<span class="muted">—</span>'}</td>
        <td>${it.url ? `<a class="ext-link" href="${safeUrl(it.url)}" target="_blank" rel="noopener noreferrer" aria-label="${ui('openGithub')} ${esc(it.name)}" title="${isEn() ? 'External GitHub link' : '外链：GitHub（境外站点，打开可能较慢）'}" onclick="event.stopPropagation()"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>` : ''}</td>
      </tr>`;
    }).join('');

    body.innerHTML = list.length
      ? `<div class="table-wrap"><table><thead><tr><th></th><th>${ui('nameDescCol')}</th><th>${ui('catCol')}</th><th class="col-star">Star</th><th class="col-updated">${ui('updatedCol')}</th><th>${ui('healthCol')}</th><th></th></tr></thead><tbody>${tr}</tbody></table>
        <div class="pager"><button type="button" data-action="page" data-id="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>${ui('prev')}</button><span>${state.page} / ${pages} · ${isEn() ? 'total' : '共'} ${list.length} ${ui('countSuffix')}</span><button type="button" data-action="page" data-id="${state.page + 1}" ${state.page >= pages ? 'disabled' : ''}>${ui('next')}</button></div></div>`
      : emptyStateHtml();
  }

  /* ---------- view 4: timeline ---------- */
  function renderTimeline() {
    const body = $('#canvasBody');
    const snapshots = HISTORY.snapshots || [];
    const series = HISTORY.series || [];
    const sampled = filteredItems().filter((it) => it.metrics && it.metrics.pushedAt);
    const now = new Date();
    const months = [];
    for (let i = 17; i >= 0; i -= 1) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), label: (d.getMonth() + 1) + '月', count: 0 });
    }
    for (const it of sampled) {
      const m = months.find((x) => x.key === String(it.metrics.pushedAt).slice(0, 7));
      if (m) m.count += 1;
    }
    const maxCount = Math.max(1, ...months.map((m) => m.count));
    const bars = months.map((m) => `<div class="hist-col" style="height:${Math.max(2, (m.count / maxCount) * 100)}%" title="${esc(m.key)}：${m.count} ${isEn() ? 'repos pushed' : '个仓库有更新'}"></div>`).join('');

    /* Second histogram, same grammar: how old is this ecosystem. Without it the
       right column ended 500px above the commit list and the view looked halved. */
    const years = [];
    for (const it of sampled) {
      const y = String(it.metrics.createdAt).slice(0, 4);
      const hit = years.find((x) => x.key === y);
      if (hit) hit.count += 1; else years.push({ key: y, count: 1 });
    }
    years.sort((a, b) => a.key.localeCompare(b.key));
    const maxYear = Math.max(1, ...years.map((y) => y.count));
    const yearBars = years.map((y) => `<div class="hist-col" style="height:${Math.max(2, (y.count / maxYear) * 100)}%" title="${esc(y.key)}：${y.count} ${isEn() ? 'repos created' : '个仓库创建'}"></div>`).join('');
    const yearFigure = years.length
      ? `<h3 class="tl-title" style="margin-top:var(--s5)">${isEn() ? 'Repository age' : '仓库创建年份分布'}</h3>
        <p class="tl-desc">${isEn() ? `Creation year of the ${sampled.length} verified repositories.` : `${sampled.length} 个已验证仓库的创建年份，用来判断这份索引的年龄结构。`}</p>
        <div class="hist-chart">${yearBars}</div><div class="hist-axis"><span>${esc(years[0].key)}</span><span>${esc(years[years.length - 1].key)}</span></div>`
      : '';

    // Growth curve from real README revisions.
    const gw = 460, gh = 132;
    let growth = '';
    if (series.length > 1) {
      const vals = series.map((s) => s.total);
      const lo = Math.min(...vals) - 4, hi = Math.max(...vals) + 4;
      const pts = vals.map((v, i) => [i / (vals.length - 1) * gw, gh - 12 - ((v - lo) / (hi - lo || 1)) * (gh - 26)]);
      const line = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      const area = `0,${gh} ${line} ${gw},${gh}`;
      const last = pts[pts.length - 1];
      growth = `<div class="growth-card"><div class="tl-title">${isEn() ? 'Lists in the README over time' : 'README 收录清单数量变化'}</div>
        <p class="tl-desc">${isEn() ? `${series.length} real revisions over ${HISTORY.summary?.spanDays || 0} days; net ${HISTORY.summary?.netChange || 0}.` : `来自 ${series.length} 个真实历史版本，跨度 ${HISTORY.summary?.spanDays || 0} 天，净变化 ${HISTORY.summary?.netChange || 0} 条。`}</p>
        <svg class="growth-svg" viewBox="0 0 ${gw} ${gh}" preserveAspectRatio="none">
        <polygon points="${area}" fill="var(--accent)" fill-opacity=".1"/><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" fill="var(--accent)" stroke="var(--paper)" stroke-width="2"/></svg>
        <div class="growth-axis"><span>${dateOnly(series[0].date)}</span><span>${dateOnly(series[series.length - 1].date)} · ${vals[vals.length - 1]} ${ui('countSuffix')}</span></div></div>`;
    }

    const events = snapshots.filter((s) => s.added.length || s.removed.length || s.relinked.length).slice(0, 9);
    const plain = snapshots.filter((s) => !s.added.length && !s.removed.length && !s.relinked.length).slice(0, 3);
    const eventHtml = events.concat(plain).map((s) => {
      const chips = [
        ...s.added.slice(0, 3).map((x) => `<span class="add">+ ${esc(x.name)}</span>`),
        ...s.removed.slice(0, 3).map((x) => `<span class="del">− ${esc(x.name)}</span>`),
        ...s.relinked.slice(0, 2).map((x) => `<span class="relink">↗ ${esc(x.name)}</span>`),
      ].join('');
      const more = (s.added.length + s.removed.length + s.relinked.length) > 8 ? `<span>+${s.added.length + s.removed.length + s.relinked.length - 8}</span>` : '';
      return `<li class="commit-item ${chips ? '' : 'is-neutral'}"><div class="commit-msg">${esc(isEn() ? s.message : s.messageZh)}</div>
        <div class="commit-meta">${esc(cnDate(s.date, isEn()))} · ${esc(s.sha)} · ${esc(s.author)}</div>${chips ? `<div class="commit-diff">${chips}${more}</div>` : ''}</li>`;
    }).join('');

    /* 16 rows, not 8: the ranked list is the actionable half of this view and the
       column was ending several hundred pixels above the commit list. */
    const stale = sampled.slice().sort((a, b) => new Date(a.metrics.pushedAt) - new Date(b.metrics.pushedAt)).slice(0, 16);
    body.innerHTML = `<div class="tl-grid">
      <div class="tl-panel">${growth}<h3 class="tl-title">${isEn() ? 'What actually changed upstream' : '上游 README 真实增删'}</h3>
        <p class="tl-desc">${isEn() ? 'Diffed from historical README revisions, not guessed from commit messages.' : '对 24 个历史版本逐版解析清单后做差异比对，不是靠提交标题猜测。点击条目名可看详情。'}</p>
        <ul class="commit-list">${eventHtml || '<li class="commit-item"><div class="commit-msg">暂无变更数据</div></li>'}</ul></div>
      <div class="tl-panel"><h3 class="tl-title">${isEn() ? 'Recent push distribution' : '已验证仓库的最近 push 分布'}</h3>
        <p class="tl-desc">${isEn() ? `Monthly last-push dates for ${sampled.length} verified repositories.` : `按月份统计 ${sampled.length} 个已验证仓库的最近推送时间，用于观察整个生态的活跃度。`}</p>
        <div class="hist-chart">${bars}</div><div class="hist-axis"><span>${esc(months[0].key)}</span><span>${esc(months[months.length - 1].key)}</span></div>
        ${yearFigure}
        <h3 class="tl-title" style="margin-top:var(--s5)">${isEn() ? 'Longest without a push' : '最久未更新的清单'}</h3><p class="tl-desc">${isEn() ? 'Click to open the repository profile.' : '点击可在右侧展开仓库画像。'}</p>
        <ul class="stale-list">${stale.map((it) => `<li><button type="button" data-action="select" data-id="${esc(it.id)}"><span class="stale-name">${esc(it.name)}</span><span class="stale-date">${esc(dateOnly(it.metrics.pushedAt))}</span></button></li>`).join('') || `<li class="muted">${ui('noSample')}</li>`}</ul></div>
    </div>`;
  }

  /* ---------- view 5: insight dashboard ---------- */
  function renderInsightView() {
    const body = $('#canvasBody');
    const bar = (label, value, max, color, display, action, id) => `<div class="iv-bar-row">${action
      ? `<button class="iv-bar-label" style="border:0;background:transparent;color:var(--ink-2);text-align:left;padding:0;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" type="button" data-action="${action}" data-id="${esc(id)}" title="${esc(label)}">${esc(label)}</button>`
      : `<span class="iv-bar-label" title="${esc(label)}">${esc(label)}</span>`}
      <div class="iv-bar-track"><div class="iv-bar-fill" style="width:${Math.max(2, (value / max) * 100)}%;background:${color}"></div></div>
      <span class="iv-bar-value">${esc(display)}</span></div>`;

    const byStars = DATA.categories.slice().sort((a, b) => totalStarsOf(b.id) - totalStarsOf(a.id)).slice(0, 8);
    const maxStars = Math.max(1, ...byStars.map((c) => totalStarsOf(c.id)));
    const starBars = byStars.map((c) => bar(catName(c), totalStarsOf(c.id), maxStars, 'var(--accent)', fmtAbbr(totalStarsOf(c.id), isEn()), 'insight-stars', c.id)).join('');

    const buckets = Array.from({ length: 10 }, (_, i) => ({ label: i * 10 + '-' + (i * 10 + 9), count: 0 }));
    for (const it of VERIFIED) buckets[Math.min(9, Math.floor(it.metrics.health / 10))].count += 1;
    const maxBucket = Math.max(1, ...buckets.map((b) => b.count));
    const bucketHtml = buckets.map((b, i) => `<div class="iv-bucket" title="${b.label} 分：${b.count} ${ui('countSuffix')}"><i style="height:${(b.count / maxBucket) * 88}%;background:${healthColor(i * 10 + 10)}"></i><span>${i * 10}</span></div>`).join('');

    const topLangs = [...LANG_COUNT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const topLicenses = [...LICENSE_COUNT.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

    const watch = VERIFIED.filter((it) => it.metrics.archived || daysSince(it.metrics.pushedAt) > 730)
      .sort((a, b) => new Date(a.metrics.pushedAt) - new Date(b.metrics.pushedAt)).slice(0, 12);
    const watchHtml = watch.map((it) => `<li><button type="button" data-action="select" data-id="${esc(it.id)}">${esc(it.name)}${it.metrics.archived ? ` · ${ui('archived')}` : ''}</button><span>${esc(dateOnly(it.metrics.pushedAt))}</span></li>`).join('') || `<li class="muted">${isEn() ? 'None' : '暂无'}</li>`;
    const freshPct = VERIFIED.length ? Math.round((recentlyPushed / VERIFIED.length) * 100) : 0;

    body.innerHTML = `<div class="iv-grid">
      <div class="iv-card"><h3>${isEn() ? 'Where the stars are' : 'Star 都集中在哪'}</h3><p class="iv-sub">${isEn() ? 'Sampled stars by category · click to open the map' : '按分类汇总采样 Star，点击可跳到分类地图'}</p>${starBars}</div>
      <div class="iv-card"><h3>${isEn() ? 'Health score distribution' : '健康分分布'}</h3><p class="iv-sub">${isEn() ? `${VERIFIED.length} verified repos · ${freshPct}% pushed within a year` : `${VERIFIED.length} 个已验证仓库 · 近一年有更新占 ${freshPct}%`}</p><div class="iv-buckets">${bucketHtml}</div></div>
      <div class="iv-card"><h3>${isEn() ? 'Languages & licenses' : '语言与许可偏好'}</h3><p class="iv-sub">${isEn() ? 'Primary language reported by the GitHub API' : '取自 GitHub API 的仓库主语言与 SPDX 许可标识'}</p>
        <div class="iv-tag-cloud">${topLangs.map(([k, v]) => `<span class="iv-tag">${esc(k)}<b>${v}</b></span>`).join('') || '<span class="muted">—</span>'}</div>
        <p class="iv-sub" style="margin:14px 0 9px">${isEn() ? 'Top licenses' : '常见许可'}</p>
        <div class="iv-tag-cloud">${topLicenses.map(([k, v]) => `<span class="iv-tag">${esc(k)}<b>${v}</b></span>`).join('') || '<span class="muted">—</span>'}</div></div>
      <div class="iv-card"><h3>${isEn() ? 'Lists worth a second look' : '需要留意的清单'}</h3><p class="iv-sub">${isEn() ? `${ARCHIVED.length} archived, ${watch.length} shown by staleness. Click for details.` : `${ARCHIVED.length} 份已归档，按停滞时长列出前 ${watch.length} 份。点击可看详情。`}</p>
        <ul class="iv-mini-list">${watchHtml}</ul></div>
    </div>`;
  }

  /* ---------- detail ---------- */
  /* The right rail is tall; an illustration plus one sentence leaves most of it
     blank. Fill the lower half with the three biggest lists in the current scope
     so the panel is useful before anything is selected. */
  function renderEmptyContext() {
    const host = $('#detailEmptyContext');
    if (!host) return;
    const cat = state.cat === 'all' ? null : catById.get(state.cat);
    /* Follows the same filter as the canvas: a search that matches nothing must
       not leave an unrelated 「此处 Star 最高」 list in the rail. */
    const list = filteredItems()
      .filter((it) => it.metrics)
      .sort((a, b) => b.metrics.stars - a.metrics.stars)
      .slice(0, 3);
    if (!list.length) { host.innerHTML = ''; return; }
    const head = `<div class="empty-context-head"><span>${isEn() ? 'Most starred here' : '此处 Star 最高'}</span><span class="empty-context-scope">${esc(cat ? catName(cat) : ui('all'))}</span></div>`;
    host.innerHTML = head + list.map((it) => `<button class="empty-row" type="button" data-action="select" data-id="${esc(it.id)}"><span class="empty-row-name">${esc(it.name)}</span><span class="empty-row-num">${fmtAbbr(it.metrics.stars, isEn())}</span></button>`).join('');
  }

  function renderDetail() {
    const it = state.selected ? itemById.get(state.selected) : null;
    const empty = $('#detailEmpty'), content = $('#detailContent');
    if (!it) { empty.hidden = false; content.hidden = true; content.innerHTML = ''; renderEmptyContext(); return; }
    empty.hidden = true; content.hidden = false;
    const m = it.metrics;
    const parent = it.parentId ? itemById.get(it.parentId) : null;
    const children = (it.children || []).map((id) => itemById.get(id)).filter(Boolean);
    const d = descOf(it);

    let metricsHtml;
    if (!m) {
      metricsHtml = `<div class="no-metrics">${it.availability === 'unavailable'
        ? (isEn() ? 'This repository no longer resolves on GitHub. The link is kept for traceability.' : '该仓库在 GitHub 上已无法解析（可能删除或转为私有）。本站保留原链接以便追溯，不会把它当作 0 分。')
        : (isEn() ? 'This entry is not a GitHub repository, so no metrics apply.' : '该条目不是 GitHub 仓库（可能是分组标签或站点页面），因此没有仓库指标。源链接与描述仍然完整可用。')}</div>`;
    } else {
      const parts = m.parts || { freshness: 0, popularity: 0, activity: 0 };
      const circ = 2 * Math.PI * 22;
      metricsHtml = `<div class="score-head"><svg class="score-ring" viewBox="0 0 54 54"><circle cx="27" cy="27" r="22" fill="none" stroke="var(--surface-3)" stroke-width="5"/><circle cx="27" cy="27" r="22" fill="none" stroke="${scoreColor(m.health)}" stroke-width="5" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${(circ * (1 - m.health / 100)).toFixed(1)}" transform="rotate(-90 27 27)"/><text x="27" y="31" text-anchor="middle" fill="${scoreColor(m.health)}" font-size="14" font-family="var(--font-mono)" font-weight="600">${m.health}</text></svg>
        <div class="score-head-txt"><span class="score-big" style="color:${scoreColor(m.health)}">${m.health}</span><span class="score-unit">${isEn() ? '/ 100 health score' : '/ 100 综合健康分'}</span></div></div>
        ${[['新鲜度', 'Freshness', parts.freshness], ['热度', 'Popularity', parts.popularity], ['活跃度', 'Activity', parts.activity]].map(([zhLabel, enLabel, v]) => `<div class="score-row"><span>${isEn() ? enLabel : zhLabel}</span><div class="score-track"><div class="score-fill" style="width:${v}%;background:${healthColor(v)}"></div></div><b>${v}</b></div>`).join('')}
        <div class="kv-grid" style="margin-top:16px">
          <div class="kv"><div class="kv-label">Star</div><div class="kv-value">${fmtAbbr(m.stars, isEn())}</div></div>
          <div class="kv"><div class="kv-label">Fork</div><div class="kv-value">${fmtInt(m.forks)}</div></div>
          <div class="kv"><div class="kv-label">${isEn() ? 'Last push' : '最近 push'}</div><div class="kv-value">${esc(dateOnly(m.pushedAt))}</div></div>
          <div class="kv"><div class="kv-label">${isEn() ? 'Age' : '距今'}</div><div class="kv-value">${esc(ago(m.pushedAt, isEn()))}</div></div>
          <div class="kv"><div class="kv-label">${isEn() ? 'Language' : '语言'}</div><div class="kv-value">${esc(m.language || '—')}</div></div>
          <div class="kv"><div class="kv-label">${isEn() ? 'License' : '许可'}</div><div class="kv-value">${esc(m.license || '—')}</div></div>
        </div>
        ${m.archived ? `<div class="tag-row" style="margin-top:12px"><span class="tag" style="color:var(--warn);border-color:var(--warn)">${ui('archived')}</span></div>` : ''}
        ${m.canonicalRepo ? `<div class="tag-row" style="margin-top:8px"><span class="tag">${isEn() ? 'Moved to ' : '仓库已迁移至 '}${esc(m.canonicalRepo)}</span></div>` : ''}
        ${m.topics && m.topics.length ? `<div class="tag-row" style="margin-top:12px">${m.topics.slice(0, 6).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
        ${m.description ? `<div class="repo-quote"><span>${isEn() ? 'Repository description (verbatim)' : '仓库自述 · 英文原文'}</span>${esc(m.description.slice(0, 180))}${m.description.length > 180 ? '…' : ''}</div>` : ''}`;
    }

    const descMain = d.main || (isEn() ? 'No description in the upstream list.' : '源清单未提供描述。');
    content.innerHTML = `<div class="detail-top"><div><div class="detail-kicker">${esc(catName(catById.get(it.categoryId)))} · ${it.level ? ui('subEntry') : ui('mainEntry')}</div><h3 class="detail-title">${esc(it.name)}</h3></div><button class="detail-close" type="button" data-action="close" aria-label="${ui('close')}">×</button></div>
      <p class="detail-desc">${esc(descMain)}${d.orig ? `<span class="orig">${esc(d.orig)}</span>` : ''}</p>
      ${d.hint && !isEn() ? `<div class="detail-hint-tag">${ui('hintLabel')}</div>` : ''}
      <div class="detail-actions">
        ${it.url ? `<a href="${safeUrl(it.url)}" target="_blank" rel="noopener noreferrer" title="${isEn() ? 'External link' : '外链：GitHub（境外站点，打开可能较慢）'}">${ui('openGithub')} ↗</a>` : ''}
        ${it.url ? `<button type="button" data-action="copy-link" data-id="${esc(it.id)}">${isEn() ? 'Copy link' : '复制链接'}</button>` : ''}
        <button type="button" data-action="fav" data-id="${esc(it.id)}" class="${favorites.has(it.id) ? 'is-on' : ''}">${favorites.has(it.id) ? '★ ' + ui('faved') : '☆ ' + ui('fav')}</button>
        <button type="button" data-action="export-card" data-id="${esc(it.id)}">${ui('cardBtn')}</button>
        <button type="button" data-action="focus-cat" data-id="${esc(it.categoryId)}">${ui('sameCat')}</button>
      </div>
      <div class="detail-section"><h4>${ui('metrics')}</h4>${metricsHtml}</div>
      <div class="detail-section"><h4>${ui('relations')}</h4><div class="kv-grid">
        <div class="kv"><div class="kv-label">${isEn() ? 'README line' : '源 README 行号'}</div><div class="kv-value">L${it.sourceLine}</div></div>
        <div class="kv"><div class="kv-label">${isEn() ? 'Entry type' : '条目类型'}</div><div class="kv-value">${it.kind === 'label' ? (isEn() ? 'Label' : '分组标签') : it.kind === 'link' ? (isEn() ? 'External link' : '外部链接') : (isEn() ? 'GitHub repo' : 'GitHub 仓库')}</div></div>
        <div class="kv"><div class="kv-label">${isEn() ? 'Parent' : '父条目'}</div><div class="kv-value">${parent ? esc(parent.name) : '—'}</div></div>
        <div class="kv"><div class="kv-label">${isEn() ? 'Children' : '子条目'}</div><div class="kv-value">${children.length} ${ui('countSuffix')}</div></div>
      </div>${children.length ? `<ul class="child-list" style="margin-top:12px">${children.map((c) => `<li><button type="button" data-action="select" data-id="${esc(c.id)}">↳ ${esc(c.name)}</button></li>`).join('')}</ul>` : ''}</div>`;
  }

  /* ---------- card export ---------- */
  /* One entry as a 1200×630 PNG, drawn with Canvas 2D in the same paper-and-ink
     system as the page. No screenshot service and no third-party request: these
     lists travel as chat attachments, and a card has to still make sense when
     the page is not around it. */
  const CARD_W = 1200, CARD_H = 630;
  const CARD_PAD = 64;
  const CARD_SANS = '"PingFang SC","HarmonyOS Sans SC","Microsoft YaHei","Noto Sans SC",-apple-system,sans-serif';
  const CARD_SERIF = '"Songti SC","Source Han Serif SC","Noto Serif SC","SimSun",Georgia,serif';
  const CARD_MONO = 'ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace';
  const CARD_PAPER = '#faf9f5', CARD_INK = '#141413', CARD_INK2 = '#4a4842', CARD_INK3 = '#6e6b63';
  const CARD_RULE = '#dedad0', CARD_RULE2 = '#c3beb2', CARD_ACCENT = '#a82d22', CARD_WARN = '#7d5210';
  /* The printed address has to be the public one: a card exported on localhost
     that says 127.0.0.1 is worse than useless once it is forwarded. */
  const CARD_SITE = (() => {
    const h = location.hostname;
    if (!h || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0') return 'odin1024.github.io/awesome-atlas';
    return (location.host + location.pathname).replace(/index\.html$/, '').replace(/\/$/, '');
  })();

  /* Canvas has no line-breaking. CJK has no spaces either, so splitting on
     whitespace would overflow every Chinese description; this tokenises Latin
     words whole and CJK one glyph at a time. */
  function wrapCanvasText(g, text, maxWidth, maxLines) {
    const tokens = String(text).match(/[A-Za-z0-9_.+\-#/@']+|\s+|./g) || [];
    const lines = [];
    let line = '';
    let cut = false;
    for (let i = 0; i < tokens.length; i += 1) {
      const tk = tokens[i];
      if (!line || g.measureText(line + tk).width <= maxWidth) { line += tk; continue; }
      lines.push(line.trimEnd());
      line = tk.trimStart();
      if (lines.length === maxLines) { cut = tokens.slice(i).join('').trim().length > 0; break; }
    }
    if (!cut && line.trim()) lines.push(line.trim());
    if (cut) {
      let last = lines[maxLines - 1] || '';
      while (last && g.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
      lines[maxLines - 1] = last + '…';
    }
    return lines;
  }
  function clipCanvasText(g, text, maxWidth) {
    if (g.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out && g.measureText(out + '…').width > maxWidth) out = out.slice(0, -1);
    return out + '…';
  }
  const cardTrack = (g, on) => { try { g.letterSpacing = on ? '1.6px' : '0px'; } catch (_) { /* older engines */ } };
  /* The card is always paper, so it samples the light ramp even when the reader
     has the dark theme on: a PNG is a print artifact, not a screen. */
  const cardRamp = (v) => {
    const t = Math.max(0, Math.min(100, v)) / 100 * (RAMP_LIGHT.length - 1);
    const i = Math.min(RAMP_LIGHT.length - 2, Math.floor(t));
    const k = t - i;
    return `rgb(${RAMP_LIGHT[i].map((c, j) => Math.round(c + (RAMP_LIGHT[i + 1][j] - c) * k)).join(',')})`;
  };

  function drawCard(it) {
    const en = isEn();
    const m = it.metrics;
    const cat = catById.get(it.categoryId);
    const cv = document.createElement('canvas');
    cv.width = CARD_W; cv.height = CARD_H;
    const g = cv.getContext('2d');

    g.fillStyle = CARD_PAPER;
    g.fillRect(0, 0, CARD_W, CARD_H);
    /* The hairline frame keeps the page's rule language when the PNG lands on a
       white slide or a dark chat bubble. */
    g.strokeStyle = CARD_RULE2; g.lineWidth = 1;
    g.strokeRect(23.5, 23.5, CARD_W - 47, CARD_H - 47);

    cardTrack(g, true);
    g.font = `500 12px ${CARD_MONO}`;
    g.fillStyle = CARD_ACCENT;
    g.fillRect(CARD_PAD, 66, 26, 2);
    g.fillText(en ? 'AWESOME ATLAS' : 'AWESOME ATLAS · 精选清单地图', CARD_PAD + 36, 75);
    g.textAlign = 'right';
    g.font = `12px ${CARD_MONO}`;
    g.fillStyle = CARD_INK3;
    g.fillText(clipCanvasText(g, cat ? catName(cat) : '', 420), CARD_W - CARD_PAD, 75);
    g.textAlign = 'left';
    cardTrack(g, false);

    if (m && m.archived) {
      g.font = `11px ${CARD_MONO}`;
      const label = en ? 'ARCHIVED' : '已归档';
      const w = g.measureText(label).width + 20;
      g.strokeStyle = CARD_WARN;
      g.strokeRect(CARD_W - CARD_PAD - w + .5, 96.5, w, 24);
      g.fillStyle = CARD_WARN;
      g.textAlign = 'right';
      g.fillText(label, CARD_W - CARD_PAD - 10, 113);
      g.textAlign = 'left';
    }

    /* Shrink until the name fits one line, then allow a second line. A 40-glyph
       repo name at 58px would otherwise run under the frame. */
    let size = 58;
    g.font = `700 ${size}px ${CARD_SERIF}`;
    while (size > 34 && g.measureText(it.name).width > CARD_W - CARD_PAD * 2) {
      size -= 2;
      g.font = `700 ${size}px ${CARD_SERIF}`;
    }
    const titleLines = wrapCanvasText(g, it.name, CARD_W - CARD_PAD * 2, 2);
    let y = 162;
    g.fillStyle = CARD_INK;
    for (const ln of titleLines) { g.fillText(ln, CARD_PAD, y); y += size * 1.18; }

    const urlText = String(it.url || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (urlText) {
      g.font = `14px ${CARD_MONO}`;
      g.fillStyle = CARD_INK3;
      g.fillText(clipCanvasText(g, urlText, CARD_W - CARD_PAD * 2), CARD_PAD, y + 12);
      y += 46;
    } else {
      /* A label entry has no URL. Printing a lone dash there reads like a
         missing value, so the line is dropped and the description moves up. */
      y += 18;
    }

    const desc = (descOf(it).main || '').replace(/\s+/g, ' ').trim();
    let bottom = y;
    if (desc) {
      g.font = `19px ${CARD_SANS}`;
      g.fillStyle = CARD_INK2;
      let dy = y + 8;
      for (const ln of wrapCanvasText(g, desc, CARD_W - CARD_PAD * 2 - 24, 2)) {
        g.fillText(ln, CARD_PAD, dy);
        dy += 31;
      }
      bottom = dy - 31;
    }

    /* The three health components, as three thin bars. This fills the plate's
       middle with the same numbers the detail panel shows instead of leaving
       200px of blank paper; when a two-line title and description already reach
       the band it is skipped rather than squeezed. */
    if (m && m.parts) {
      const partsTop = bottom + 40;
      if (partsTop + 46 <= 404) {
        const cells = [
          [en ? 'FRESHNESS' : '新鲜度', m.parts.freshness || 0],
          [en ? 'POPULARITY' : '热度', m.parts.popularity || 0],
          [en ? 'ACTIVITY' : '活跃度', m.parts.activity || 0],
        ];
        const gap = 24;
        const colW = (CARD_W - CARD_PAD * 2 - gap * 2) / 3;
        cells.forEach(([label, v], i) => {
          const x = CARD_PAD + i * (colW + gap);
          g.font = `11px ${CARD_MONO}`;
          g.fillStyle = CARD_INK3;
          g.fillText(label, x, partsTop);
          g.textAlign = 'right';
          g.fillStyle = CARD_INK2;
          g.fillText(String(v), x + colW, partsTop);
          g.textAlign = 'left';
          g.fillStyle = CARD_RULE;
          g.fillRect(x, partsTop + 10, colW, 3);
          g.fillStyle = cardRamp(v);
          g.fillRect(x, partsTop + 10, Math.max(2, (colW * Math.max(0, Math.min(100, v))) / 100), 3);
        });
      }
    }

    /* Numbers sit on a fixed band so two cards exported from different entries
       line up when they are posted side by side. */
    const bandTop = 430;
    g.strokeStyle = CARD_RULE; g.lineWidth = 1;
    g.beginPath(); g.moveTo(CARD_PAD, bandTop + .5); g.lineTo(CARD_W - CARD_PAD, bandTop + .5); g.stroke();
    if (m) {
      const cells = [
        [en ? 'STARS' : 'STAR', fmtAbbr(m.stars, en)],
        [en ? 'FORKS' : 'FORK', fmtInt(m.forks)],
        [en ? 'HEALTH' : '健康分', String(m.health)],
        [en ? 'LAST PUSH' : '最近 PUSH', dateOnly(m.pushedAt)],
      ];
      const colW = (CARD_W - CARD_PAD * 2) / cells.length;
      cells.forEach(([label, value], i) => {
        const x = CARD_PAD + i * colW + (i ? 24 : 0);
        if (i) {
          g.strokeStyle = CARD_RULE;
          g.beginPath(); g.moveTo(x - 24 + .5, bandTop + 20); g.lineTo(x - 24 + .5, bandTop + 94); g.stroke();
        }
        cardTrack(g, true);
        g.font = `11px ${CARD_MONO}`;
        g.fillStyle = CARD_INK3;
        g.fillText(label, x, bandTop + 30);
        cardTrack(g, false);
        g.font = `600 30px ${CARD_MONO}`;
        g.fillStyle = CARD_INK;
        g.fillText(String(value), x, bandTop + 72);
      });
    } else {
      g.font = `17px ${CARD_SANS}`;
      g.fillStyle = CARD_INK3;
      g.fillText(en
        ? 'No repository metrics: this entry is not a GitHub repository.'
        : '未采集仓库指标：该条目不是 GitHub 仓库（分组标签或站点页面）。', CARD_PAD, bandTop + 46);
    }

    const footTop = 552;
    g.strokeStyle = CARD_RULE;
    g.beginPath(); g.moveTo(CARD_PAD, footTop + .5); g.lineTo(CARD_W - CARD_PAD, footTop + .5); g.stroke();
    g.font = `12px ${CARD_MONO}`;
    g.fillStyle = CARD_INK3;
    g.fillText(en ? `Snapshot ${dateOnly(DATA.generatedAt)} · sindresorhus/awesome` : `数据快照 ${dateOnly(DATA.generatedAt)} · sindresorhus/awesome`, CARD_PAD, footTop + 30);
    g.textAlign = 'right';
    g.fillStyle = CARD_ACCENT;
    g.fillText(CARD_SITE, CARD_W - CARD_PAD, footTop + 30);
    g.textAlign = 'left';
    return cv;
  }

  function exportCard(it) {
    let cv;
    try { cv = drawCard(it); } catch (_) { toast(ui('cardFail')); return; }
    const name = String(it.name || 'atlas').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'atlas';
    const file = name + '-atlas-card.png';
    const save = (href, revoke) => {
      const a = document.createElement('a');
      a.href = href; a.download = file;
      document.body.appendChild(a); a.click(); a.remove();
      if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000);
      toast(ui('cardOk'));
    };
    if (cv.toBlob) {
      cv.toBlob((blob) => {
        if (!blob) { toast(ui('cardFail')); return; }
        save(URL.createObjectURL(blob), true);
      }, 'image/png');
    } else save(cv.toDataURL('image/png'), false);
  }

  /* ---------- orchestration ---------- */
  function renderCanvas() {
    const body = $('#canvasBody');
    const fn = { map: renderMap, graph: renderGraph, table: renderTable, timeline: renderTimeline, insight: renderInsightView }[state.view];
    fn();
    if (state.view !== 'map' && state.view !== 'graph') {
      body.classList.remove('is-entering');
      void body.offsetWidth;
      body.classList.add('is-entering');
    }
  }
  function renderAll(push) {
    renderStaticUI(); renderMetrics(); renderHeroPlate(); renderQuickChips(); renderSidebar(); renderViewState();
    renderToolbar(); renderCanvas(); renderDetail(); renderSearchMeta(); renderInsights(); fillAbout(); writeURL(push);
  }
  function renderLight() { renderToolbar(); renderCanvas(); renderDetail(); renderSearchMeta(); }

  /* ---------- toast / clipboard ---------- */
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, 2100);
  }
  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && location.protocol !== 'file:') await navigator.clipboard.writeText(text);
      else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      toast(okMsg);
    } catch (_) { toast(ui('copyFail')); }
  }

  /* ---------- command palette ---------- */
  let cmdkItems = [], cmdkIndex = 0, cmdkReturnFocus = null;
  function openCmdk() {
    cmdkReturnFocus = document.activeElement;
    $('#cmdk').hidden = false;
    $('#cmdkOpen').setAttribute('aria-expanded', 'true');
    $('#cmdkInput').value = '';
    cmdkIndex = 0;
    renderCmdk('');
    setTimeout(() => $('#cmdkInput').focus(), 20);
  }
  function closeCmdk() {
    const panel = $('#cmdk');
    if (panel.hidden) return;
    panel.hidden = true;
    $('#cmdkOpen').setAttribute('aria-expanded', 'false');
    /* Focus goes back where it came from; before this it fell to <body> and
       keyboard readers lost their place in the page. */
    if (cmdkReturnFocus && document.contains(cmdkReturnFocus)) cmdkReturnFocus.focus({ preventScroll: true });
    cmdkReturnFocus = null;
  }
  function cmdkFocusables() {
    return $$('button, input, [tabindex]:not([tabindex="-1"])', $('#cmdk')).filter((el) => !el.disabled && el.offsetParent !== null);
  }
  function renderCmdk(q) {
    const needle = q.trim().toLowerCase();
    const items = [];
    if (!needle || /view|视图|地图|图谱|榜单|时间|洞察|map|graph|table|timeline|insight/i.test(needle)) {
      for (const v of VIEWS) items.push({ kind: isEn() ? 'View' : '视图', name: ui('tab' + v.charAt(0).toUpperCase() + v.slice(1)), meta: '', action: 'cmdk-view', id: v });
    }
    if (!needle || /cat|分类|category/i.test(needle)) {
      for (const c of DATA.categories.filter((c) => !needle || (c.name + catName(c)).toLowerCase().includes(needle)).slice(0, 4)) {
        items.push({ kind: isEn() ? 'Category' : '分类', name: catName(c), meta: c.itemCount + '', action: 'cmdk-cat', id: c.id });
      }
    }
    for (const it of DATA.items.filter((it) => !needle || it.__search.includes(needle)).slice(0, 8)) {
      items.push({ kind: isEn() ? 'List' : '清单', name: it.name, meta: it.metrics ? fmtAbbr(it.metrics.stars, isEn()) + ' ★' : '', action: 'cmdk-item', id: it.id });
    }
    cmdkItems = items.slice(0, 14);
    cmdkIndex = Math.min(cmdkIndex, Math.max(0, cmdkItems.length - 1));
    $('#cmdkResults').innerHTML = cmdkItems.length
      ? cmdkItems.map((x, i) => `<button class="cmdk-item ${i === cmdkIndex ? 'is-active' : ''}" type="button" data-cmdk-index="${i}"><span class="cmdk-kind">${esc(x.kind)}</span><span class="cmdk-name">${esc(x.name)}</span><span class="cmdk-meta">${esc(x.meta)}</span></button>`).join('')
      : `<div class="cmdk-empty">${isEn() ? 'No matches' : '没有匹配结果'}</div>`;
    $('#cmdkCount').textContent = cmdkItems.length + ' ' + (isEn() ? 'results' : '条结果');
  }
  function runCmdk(index) {
    const x = cmdkItems[index];
    if (!x) return;
    closeCmdk();
    if (x.action === 'cmdk-view') { state.view = x.id; state.page = 1; renderAll(true); }
    if (x.action === 'cmdk-cat') { state.cat = x.id; state.drill = null; state.page = 1; renderAll(true); }
    if (x.action === 'cmdk-item') { state.selected = x.id; state.view = 'table'; renderAll(true); }
    if (state.view === 'table' || state.view === 'insight') $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- events ---------- */
  function resetFilters() {
    Object.assign(state, { cat: 'all', q: '', drill: null, enrichedOnly: false, favoritesOnly: false, hideArchived: false, page: 1, selected: null, metric: 'count' });
    state.catQuery = '';
    $('#catSearch').value = '';
    $('#searchInput').value = '';
    renderAll(true);
  }
  function changeLang(next) {
    lang = next;
    writeStore(LANG_KEY, lang);
    document.documentElement.lang = isEn() ? 'en' : 'zh-CN';
    renderAll(true);
    renderSince();
    toast(isEn() ? ui('langEn') : ui('langZh'));
  }

  document.addEventListener('click', (e) => {
    const langBtn = e.target.closest('#langSwitch button');
    if (langBtn) { changeLang(langBtn.dataset.lang); return; }
    if (e.target.id === 'cmdk') { closeCmdk(); return; }
    const ci = e.target.closest('[data-cmdk-index]');
    if (ci) { runCmdk(Number(ci.dataset.cmdkIndex)); return; }
    const target = e.target.closest('[data-action], [data-cat], [data-view], [data-metric]');
    if (!target) return;
    if (target.id === 'cmdkOpen') return;
    if (target.dataset.view) { state.view = target.dataset.view; state.page = 1; renderAll(true); return; }
    if (target.dataset.cat) { state.cat = target.dataset.cat; state.drill = null; state.page = 1; renderAll(true); return; }
    if (target.dataset.metric) { state.metric = target.dataset.metric; renderAll(true); return; }
    const action = target.dataset.action;
    const id = target.dataset.id;
    if (!action) return;
    if (action === 'drill') { state.drill = id; state.cat = id; renderAll(true); return; }
    if (action === 'drill-back') { state.drill = null; state.cat = 'all'; renderAll(true); return; }
    if (action === 'select') { state.selected = id; renderLight(); writeURL(true); if (window.innerWidth <= 760) $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'close') { state.selected = null; renderLight(); writeURL(true); return; }
    if (action === 'filter-cat') { state.cat = id; state.drill = null; renderAll(true); return; }
    if (action === 'focus-cat') { state.cat = id; state.view = 'table'; state.drill = null; state.page = 1; renderAll(true); return; }
    if (action === 'insight-cat') { state.cat = id; state.view = 'map'; state.drill = null; state.metric = 'count'; renderAll(true); $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'insight-stars') { state.cat = id; state.view = 'map'; state.drill = null; state.metric = 'stars'; renderAll(true); $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'insight-item') { state.selected = id; state.view = 'table'; renderAll(true); $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'insight-view') { state.view = 'insight'; renderAll(true); $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (action === 'clear-search') { state.q = ''; $('#searchInput').value = ''; renderAll(true); return; }
    if (action === 'reset-all') { resetFilters(); return; }
    if (action === 'copy-link') {
      const it = itemById.get(id);
      if (it && it.url) copyText(it.url, isEn() ? 'Repository link copied' : '仓库链接已复制');
      return;
    }
    if (action === 'export-card') {
      const it = itemById.get(id);
      if (it) exportCard(it);
      return;
    }
    if (action === 'fav') {
      e.stopPropagation();
      if (favorites.has(id)) favorites.delete(id); else favorites.add(id);
      writeStore('atlas-favorites', JSON.stringify([...favorites]));
      renderCanvas(); renderDetail(); renderSearchMeta(); renderSidebar();
      toast(favorites.has(id) ? ui('favAdded') : ui('favRemoved'));
      return;
    }
    if (action === 'page') { state.page = Math.max(1, Number(id) || 1); renderTable(); renderSearchMeta(); writeURL(true); return; }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'scopeSelect') { state.scope = e.target.value; renderCanvas(); writeURL(true); }
    if (e.target.id === 'sortSelect') { state.sort = e.target.value; state.page = 1; renderTable(); writeURL(true); }
    if (e.target.id === 'enrichedOnly') { state.enrichedOnly = e.target.checked; state.page = 1; renderAll(true); }
    if (e.target.id === 'favoritesOnly') { state.favoritesOnly = e.target.checked; state.page = 1; renderAll(true); }
    if (e.target.id === 'hideArchived') { state.hideArchived = e.target.checked; state.page = 1; renderAll(true); }
  });

  const search = $('#searchInput');
  search.value = state.q;
  search.addEventListener('input', () => { state.q = search.value; state.page = 1; renderAll(); search.focus(); });
  $('#searchClear').addEventListener('click', () => { state.q = ''; search.value = ''; state.page = 1; renderAll(); search.focus(); });
  $('#catSearch').addEventListener('input', (e) => { state.catQuery = e.target.value; renderSidebar(); });
  $('#resetFilters').addEventListener('click', resetFilters);
  $('#themeToggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = state.theme;
    writeStore('atlas-theme', state.theme);
    // The sequential data ramp is theme-aware, so swatches and charts must repaint.
    renderSidebar(); renderLight(); renderInsights(); renderHeroPlate();
  });
  $('#shareBtn').addEventListener('click', () => copyText(location.href, ui('copyOk')));
  /* The plate is an <a href="#workspace">, so the jump itself is the browser's
     job; this only makes sure the destination is actually the map view. */
  $('#heroPlate').addEventListener('click', () => {
    if (state.view !== 'map') { state.view = 'map'; state.page = 1; renderAll(); }
  });
  $('#backToTop').addEventListener('click', () => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    /* Keep keyboard focus with the reader instead of leaving it on a button that
       is now off-screen. */
    const brand = $('.brand');
    if (brand) brand.focus({ preventScroll: true });
  });
  $('#cmdkOpen').addEventListener('click', openCmdk);
  $('#cmdkInput').addEventListener('input', (e) => { cmdkIndex = 0; renderCmdk(e.target.value); });
  $('#exportFav').addEventListener('click', () => {
    if (!favorites.size) { toast(ui('exportEmpty')); return; }
    const lines = ['# 我的精选清单收藏', '', `> 导出自「精选清单地图」· ${dateOnly(DATA.generatedAt)} 快照 · 共 ${favorites.size} 条`, ''];
    for (const id of favorites) {
      const it = itemById.get(id);
      if (!it) continue;
      lines.push(`- [${it.name}](${it.url || ''}) — ${plainDesc(it) || it.description || (isEn() ? 'no upstream description' : '（源清单未提供描述）')} · ${catName(catById.get(it.categoryId))}${it.metrics ? ` · ★ ${fmtInt(it.metrics.stars)}` : ''}`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '我的精选清单.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(ui('exportOk'));
  });

  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const typing = /input|textarea|select/i.test(activeEl.tagName);
    const cmdkVisible = !$('#cmdk').hidden;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); cmdkVisible ? closeCmdk() : openCmdk(); return; }
    if (cmdkVisible) {
      if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); return; }
      /* Modal focus trap: Tab cycles inside the panel instead of walking into
         the page behind the scrim. */
      if (e.key === 'Tab') {
        const f = cmdkFocusables();
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (activeEl === first || !$('#cmdk').contains(activeEl))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdkIndex = Math.min(cmdkItems.length - 1, cmdkIndex + 1); highlightCmdk(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmdkIndex = Math.max(0, cmdkIndex - 1); highlightCmdk(); return; }
      if (e.key === 'Enter') { e.preventDefault(); runCmdk(cmdkIndex); return; }
      return;
    }
    /* ARIA tab pattern: arrows move along the strip, Home/End jump to the ends. */
    if (activeEl.classList.contains('view-tab') && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) {
      const tabs = $$('.view-tab');
      const i = tabs.indexOf(activeEl);
      let next = i;
      if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
      if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      e.preventDefault();
      tabs[next].focus();
      tabs[next].click();
      return;
    }
    if (e.key === '/' && !typing) { e.preventDefault(); search.focus(); return; }
    /* Table rows and SVG nodes carry tabindex + data-action but have no native
       key activation; buttons and links already fire their own click. */
    if ((e.key === 'Enter' || e.key === ' ')
      && activeEl.matches('[data-action][tabindex], [data-action][role="button"]')
      && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(activeEl.tagName)) {
      e.preventDefault();
      activeEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return;
    }
    if (e.key === 'Escape') {
      if (typing) { if (activeEl === search) { state.q = ''; search.value = ''; renderAll(); } search.blur(); }
      else if (state.selected) { state.selected = null; renderLight(); writeURL(); }
    }
  });
  function highlightCmdk() {
    $$('.cmdk-item').forEach((el, i) => el.classList.toggle('is-active', i === cmdkIndex));
    const active = $('.cmdk-item.is-active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
  window.addEventListener('popstate', () => {
    /* A #anchor hop fires popstate too. Re-rendering there would rebuild the
       page under the reader and fight the browser's own scroll to the target. */
    if (location.search === lastSearch) return;
    applyURL();
  });

  /* tooltip */
  const tip = $('#tooltip');
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) { tip.hidden = true; return; }
    const parts = (t.getAttribute('data-tip') || '').split('||');
    tip.innerHTML = `<strong>${esc(parts[0] || '')}</strong><span>${esc(parts[1] || '')}</span>`;
    tip.hidden = false;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 10);
    const y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 10);
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  });
  document.addEventListener('mouseleave', () => { tip.hidden = true; });

  /* resize re-render for SVG views + glider */
  let raf = 0;
  window.addEventListener('resize', () => {
    positionGlider();
    if (!['map', 'graph'].includes(state.view)) return;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => renderCanvas());
  });

  /* about section, filled from real numbers */
  function fillAbout() {
    const src = $('#aboutSourceText');
    if (src) src.innerHTML = isEn()
      ? 'Parsed from <a href="https://github.com/sindresorhus/awesome/blob/main/readme.md" target="_blank" rel="noopener noreferrer">sindresorhus/awesome/readme.md</a> (CC0-1.0). Chinese names and descriptions are editorial translations by this site; switch to EN to verify every wording against the source.'
      : '内容解析自 <a href="https://github.com/sindresorhus/awesome/blob/main/readme.md" target="_blank" rel="noopener noreferrer">sindresorhus/awesome 的 readme.md</a>，原项目采用 CC0-1.0。中文分类名与 466 条描述为本站人工译述，另有 212 条源清单无描述、由本站补写中文提示；右上角切到 EN 可逐条核对英文原文。';
    $('#aboutParse').textContent = isEn()
      ? `Structure-aware parse: ${DATA.stats.raw.h2Count} H2 sections (1 TOC + ${DATA.categories.length} categories + Related), ${DATA.stats.raw.listLines} list lines minus ${DATA.stats.raw.contentsAnchors} TOC anchors = ${DATA.stats.items} records; ${DATA.stats.githubRepos} GitHub repos, ${DATA.stats.labels} label-only rows, ${DATA.stats.level1} nested items. ${DATA.warnings.length} parse warnings.`
      : `按 Markdown 结构解析：${DATA.stats.raw.h2Count} 个 H2 章节（1 个目录 + ${DATA.categories.length} 个分类）、${DATA.stats.raw.listLines} 行列表项，扣除 ${DATA.stats.raw.contentsAnchors} 行目录锚点后得到 ${DATA.stats.items} 条记录；其中 ${DATA.stats.githubRepos} 个 GitHub 仓库、${DATA.stats.labels} 个无链接分组标签、${DATA.stats.level1} 条缩进子条目。解析告警 ${DATA.warnings.length} 条。`;
    $('#aboutMetricText').textContent = isEn()
      ? `Star / fork / last push / language / archived state come from the GitHub API with an authorised token, covering ${cov.reposEnriched || VERIFIED.length} of ${cov.reposTotal || DATA.stats.githubRepos} repositories (${cov.coveragePct || 0}%). Health = 0.45 × freshness + 0.35 × popularity(log10 stars) + 0.20 × activity(forks, archived).`
      : `Star / Fork / 最近 push / 语言 / 归档状态来自带授权的 GitHub API 全量核验，覆盖 ${cov.reposEnriched || VERIFIED.length} / ${cov.reposTotal || DATA.stats.githubRepos} 个仓库（${cov.coveragePct || 0}%）。健康分 = 0.45 × 新鲜度 + 0.35 × 热度（Star 对数）+ 0.20 × 活跃度（Fork 与归档状态），满分 100。`;
    $('#aboutCoverage').textContent = isEn()
      ? `Chinese translation is editorial, not official. Proper nouns keep their English names so GitHub search still works; 466 upstream descriptions were translated and ${Object.keys(I18N.hints).length} Chinese hints were written for lists that have no description. The other ${DATA.stats.items - 466} entries are labelled rather than fabricated. History changes are diffed from ${HISTORY.summary?.revisions || 0} real README revisions, not inferred from commit titles.`
      : `中文为本站译述，非官方译本；专有名词保留英文原名，方便直接去 GitHub 搜索。466 条原始描述已译为中文，另有 ${Object.keys(I18N.hints).length} 条通用名称补写了中文提示，源清单没有描述的地方都显式标注、绝不编造。时间演化来自 ${HISTORY.summary?.revisions || 0} 个真实 README 历史版本的逐版比对，而非根据提交标题猜测。`;
    $('#aboutStamp').textContent = (isEn() ? 'README sha256 ' : '源 README sha256 ') + String(DATA.source.sha256).slice(0, 16) + '… · ' + (isEn() ? 'parsed ' : '解析于 ') + dateOnly(DATA.generatedAt);
  }
  computeSince();
  renderSince();
  renderAll();
  positionGlider();
  /* `history.scrollRestoration = 'manual'` is set inline in <head> so it lands
     before the browser restores anything. Re-asserting here covers engines that
     restore after load, while leaving an explicit #anchor deep link alone. */
  if (!location.hash) window.scrollTo(0, 0);
})();
