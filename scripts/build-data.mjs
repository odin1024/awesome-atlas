#!/usr/bin/env node
/**
 * Parse sindresorhus/awesome readme.md into a structured catalog.
 *
 * Deliberately dependency-free: a small line tokenizer walks the markdown
 * structure (HTML blocks, headings, nested list items) instead of matching the
 * whole document with one regex. Output is consumed by the static site and by
 * validate.mjs, which re-counts the source with an independent method.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'source', 'readme.md');
const OUT = path.join(ROOT, 'data');

const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split(/\r?\n/);
// A trailing newline creates an empty final array element; wc -l semantics.
const lineCount = raw.endsWith('\n') ? lines.length - 1 : lines.length;
const sourceSha = crypto.createHash('sha256').update(raw).digest('hex');

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// GitHub reserves these first path segments for site pages. A URL such as
// github.com/topics/awesome is a topic page, not an owner/repo pair.
const GITHUB_RESERVED = new Set([
  'topics', 'orgs', 'sponsors', 'collections', 'features', 'settings',
  'marketplace', 'apps', 'about', 'pricing', 'explore', 'notifications',
  'search', 'login', 'join', 'new', 'sitemap', 'contact', 'security',
  'enterprise', 'team', 'readme', 'gist', 'blog', 'events', 'sponsors-explore',
]);

/* ---------- line tokenizer ---------- */
const tokenize = (line) => {
  if (/^#{1,6}\s+/.test(line)) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return { type: 'heading', level: m[1].length, text: m[2].trim() };
  }
  const listMatch = line.match(/^([\t ]*)[-*+]\s+(.+)$/);
  if (listMatch) {
    const indent = listMatch[1];
    const level = (indent.match(/\t/g) || []).length + Math.floor((indent.match(/ /g) || []).length / 2);
    return { type: 'list', level, text: listMatch[2].trim() };
  }
  return { type: 'other', text: line };
};

/* ---------- parse a single list item ---------- */
const parseItem = (text) => {
  let name = '';
  let url = null;
  let description = '';
  let rest = '';

  const link = text.match(/^\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$/);
  if (link) {
    name = link[1].trim();
    url = link[2].trim();
    rest = link[3];
  } else {
    // Label-only rows such as "- Linux" or "- macOS - Operating system ..."
    const parts = text.split(/\s+-\s+/);
    name = (parts.shift() || text).trim();
    rest = parts.length ? ` - ${parts.join(' - ')}` : '';
  }

  if (/^\s*-\s+/.test(rest)) description = rest.replace(/^\s*-\s+/, '').trim();
  else if (rest.trim()) description = rest.trim();

  // Strip trailing punctuation noise but keep the author's wording.
  description = description.replace(/\s+/g, ' ').trim();

  // Normalize URL: drop #readme anchors, trailing slash, whitespace.
  let cleanUrl = url;
  if (cleanUrl) {
    cleanUrl = cleanUrl.replace(/#.*$/, '').replace(/\/+$/, '').trim();
  }

  let repo = null;
  let host = null;
  if (cleanUrl) {
    try {
      const u = new URL(cleanUrl);
      host = u.hostname.replace(/^www\./, '');
      const seg = u.pathname.split('/').filter(Boolean);
      if (host === 'github.com' && seg.length >= 2 && !GITHUB_RESERVED.has(seg[0].toLowerCase())) {
        repo = `${seg[0]}/${seg[1]}`.replace(/\.git$/, '');
      }
    } catch {
      host = null;
    }
  }

  const kind = repo ? 'repo' : cleanUrl ? 'link' : 'label';
  return { name, url: cleanUrl, repo, host, description, kind };
};

/* ---------- walk document ---------- */
let htmlDepth = 0;
let inContents = false;
let category = null;
let lastTopLevel = null;
const categories = [];
const items = [];
const warnings = [];
const headingList = [];

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const openDiv = (line.match(/<div\b/gi) || []).length;
  const closeDiv = (line.match(/<\/div\s*>/gi) || []).length;
  const startsHtml = htmlDepth > 0 || openDiv > closeDiv || (openDiv > 0 && !/<\/div/i.test(line));

  if (startsHtml) {
    htmlDepth += openDiv - closeDiv;
    if (htmlDepth < 0) htmlDepth = 0;
    continue;
  }
  if (htmlDepth > 0) {
    htmlDepth += openDiv - closeDiv;
    if (htmlDepth < 0) htmlDepth = 0;
    continue;
  }

  const tok = tokenize(line);
  if (tok.type === 'heading') {
    headingList.push({ line: i + 1, level: tok.level, text: tok.text });
    if (tok.level === 2) {
      inContents = tok.text.trim().toLowerCase() === 'contents';
      if (!inContents) {
        category = {
          id: slug(tok.text),
          name: tok.text.trim(),
          line: i + 1,
          itemCount: 0,
          linkCount: 0,
          childCount: 0,
        };
        categories.push(category);
      }
      lastTopLevel = null;
    }
    continue;
  }
  if (inContents || !category) continue;
  if (tok.type !== 'list') continue;

  const parsed = parseItem(tok.text);
  const level = tok.level > 0 ? 1 : 0;
  const parentId = level === 1 && lastTopLevel ? lastTopLevel.id : null;
  const item = {
    id: `${category.id}/${slug(parsed.name) || 'item'}-${items.length + 1}`,
    index: items.length + 1,
    name: parsed.name,
    url: parsed.url,
    repo: parsed.repo,
    host: parsed.host,
    description: parsed.description,
    kind: parsed.kind,
    categoryId: category.id,
    category: category.name,
    level,
    parentId,
    sourceLine: i + 1,
    children: [],
    metrics: null,
  };
  items.push(item);
  category.itemCount += 1;
  if (parsed.url) category.linkCount += 1;
  if (level === 1) {
    category.childCount += 1;
    if (lastTopLevel) lastTopLevel.children.push(item.id);
    else warnings.push(`子条目缺少父级: L${i + 1} ${parsed.name}`);
  } else {
    lastTopLevel = item;
  }

  if (!parsed.name) warnings.push(`空标题: L${i + 1}`);
  if (parsed.url && !/^https?:\/\//.test(parsed.url)) warnings.push(`非 HTTP 链接: L${i + 1} ${parsed.url}`);
}

/* ---------- independent raw counts for cross-validation ---------- */
const rawStats = {
  totalLines: lineCount,
  h2Count: lines.filter((l) => /^##\s+/.test(l)).length,
  listLines: lines.filter((l) => /^[\t ]*[-*+]\s+/.test(l)).length,
  listLinesWithLink: lines.filter((l) => /^[\t ]*[-*+]\s+\[[^\]]+\]\([^)]+\)/.test(l)).length,
  tabIndentedLines: lines.filter((l) => /^\t+[-*+]\s+/.test(l)).length,
  contentsAnchors: (() => {
    const start = lines.findIndex((l) => /^##\s+Contents/.test(l));
    const end = lines.findIndex((l, idx) => idx > start && /^##\s+/.test(l));
    return lines.slice(start + 1, end).filter((l) => /^[-*+]\s+\[[^\]]+\]\(#[^)]+\)/.test(l)).length;
  })(),
};

for (const c of categories) c.topLevelCount = items.filter((it) => it.categoryId === c.id && it.level === 0).length;

const catalog = {
  generatedAt: new Date().toISOString(),
  source: {
    repository: 'sindresorhus/awesome',
    file: 'readme.md',
    url: 'https://github.com/sindresorhus/awesome/blob/main/readme.md',
    license: 'CC0-1.0',
    sha256: sourceSha,
    lineCount,
    byteCount: Buffer.byteLength(raw, 'utf8'),
  },
  stats: {
    categories: categories.length,
    items: items.length,
    withUrl: items.filter((it) => it.url).length,
    githubRepos: items.filter((it) => it.repo).length,
    labels: items.filter((it) => it.kind === 'label').length,
    level0: items.filter((it) => it.level === 0).length,
    level1: items.filter((it) => it.level === 1).length,
    withDescription: items.filter((it) => it.description).length,
    uniqueRepos: new Set(items.filter((it) => it.repo).map((it) => it.repo.toLowerCase())).size,
    raw: rawStats,
  },
  categories,
  items,
  warnings,
  h2Headings: headingList.filter((h) => h.level === 2),
};

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify(catalog, null, 2));
fs.writeFileSync(
  path.join(OUT, 'catalog.js'),
  `/* Generated by scripts/build-data.mjs - do not edit by hand. */\nwindow.__ATLAS_DATA__ = ${JSON.stringify(catalog)};\n`,
);

console.log(JSON.stringify({
  categories: catalog.stats.categories,
  items: catalog.stats.items,
  githubRepos: catalog.stats.githubRepos,
  labels: catalog.stats.labels,
  level1: catalog.stats.level1,
  warnings: catalog.warnings.length,
  raw: rawStats,
}, null, 2));
