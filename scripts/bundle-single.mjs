#!/usr/bin/env node
/**
 * Build ONE self-contained index.html in dist/.
 *
 * Why: the WorkBuddy GitHub connector credential is a GitHub App user token
 * with `contents: read` only, so this repository cannot be filled through the
 * REST API. A single file can be committed through the GitHub web UI in one
 * drag, which keeps the site deployable without a personal access token.
 *
 * The page has no runtime fetches: data/catalog.js only assigns globals and
 * assets/app.js reads them, so inlining is a pure text substitution. The
 * favicon is already a data URI.
 *
 *   node scripts/bundle-single.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('index.html');
const css = read('assets/styles.css');
const data = read('data/catalog.js');
const app = read('assets/app.js');

/* A literal "</script" inside an inline script terminates the block early. The
   three inputs are checked here rather than trusted, so a future edit that
   introduces one fails loudly instead of producing a blank page. */
function guard(label, text, closer) {
  if (text.toLowerCase().includes(closer)) {
    throw new Error(`${label} contains a literal ${closer}; it cannot be inlined verbatim.`);
  }
  return text;
}
guard('assets/styles.css', css, '</style');
guard('data/catalog.js', data, '</script');
guard('assets/app.js', app, '</script');

const LINK = '<link rel="stylesheet" href="./assets/styles.css">';
const DATA_TAG = '<script src="./data/catalog.js"></script>';
const APP_TAG = '<script src="./assets/app.js"></script>';

for (const [needle, label] of [[LINK, 'assets/styles.css'], [DATA_TAG, 'data/catalog.js'], [APP_TAG, 'assets/app.js']]) {
  if (!html.includes(needle)) throw new Error(`index.html no longer references ${label} as expected.`);
}

/* Function replacers, never strings. In a string replacement `$$` collapses to
   a single `$`, so app.js's `const $$ = ...querySelectorAll` became a second
   `const $ = ...querySelector`, and EVERY `$$(...)` call in the file silently
   degraded into a single-element query. A replacer function disables the whole
   $&, $`, $', $n, $$ pattern language. */
const out = html
  .replace(LINK, () => `<style>\n${css}\n</style>`)
  .replace(DATA_TAG, () => `<script>\n${data}\n</script>`)
  .replace(APP_TAG, () => `<script>\n${app}\n</script>`);

/* The substitution is only trustworthy if each part survives byte-for-byte.
   This catches both the `$` escaping above and any future edit that makes the
   injected text differ from the source file. */
for (const [label, part] of [['styles.css', css], ['catalog.js', data], ['app.js', app]]) {
  if (!out.includes(part)) throw new Error(`${label} was altered during inlining; refusing to ship a corrupted bundle.`);
}

const dir = path.join(ROOT, 'dist');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'index.html');
fs.writeFileSync(target, out);

/* .nojekyll is not needed for a single root index.html, but shipping it costs
   nothing and removes one way for the Pages build to surprise us later. */
fs.writeFileSync(path.join(dir, '.nojekyll'), '');

console.log(JSON.stringify({
  file: 'dist/index.html',
  bytes: Buffer.byteLength(out, 'utf8'),
  kb: Math.round(Buffer.byteLength(out, 'utf8') / 102.4) / 10,
  parts: { css: css.length, data: data.length, app: app.length },
/* The old field name here was `externalRequests`, which measured `src="./…"` —
   the exact opposite of what it claimed, and it always reported 1 because the
   brand link keeps `href="./"`. Name what is actually counted. */
  localRefsLeft: (out.match(/(?:src|href)="\.\//g) || []).length,
}, null, 2));
