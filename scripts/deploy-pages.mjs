#!/usr/bin/env node
/**
 * Deploy the static site to GitHub Pages using ONLY api.github.com.
 *
 *   node scripts/deploy-pages.mjs
 *
 * Token resolution order: GH_TOKEN / GITHUB_TOKEN -> WorkBuddy GitHub connector
 * (see scripts/gh-auth.mjs). The token is never printed or written to disk.
 *
 * Why REST instead of `git push`: in this environment github.com:443 is blocked
 * by the proxy (CONNECT 502) while api.github.com is reachable. Files are sent
 * as Git blobs and committed in ONE atomic commit, so the repository history
 * stays clean and GitHub Pages only rebuilds once.
 *
 * The WorkBuddy connector credential is a GitHub App *user* token. Verified
 * behaviour of that token: it can read any repository the account can see, but
 * it carries `contents: read` only, so it can neither create a repository nor
 * write a blob. The script detects the 403 at the first write and prints the two
 * remedies (a fine-grained PAT via GH_TOKEN, or the single-file build that can be
 * committed through the web UI) instead of failing 39 times in a row. A classic
 * PAT with `repo` scope can do everything automatically.
 *
 * Options:
 *   GH_REPO=awesome-atlas   target repository name
 *   GH_BRANCH=main          branch served by Pages
 *   GH_DRY=1                print the plan, write nothing
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubToken } from './gh-auth.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = githubToken();
const REPO = process.env.GH_REPO || 'awesome-atlas';
const BRANCH = process.env.GH_BRANCH || 'main';
const DRY = process.env.GH_DRY === '1' || !TOKEN;

// Internal build caches and anything that needs a `workflow` OAuth scope.
// `dist` is the single-file build output (scripts/bundle-single.mjs); it is a
// local fallback artifact, not part of the site that Pages serves.
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.github', 'dist']);
const SKIP_FILES = new Set([
  'data/repo-pool.json',      // 5 MB internal GitHub search cache
  'data/deploy-result.json',  // generated on every deploy
]);

function collect(dir, rel = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...collect(abs, r));
    } else if (st.isFile()) {
      if (SKIP_FILES.has(r) || name.startsWith('_probe')) continue;
      out.push(r);
    }
  }
  return out;
}

const FILES = collect(ROOT);
const totalBytes = FILES.reduce((s, f) => s + fs.statSync(path.join(ROOT, f)).size, 0);

if (DRY) {
  console.log(`DRY RUN — ${TOKEN ? 'GH_DRY=1' : '未检测到可用凭据'}，未执行任何写操作。\n`);
  console.log(`仓库: ${REPO} · 分支: ${BRANCH} · 文件: ${FILES.length} 个 · ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('文件清单:');
  for (const f of FILES) console.log('  -', f);
  console.log('\n正式部署: node scripts/deploy-pages.mjs');
  process.exit(0);
}

function gh(method, pathname, body) {
  const url = `https://api.github.com${pathname}`;
  const args = [
    '-sS', '-L', '-k', '--ssl-no-revoke', '--http1.1', '--max-time', '120',
    '-X', method,
    '-H', `Authorization: Bearer ${TOKEN}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'User-Agent: awesome-atlas-deploy',
    '-w', '\n__HTTP__%{http_code}',
  ];
  let tmp = null;
  if (body !== undefined) {
    // A JSON file avoids OS command-line length limits for large base64 blobs.
    tmp = path.join(os.tmpdir(), `atlas-${crypto.randomBytes(6).toString('hex')}.json`).replace(/\\/g, '/');
    fs.writeFileSync(tmp, JSON.stringify(body));
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@${tmp}`);
  }
  args.push(url);
  let out = '';
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // Never surface e.message: the curl argv contains the bearer token.
    out = String(e.stdout || '');
  } finally {
    if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  const i = out.lastIndexOf('\n__HTTP__');
  const code = Number(out.slice(i + 9).trim() || 0);
  let data = null;
  try { data = JSON.parse(out.slice(0, i)); } catch (_) { data = out.slice(0, i); }
  return { code, data };
}

const brief = (r) => JSON.stringify(r?.data?.message || r?.data || '').slice(0, 220);

const me = gh('GET', '/user');
if (me.code !== 200) { console.error('无法读取 GitHub 账号：', me.code, brief(me)); process.exit(1); }
const owner = me.data.login;
const base = `/repos/${owner}/${REPO}`;
console.log(`账号: ${owner} · 目标仓库: ${owner}/${REPO}`);

let repo = gh('GET', base);
if (repo.code === 404) {
  const create = gh('POST', '/user/repos', {
    name: REPO,
    description: 'Awesome Atlas · 把 sindresorhus/awesome 的 678 份清单变成可探索的中文数据地图',
    homepage: `https://${owner}.github.io/${REPO}/`,
    private: false, has_issues: false, has_wiki: false, has_projects: false,
  });
  if (create.code === 201) {
    console.log('仓库已创建');
    repo = gh('GET', base);
  } else {
    console.error('\n当前授权令牌是 GitHub App 类型，只能读写「已存在」的仓库，没有新建仓库权限（403）。');
    console.error('请手动创建一个空的公开仓库后重跑本脚本，其余步骤全自动：');
    console.error(`  https://github.com/new?name=${REPO}&visibility=public`);
    console.error('  （不要勾选 Add a README / .gitignore / license，保持空仓库即可）');
    console.error(`\n创建后执行: node scripts/deploy-pages.mjs\n`);
    console.error(`API 返回: ${create.code} ${brief(create)}`);
    process.exit(2);
  }
}
if (repo.code !== 200) { console.error('无法读取目标仓库：', repo.code, brief(repo)); process.exit(1); }

// Resolve the current head (empty repos have no refs yet).
const ref = gh('GET', `${base}/git/ref/heads/${BRANCH}`);
let headSha = null;
let baseTree = null;
if (ref.code === 200) {
  headSha = ref.data.object.sha;
  const head = gh('GET', `${base}/git/commits/${headSha}`);
  if (head.code === 200) baseTree = head.data.tree.sha;
  console.log(`已有分支 ${BRANCH}，将在其基础上生成一次提交`);
} else {
  console.log(`空仓库，将创建初始提交与 ${BRANCH} 分支`);
}

/* A repository with zero commits answers 409 "Git Repository is empty." on
   every Git Data endpoint, including /git/blobs -- so the blob upload below can
   never start. The Contents API is the only write path that works before a
   first commit exists; seeding one file gives the branch a tree, after which
   everything else still lands in a single commit. `.nojekyll` is used as the
   seed because it is shipped anyway, so no throwaway file is left behind. */
if (!headSha) {
  const seedBody = (content) => ({ message: 'Initial commit', content });
  let seed = gh('PUT', `${base}/contents/.nojekyll`, seedBody(''));
  if (seed.code === 422) seed = gh('PUT', `${base}/contents/.nojekyll`, seedBody(Buffer.from('\n').toString('base64')));
  if (seed.code !== 201) { console.error('初始化空仓库失败：', seed.code, brief(seed)); process.exit(1); }
  const seeded = gh('GET', `${base}/git/ref/heads/${BRANCH}`);
  if (seeded.code !== 200) { console.error('初始化后仍读不到分支：', seeded.code, brief(seeded)); process.exit(1); }
  headSha = seeded.data.object.sha;
  const head = gh('GET', `${base}/git/commits/${headSha}`);
  if (head.code === 200) baseTree = head.data.tree.sha;
  console.log('已写入首个提交，建立分支');
}

// 1) Upload every file as a Git blob.
const entries = [];
const failed = [];
for (const f of FILES) {
  const content = fs.readFileSync(path.join(ROOT, f)).toString('base64');
  const r = gh('POST', `${base}/git/blobs`, { content, encoding: 'base64' });
  if (r.code === 403) {
    /* Stop at the first 403 instead of printing 39 identical lines. A GitHub
       App user token issued by the WorkBuddy connector carries contents:read
       only, so every write path fails the same way and the useful information
       is the remedy, not the per-file tally. */
    console.error(`\n无法写入仓库：${f} → 403 (${brief(r)})`);
    console.error('这个凭据只有 contents:read，不能提交文件。两条可行路径：');
    console.error('  1) 用有 Contents: Read and write 的 fine-grained PAT：');
    console.error('     GH_TOKEN=github_pat_xxx node scripts/deploy-pages.mjs');
    console.error('  2) 不碰凭据：node scripts/bundle-single.mjs 生成单文件版，');
    console.error(`     在 https://github.com/${owner}/${REPO}/upload/${BRANCH} 手动拖入。`);
    console.error(`\n（已上传 ${entries.length} 个文件，未产生任何提交）\n`);
    process.exit(3);
  }
  if (r.code !== 201) { failed.push({ f, code: r.code, message: brief(r) }); console.log(`  ✗ ${f} → ${r.code}`); continue; }
  entries.push({ path: f, mode: '100644', type: 'blob', sha: r.data.sha });
  console.log(`  ✓ ${f}`);
}
if (!entries.length) { console.error('没有任何文件上传成功，已中止。'); process.exit(1); }

// 2) One tree, one commit. base_tree preserves files that already existed.
const treeBody = { tree: entries };
if (baseTree) treeBody.base_tree = baseTree;
const tree = gh('POST', `${base}/git/trees`, treeBody);
if (tree.code !== 201) { console.error('创建 tree 失败：', tree.code, brief(tree)); process.exit(1); }

const commit = gh('POST', `${base}/git/commits`, {
  message: `Deploy Awesome Atlas · ${entries.length} files · ${new Date().toISOString().slice(0, 10)}`,
  tree: tree.data.sha,
  parents: headSha ? [headSha] : [],
});
if (commit.code !== 201) { console.error('创建 commit 失败：', commit.code, brief(commit)); process.exit(1); }

const refWrite = headSha
  ? gh('PATCH', `${base}/git/refs/heads/${BRANCH}`, { sha: commit.data.sha, force: false })
  : gh('POST', `${base}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.data.sha });
if (refWrite.code !== 200 && refWrite.code !== 201) {
  console.error('更新分支失败：', refWrite.code, brief(refWrite)); process.exit(1);
}
console.log(`提交完成: ${String(commit.data.sha).slice(0, 7)} · ${entries.length} 个文件`);

// Never change the repository's default branch: Pages reads source.branch
// explicitly, and rewriting default_branch on an existing repo would be a
// surprising side effect when deploying into a dedicated gh-pages branch.

// 3) Enable Pages from <branch>/root. .nojekyll disables the Jekyll pass.
let pages = gh('POST', `${base}/pages`, { source: { branch: BRANCH, path: '/' } });
if (pages.code === 409 || pages.code === 422) {
  pages = gh('PUT', `${base}/pages`, { source: { branch: BRANCH, path: '/' } });
}
if (pages.code !== 201 && pages.code !== 200 && pages.code !== 204 && pages.code !== 409) {
  console.log(`Pages 启用接口返回 ${pages.code}（${brief(pages)}）；若已启用可忽略。`);
}
// No explicit POST /pages/builds: updating the branch already queues a build,
// and asking for a second one races it -- that produced a duplicate record that
// finished as "Page build failed" while its sibling built fine.
const status = gh('GET', `${base}/pages`);
const url = status.data?.html_url || `https://${owner}.github.io/${REPO}/`;

const result = {
  owner, repo: REPO, branch: BRANCH, commit: commit.data.sha,
  files: entries.length, bytes: totalBytes, failed,
  pages: { createCode: pages.code, url },
  deployedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'data', 'deploy-result.json'), JSON.stringify(result, null, 2));

console.log('\n部署结果:', JSON.stringify({
  commit: result.commit.slice(0, 7), files: result.files,
  failed: failed.length, pages: result.pages,
}, null, 2));
console.log(`\n线上地址: ${url}（首次构建通常需 1–3 分钟）`);
if (failed.length) {
  console.error('\n以下文件未上传:', failed.map((x) => `${x.f} (${x.code})`).join(', '));
  process.exitCode = 1;
}
