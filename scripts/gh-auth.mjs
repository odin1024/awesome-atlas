#!/usr/bin/env node
/**
 * Resolve a GitHub token for the build/deploy scripts.
 *
 * The token comes from GH_TOKEN or GITHUB_TOKEN and nowhere else. Scripts that
 * live in a public repository should not reach into a developer's credential
 * store, and an environment variable is the one place a token can be scoped to
 * a single run: `GH_TOKEN=... node scripts/enrich-full.mjs`.
 *
 * Scopes: `contents: read` is enough for enrich and history; deploying also
 * needs `contents: write`.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function githubToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

/** Minimal REST/GraphQL helper. Uses curl so the sandbox proxy settings apply. */
export function githubFetch(token, endpoint, { method = 'GET', body = null, raw = false, accept = 'application/vnd.github+json' } = {}) {
  const { execFileSync } = require('node:child_process');
  const args = [
    '-sS', '-k', '--ssl-no-revoke', '--http1.1', '--max-time', '60',
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'User-Agent: awesome-atlas-build',
    '-H', `Accept: ${accept}`,
    '-H', 'Content-Type: application/json',
  ];
  if (body !== null) {
    args.push('-X', method, '--data-binary', JSON.stringify(body));
  } else if (method !== 'GET') {
    args.push('-X', method);
  }
  args.push(endpoint.startsWith('http') ? endpoint : `https://api.github.com${endpoint}`);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return raw ? out : JSON.parse(out);
}
