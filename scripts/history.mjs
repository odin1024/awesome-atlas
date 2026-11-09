#!/usr/bin/env node
/**
 * Reconstruct how the awesome index changed over time.
 *
 * Fetches real historical revisions of readme.md from the GitHub API, parses
 * the curated list out of each one, and diffs consecutive revisions. This gives
 * the timeline view genuine "added / removed list" events and a growth series,
 * instead of only showing commit messages.
 *
 *   node scripts/history.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubToken, githubFetch } from './gh-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const LIMIT = 24;

/* Human-written translations for recurring upstream commit messages. */
const EXACT = {
  'Meta tweaks': '调整元信息与排版',
  'Improve some descriptions': '优化部分条目描述',
  'Add RSS link': '新增 RSS 订阅链接',
  'Fix invalid space character (#4393)': '修正非法空格字符（#4393）',
  'Remove 8 archived awesome lists (#4390)': '移除 8 份已归档的清单（#4390）',
  'Remove 17 archived awesome lists (#4278)': '移除 17 份已归档的清单（#4278）',
  'Update link (#4229)': '更新一处链接（#4229）',
  'Update link for `Transit` (#3818)': '更新 Transit 的链接（#3818）',
  'Fix: Remove duplicate paragraph tag in readme (#3897)': '删除 README 中重复的段落标签（#3897）',
};

function translateCommit(msg) {
  if (EXACT[msg]) return EXACT[msg];
  const pr = (msg.match(/\(#(\d+)\)/) || [])[0] || '';
  const clean = msg.replace(/\s*\(#\d+\)\s*$/, '').trim();
  let m;
  const prZh = pr ? `（${pr.slice(1, -1)}）` : '';
  if ((m = clean.match(/^Remove (\d+) archived awesome lists$/i))) return `移除 ${m[1]} 份已归档清单${prZh}`;
  if (/^Remove broken link$/i.test(clean)) return `移除失效链接${prZh}`;
  if ((m = clean.match(/^Remove (.+)$/i))) return `移除 ${m[1]}${prZh}`;
  if ((m = clean.match(/^Add (.+)$/i))) return `新增 ${m[1]}${prZh}`;
  if ((m = clean.match(/^Update link for (.+)$/i))) return `更新 ${m[1].replace(/`/g, '')} 的链接${prZh}`;
  if (/^Update link$/i.test(clean)) return `更新链接${prZh}`;
  if ((m = clean.match(/^Fix[:\s]+(.+)$/i))) return `修正 ${m[1]}${prZh}`;
  if (/^Improve (.+)$/i.test(clean)) return `改进${clean.slice(8)}${prZh}`;
  return `维护更新：${clean}${prZh}`;
}

/** Extract {url -> name} for curated list items in one README revision. */
function parseLists(text) {
  const map = new Map();
  let inContents = false;
  let inHtml = false;
  for (const line of text.split(/\r?\n/)) {
    if ((line.match(/<div\b/gi) || []).length) inHtml = true;
    if (inHtml) {
      if (/<\/div\s*>/i.test(line)) inHtml = false;
      continue;
    }
    if (/^##\s+/.test(line)) { inContents = /^##\s+Contents/i.test(line); continue; }
    if (inContents) continue;
    const m = line.match(/^[\t ]*[-*+]\s+\[([^\]]+)\]\(([^)\s]+)\)/);
    if (!m || m[2].startsWith('#')) continue;
    const key = m[2].replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
    map.set(key, m[1].trim());
  }
  return map;
}

function diff(current, older) {
  const rawAdded = [];
  const rawRemoved = [];
  for (const [url, name] of current) if (!older.has(url)) rawAdded.push({ name, url });
  for (const [url, name] of older) if (!current.has(url)) rawRemoved.push({ name, url });

  // A list whose URL changed appears once in each bucket. Pair them up by name
  // so a link update is not reported as "removed + added".
  const byName = new Map();
  for (const r of rawRemoved) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  const relinked = [];
  const added = [];
  for (const a of rawAdded) {
    const bucket = byName.get(a.name);
    if (bucket && bucket.length) {
      const old = bucket.shift();
      relinked.push({ name: a.name, from: old.url, to: a.url });
    } else {
      added.push(a);
    }
  }
  const removed = [...byName.values()].flat();
  return { added, removed, relinked };
}

async function main() {
  const token = githubToken();
  if (!token) throw new Error('No GitHub token. Set GH_TOKEN or authorise the GitHub connector.');

  const commits = githubFetch(token, '/repos/sindresorhus/awesome/commits?path=readme.md&per_page=' + LIMIT);
  console.log(`Fetched ${commits.length} readme.md commits`);

  const revisions = [];
  for (const c of commits) {
    const sha = c.sha;
    let text;
    try {
      text = githubFetch(token, `/repos/sindresorhus/awesome/contents/readme.md?ref=${sha}`, {
        raw: true,
        accept: 'application/vnd.github.raw+json',
      });
    } catch (e) {
      console.log(`  skip ${sha.slice(0, 7)}: ${e.message}`);
      continue;
    }
    if (typeof text !== 'string' || text.length < 1000) continue;
    revisions.push({
      sha: sha.slice(0, 7),
      date: c.commit?.author?.date || c.commit?.committer?.date,
      message: (c.commit?.message || '').split('\n')[0].slice(0, 160),
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      lists: parseLists(text),
    });
    process.stdout.write(`  parsed ${revisions.length}/${commits.length}\r`);
  }
  console.log();

  if (revisions.length < 2) throw new Error('Not enough historical revisions to diff.');

  const snapshots = [];
  for (let i = 0; i < revisions.length; i += 1) {
    const cur = revisions[i];
    const older = revisions[i + 1];
    const d = older ? diff(cur.lists, older.lists) : { added: [], removed: [], relinked: [] };
    snapshots.push({
      sha: cur.sha,
      date: cur.date,
      author: cur.author,
      message: cur.message,
      messageZh: translateCommit(cur.message),
      total: cur.lists.size,
      added: d.added,
      removed: d.removed,
      relinked: d.relinked,
    });
  }

  const series = snapshots.slice().reverse().map((s) => ({ date: s.date, total: s.total }));
  const first = series[0], last = series[series.length - 1];
  const summary = {
    revisions: snapshots.length,
    firstDate: first.date,
    lastDate: last.date,
    firstTotal: first.total,
    lastTotal: last.total,
    netChange: last.total - first.total,
    additions: snapshots.reduce((s, x) => s + x.added.length, 0),
    removals: snapshots.reduce((s, x) => s + x.removed.length, 0),
    relinks: snapshots.reduce((s, x) => s + x.relinked.length, 0),
    spanDays: Math.round((new Date(last.date) - new Date(first.date)) / 86400000),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'sindresorhus/awesome readme.md historical revisions via GitHub Contents API',
    method: 'Parse list items per revision, diff against the next older revision',
    note: 'Added/removed counts come from real README diffs, not from commit message guesses.',
    summary,
    series,
    snapshots,
  };
  fs.writeFileSync(path.join(DATA, 'history.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
