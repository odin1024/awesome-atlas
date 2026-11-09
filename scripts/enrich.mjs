#!/usr/bin/env node
/**
 * Enrich the parsed catalog with real GitHub metrics.
 *
 * Unauthenticated GitHub API allows 60 core req/h and 10 search req/min, so we
 * use batched repository search (100 results per request) for broad coverage,
 * then spend the remaining core budget on individual high-value lookups.
 * Every metric carries its provenance; items we cannot verify stay null and are
 * explicitly reported as "not sampled" in the UI. Nothing is invented.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { healthOf } from './metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const catalogPath = path.join(DATA, 'catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), requests: [], errors: [] };

function api(pathname, { retries = 2 } = {}) {
  const url = pathname.startsWith('http') ? pathname : `https://api.github.com${pathname}`;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const out = execFileSync('curl', [
        '-sS', '-L', '-k', '--ssl-no-revoke', '--http1.1', '--max-time', '45',
        '-H', 'Accept: application/vnd.github+json',
        '-H', 'User-Agent: awesome-atlas-build',
        '-w', '\n__HTTP__%{http_code}',
        url,
      ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      const idx = out.lastIndexOf('\n__HTTP__');
      const body = out.slice(0, idx);
      const code = Number(out.slice(idx + 9).trim());
      report.requests.push({ url, code, bytes: body.length });
      if (code !== 200) throw new Error(`HTTP ${code}: ${body.slice(0, 180)}`);
      return JSON.parse(body);
    } catch (err) {
      if (attempt === retries) {
        report.errors.push({ url, message: String(err.message).slice(0, 240) });
        return null;
      }
      execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},1500)']);
    }
  }
  return null;
}

async function main() {
  const rate = api('/rate_limit');
  const remainingCore = rate?.resources?.core?.remaining ?? 0;
  console.log('core remaining:', remainingCore);

  const sourceRepo = api('/repos/sindresorhus/awesome');
  const commits = api('/repos/sindresorhus/awesome/commits?path=readme.md&per_page=12') || [];

  const byRepo = new Map();
  const ingest = (arr, via) => {
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const r of arr) {
      if (!r?.full_name) continue;
      const key = r.full_name.toLowerCase();
      if (!byRepo.has(key)) {
        byRepo.set(key, { ...r, __via: via });
        n += 1;
      }
    }
    return n;
  };

  const queries = [
    'q=awesome+in:name&sort=stars&order=desc&per_page=100&page=1',
    'q=awesome+in:name&sort=stars&order=desc&per_page=100&page=2',
    'q=awesome+in:name&sort=stars&order=desc&per_page=100&page=3',
    'q=awesome+in:name&sort=stars&order=desc&per_page=100&page=4',
    'q=topic:awesome-list&sort=stars&order=desc&per_page=100&page=1',
    'q=topic:awesome&sort=stars&order=desc&per_page=100&page=1',
  ];
  for (const q of queries) {
    const res = api(`/search/repositories?${q}`);
    ingest(res?.items, 'github-search');
    await sleep(1200);
  }
  console.log('search pool:', byRepo.size);

  const repoItems = catalog.items.filter((it) => it.repo);
  const attach = () => {
    let n = 0;
    for (const it of repoItems) {
      const r = byRepo.get(it.repo.toLowerCase());
      if (r && !it.metrics) {
        it.metrics = healthOf(r);
        n += 1;
      }
    }
    return n;
  };
  let enriched = attach();
  console.log('matched after search:', enriched, '/', repoItems.length);

  // Spend leftover core budget on well-known-looking lists still missing.
  const missing = repoItems.filter((it) => !it.metrics);
  const rate2 = api('/rate_limit');
  const budget = Math.max(0, Math.min(28, (rate2?.resources?.core?.remaining ?? 0) - 6));
  console.log('individual lookup budget:', budget);
  for (const it of missing.slice(0, budget)) {
    const r = api(`/repos/${it.repo}`);
    if (r?.full_name) {
      byRepo.set(r.full_name.toLowerCase(), { ...r, __via: 'github-repo' });
      enriched += 1;
      const metric = healthOf(byRepo.get(r.full_name.toLowerCase()));
      it.metrics = metric;
      // Same repo can appear more than once in the source list.
      for (const other of repoItems) {
        if (other !== it && other.repo?.toLowerCase() === r.full_name.toLowerCase() && !other.metrics) other.metrics = metric;
      }
    }
  }

  // Second pass: duplicate repos that were matched once should share metrics.
  const metricIndex = new Map();
  for (const it of repoItems) if (it.metrics && it.repo) metricIndex.set(it.repo.toLowerCase(), it.metrics);
  let propagated = 0;
  for (const it of repoItems) {
    if (!it.metrics && it.repo) {
      const m = metricIndex.get(it.repo.toLowerCase());
      if (m) { it.metrics = m; propagated += 1; enriched += 1; }
    }
  }

  const enrichedItems = repoItems.filter((it) => it.metrics);
  const totalStars = enrichedItems.reduce((s, it) => s + (it.metrics.stars || 0), 0);
  const coverage = {
    reposTotal: repoItems.length,
    reposEnriched: enrichedItems.length,
    coveragePct: Math.round((enrichedItems.length / repoItems.length) * 1000) / 10,
    totalStarsSampled: totalStars,
    archived: enrichedItems.filter((it) => it.metrics.archived).length,
    propagated,
    searchPool: byRepo.size,
  };

  catalog.enrichment = {
    fetchedAt: new Date().toISOString(),
    method: 'GitHub REST: batched repository search + individual repo lookups (unauthenticated quota)',
    coverage,
    healthFormula: 'health = 0.45 * freshness(pushed_at) + 0.35 * log10(stars) + 0.2 * activity(forks, archived)',
    note: 'Items without metrics are not sampled; the UI labels them explicitly and never treats them as zero.',
  };

  const upstream = {
    fetchedAt: new Date().toISOString(),
    repository: sourceRepo ? {
      fullName: sourceRepo.full_name,
      stars: sourceRepo.stargazers_count,
      forks: sourceRepo.forks_count,
      pushedAt: sourceRepo.pushed_at,
      description: sourceRepo.description,
      url: sourceRepo.html_url,
    } : null,
    commits: commits.map((c) => ({
      sha: c.sha?.slice(0, 7),
      date: c.commit?.author?.date || c.commit?.committer?.date,
      message: (c.commit?.message || '').split('\n')[0].slice(0, 140),
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      url: c.html_url,
    })),
    coverage,
  };

  fs.writeFileSync(path.join(DATA, 'upstream.json'), JSON.stringify(upstream, null, 2));
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  fs.writeFileSync(
    path.join(DATA, 'catalog.js'),
    `/* Generated by scripts/build-data.mjs + scripts/enrich.mjs - do not edit by hand. */\nwindow.__ATLAS_DATA__ = ${JSON.stringify(catalog)};\nwindow.__ATLAS_UPSTREAM__ = ${JSON.stringify(upstream)};\n`,
  );

  report.finishedAt = new Date().toISOString();
  report.coverage = coverage;
  report.requestCount = report.requests.length;
  report.errorCount = report.errors.length;
  fs.writeFileSync(path.join(DATA, 'enrich-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ coverage, errors: report.errors.slice(0, 5), requests: report.requestCount }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
