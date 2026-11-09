#!/usr/bin/env node
/**
 * Full-coverage enrichment with an authorised GitHub token.
 *
 * Replaces the earlier unauthenticated sampling (31%) with a complete sweep of
 * every unique repository in the catalog. One GraphQL query carries many
 * repository aliases, so 674 repos cost only a handful of requests.
 *
 *   node scripts/enrich-full.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubToken, githubFetch } from './gh-auth.mjs';
import { healthOf, computeCoverage } from './metrics.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const BATCH = 50;

function repoFields(alias, owner, name) {
  const esc = (s) => JSON.stringify(s);
  return `${alias}: repository(owner: ${esc(owner)}, name: ${esc(name)}) {
    nameWithOwner
    stargazerCount
    forkCount
    pushedAt
    createdAt
    isArchived
    isDisabled
    isFork
    primaryLanguage { name }
    licenseInfo { spdxId }
    repositoryTopics(first: 8) { nodes { topic { name } } }
    description
    homepageUrl
    url
  }`;
}

function toRestLike(node) {
  return {
    stargazers_count: node.stargazerCount ?? 0,
    forks_count: node.forkCount ?? 0,
    open_issues_count: 0,
    subscribers_count: null,
    pushed_at: node.pushedAt || node.createdAt || null,
    created_at: node.createdAt || null,
    archived: Boolean(node.isArchived),
    disabled: Boolean(node.isDisabled),
    language: node.primaryLanguage?.name || null,
    license: node.licenseInfo ? { spdx_id: node.licenseInfo.spdxId } : null,
    topics: (node.repositoryTopics?.nodes || []).map((n) => n.topic?.name).filter(Boolean),
    description: node.description || null,
    homepage: node.homepageUrl || null,
    __via: 'github-graphql',
  };
}

async function main() {
  const token = githubToken();
  if (!token) throw new Error('No GitHub token. Set GH_TOKEN or authorise the GitHub connector.');
  const me = githubFetch(token, '/user');
  console.log(`Authenticated as ${me.login}`);

  const catalogPath = path.join(DATA, 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const repoItems = catalog.items.filter((it) => it.repo);
  const unique = [...new Set(repoItems.map((it) => it.repo))];
  const byRepo = new Map();
  for (const it of repoItems) {
    if (!byRepo.has(it.repo)) byRepo.set(it.repo, []);
    byRepo.get(it.repo).push(it);
  }
  console.log(`Repositories to verify: ${unique.length}`);

  const found = new Map();
  const missing = [];
  const errors = [];
  let requests = 0;

  for (let start = 0; start < unique.length; start += BATCH) {
    const slice = unique.slice(start, start + BATCH);
    const aliases = slice.map((full, i) => {
      const [owner, name] = full.split('/');
      return { alias: `r${i}`, full, query: repoFields(`r${i}`, owner, name) };
    });
    const query = `query { ${aliases.map((a) => a.query).join('\n')} }`;
    let payload;
    try {
      payload = githubFetch(token, '/graphql', { method: 'POST', body: { query } });
      requests += 1;
    } catch (e) {
      errors.push(`graphql batch ${start}: ${e.message}`);
      continue;
    }
    if (payload.errors) {
      for (const e of payload.errors) errors.push(`graphql: ${e.message}`);
    }
    for (const a of aliases) {
      const node = payload.data?.[a.alias];
      if (node) found.set(a.full, node);
      else missing.push(a.full);
    }
    process.stdout.write(`  fetched ${Math.min(start + BATCH, unique.length)}/${unique.length}\r`);
  }
  console.log();

  // GraphQL returns null for renamed or deleted repositories. A REST lookup
  // follows redirects and tells us the canonical name, which is valuable data.
  const canonical = new Map();
  const unavailable = [];
  for (const full of missing) {
    try {
      const r = githubFetch(token, `/repos/${full}`);
      requests += 1;
      if (r?.full_name) {
        canonical.set(full, r.full_name);
        found.set(full, {
          nameWithOwner: r.full_name,
          stargazerCount: r.stargazers_count,
          forkCount: r.forks_count,
          pushedAt: r.pushed_at,
          createdAt: r.created_at,
          isArchived: r.archived,
          isDisabled: r.disabled,
          isFork: r.fork,
          primaryLanguage: r.language ? { name: r.language } : null,
          licenseInfo: r.license ? { spdxId: r.license.spdx_id } : null,
          repositoryTopics: { nodes: (r.topics || []).slice(0, 8).map((t) => ({ topic: { name: t } })) },
          description: r.description,
          homepageUrl: r.homepage,
          url: r.html_url,
        });
      }
    } catch {
      unavailable.push(full);
    }
  }

  const now = Date.now();
  let written = 0;
  for (const [full, items] of byRepo) {
    const node = found.get(full);
    if (!node) continue;
    const metrics = healthOf(toRestLike(node), now, canonical.has(full) ? 'github-rest-redirect' : 'github-graphql');
    if (canonical.has(full)) metrics.canonicalRepo = canonical.get(full);
    if (node.nameWithOwner && node.nameWithOwner.toLowerCase() !== full.toLowerCase()) {
      metrics.canonicalRepo = node.nameWithOwner;
    }
    metrics.isFork = Boolean(node.isFork);
    for (const it of items) { it.metrics = metrics; written += 1; }
  }

  for (const it of catalog.items) {
    if (!it.metrics && it.repo && unavailable.includes(it.repo)) {
      it.availability = 'unavailable';
    }
  }

  const coverage = computeCoverage(catalog);
  coverage.verified = coverage.reposEnriched;
  coverage.unavailable = unavailable.length;
  coverage.renamed = canonical.size;
  coverage.requests = requests;

  catalog.enrichment = {
    fetchedAt: new Date().toISOString(),
    method: 'GitHub GraphQL batched repository lookup with an authorised token (full sweep)',
    coverage,
    healthFormula: 'health = 0.45 * freshness(pushed_at) + 0.35 * log10(stars) + 0.2 * activity(forks, archived)',
    note: 'Repositories that no longer resolve are marked unavailable rather than shown as zero.',
  };

  const upstreamPath = path.join(DATA, 'upstream.json');
  let upstream = { commits: [], repository: null };
  if (fs.existsSync(upstreamPath)) upstream = JSON.parse(fs.readFileSync(upstreamPath, 'utf8'));
  upstream.coverage = coverage;
  upstream.fetchedAt = new Date().toISOString();

  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2));
  fs.writeFileSync(upstreamPath, JSON.stringify(upstream, null, 2));
  fs.writeFileSync(path.join(DATA, 'enrich-full-report.json'), JSON.stringify({
    finishedAt: new Date().toISOString(),
    coverage,
    requests,
    renamed: [...canonical.entries()],
    unavailable,
    errors,
  }, null, 2));

  console.log(JSON.stringify({
    coverage: `${coverage.reposEnriched}/${coverage.reposTotal} (${coverage.coveragePct}%)`,
    totalStars: coverage.totalStarsSampled,
    archived: coverage.archived,
    renamed: canonical.size,
    unavailable: unavailable.length,
    requests,
    errors: errors.slice(0, 5),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
