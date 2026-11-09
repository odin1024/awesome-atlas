#!/usr/bin/env node
/**
 * Resolve a GitHub token for the build/deploy scripts.
 *
 * 1. GH_TOKEN / GITHUB_TOKEN environment variable (recommended for CI).
 * 2. The WorkBuddy GitHub connector credential already authorised on this
 *    machine. The credential file is encrypted at rest; we derive the key from
 *    the local master key and decrypt the single header in memory.
 *
 * Nothing is written to disk and the token is never printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const INFO = Buffer.from('workbuddy-oauth-credentials-v1', 'utf8');

function fromLocalConnector() {
  const base = path.join(os.homedir(), '.workbuddy', 'connectors');
  if (!fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    const statePath = path.join(base, dir, 'connector-states.v3.json');
    const keyPath = path.join(base, dir, '.master.key');
    if (!fs.existsSync(statePath) || !fs.existsSync(keyPath)) continue;
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const box = state.headerOverrides?.github?.Authorization;
      const header = state.encryption;
      if (!box || !header || header.scheme !== 'aes-256-gcm') continue;
      const salt = Buffer.from(header.salt, 'base64');
      const masterKey = fs.readFileSync(keyPath);
      const check = (buf) => crypto.createHash('sha256').update(buf).update(salt).digest().subarray(0, 16).toString('base64');
      if (check(masterKey) !== header.keyCheck) continue;
      const aesKey = Buffer.from(crypto.hkdfSync(
        'sha256',
        Buffer.concat([masterKey, Buffer.from(dir, 'utf8')]),
        salt, INFO, 32,
      ));
      const aad = Buffer.from(`${dir}|connector-states:headerOverrides:github|Authorization`, 'utf8');
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(box.iv, 'base64'));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
      const value = Buffer.concat([
        decipher.update(Buffer.from(box.ct, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return value.replace(/^Bearer\s+/i, '');
    } catch {
      // A different account directory or a rotated key: keep looking.
    }
  }
  return null;
}

export function githubToken() {
  return process.env.GH_TOKEN || process.env.GITHUB_TOKEN || fromLocalConnector() || null;
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
