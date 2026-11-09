/** Shared, explainable health-score model used by both enrichment passes. */
const DAY = 86_400_000;

export function healthOf(r, now = Date.now(), via = r.__via || 'github-search') {
  if (!r?.pushed_at) return null;
  const days = Math.max(0, (now - new Date(r.pushed_at).getTime()) / DAY);
  const freshness = days < 30 ? 100 : days < 90 ? 85 : days < 180 ? 70 : days < 365 ? 50 : days < 730 ? 25 : 0;
  const popularity = Math.min(100, (Math.log10((r.stargazers_count || 0) + 1) / 5) * 100);
  const activity = r.archived ? 0 : Math.min(100, 55 + Math.min(45, Math.log10((r.forks_count || 0) + 1) * 15));
  return {
    stars: r.stargazers_count || 0,
    forks: r.forks_count || 0,
    openIssues: r.open_issues_count || 0,
    watchers: r.subscribers_count ?? null,
    pushedAt: r.pushed_at,
    createdAt: r.created_at,
    archived: Boolean(r.archived),
    disabled: Boolean(r.disabled),
    language: r.language || null,
    license: r.license?.spdx_id || null,
    topics: Array.isArray(r.topics) ? r.topics.slice(0, 8) : [],
    description: r.description || null,
    homepage: r.homepage || null,
    parts: {
      freshness: Math.round(freshness),
      popularity: Math.round(popularity),
      activity: Math.round(activity),
    },
    health: Math.round(0.45 * freshness + 0.35 * popularity + 0.2 * activity),
    fetchedAt: new Date().toISOString(),
    via,
  };
}

export function computeCoverage(catalog) {
  const repos = catalog.items.filter((it) => it.repo);
  const enriched = repos.filter((it) => it.metrics);
  return {
    reposTotal: repos.length,
    reposEnriched: enriched.length,
    coveragePct: Math.round((enriched.length / repos.length) * 1000) / 10,
    totalStarsSampled: enriched.reduce((s, it) => s + (it.metrics.stars || 0), 0),
    archived: enriched.filter((it) => it.metrics.archived).length,
  };
}
