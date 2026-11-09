# Awesome Atlas · 精选清单地图

把 [sindresorhus/awesome](https://github.com/sindresorhus/awesome) 的 `readme.md`（27 个分类、678 条清单）变成一张可探索的**中文**数据地图。

纯静态站点：无构建步骤、无运行时依赖、无后端、无外部 CDN、无追踪脚本。数据全部打包进 `data/catalog.js`，双击 `index.html` 也能用。

## 为什么不是「把 README 排版得好看点」

源 README 是一份线性列表，看不出结构。本站补上原文里不存在的四个维度：**层级关系、仓库热度、维护活跃度、时间演化**，并把全部描述译成中文。

| 视图 | 回答的问题 | 编码方式 |
| --- | --- | --- |
| 01 分类地图 | 哪个领域最繁荣 | Treemap，面积 = 清单数或采样 Star（对数），颜色 = 平均健康分；点击分类下钻到内部清单 |
| 02 关系图谱 | 分类与清单如何组织 | 径向星系，中心为源索引、外圈 27 个分类；圆点大小 = Star，颜色 = 健康分 |
| 03 检索榜单 | 找到某一份具体清单 | 678 条全文检索（中文 / 英文 / 仓库名 / topics）、7 种排序、分页、收藏、导出 |
| 04 生态时间轴 | 这个索引在怎么变 | 24 个真实 README 历史版本的增删 diff、已验证仓库近 18 个月的 push 分布、仓库创建年份分布 |
| 05 数据洞察 | 全局分布长什么样 | 分类权重、健康分分布、语言构成、归档与停滞清单的聚合统计 |

交互：全局搜索（`/` 或 `Ctrl+K` 唤起命令面板）、URL 状态同步（视图 / 分类 / 搜索 / 排序 / 选中项 / 语言均可分享）、收藏与对比存 localStorage、分享当前视图、深浅色主题、移动端底部导航、键盘可访问、`prefers-reduced-motion` 降级。颜色从不单独承担信息编码。

## 中文与国内友好

- **三态语言**：顶栏 `中文 / 双语 / EN` 一键切换。中文态显示译文，双语态并列中英，EN 态回到上游 README 原文。
- 27 个分类译名、466 条描述译文、224 条「原文无描述」条目的中文提示，全部人工校订；专有名词（React、Kubernetes、Rust…）保留英文原名，不硬译。
- 中文检索、万 / 亿计数、中文日期、外链明确标注、页面不请求任何境外 CDN 或字体，国内网络可直接打开。

## 数据管线

```
source/readme.md  →  build-data.mjs     →  data/catalog.json（结构解析）
                  →  enrich-full.mjs   →  673 个仓库全量指标（GitHub GraphQL 批量 alias）
                  →  history.mjs       →  data/history.json（24 版 README 真实 diff）
                  →  upstream.json     →  上游提交记录与采集覆盖率
source/descriptions.tsv → i18n.json    →  中文译名 / 译文 / 提示
                  →  bundle.mjs        →  data/catalog.js（前端唯一数据源）
                  →  validate.mjs + browser-check.py（两层交叉验证）
```

- **结构解析**：行级 tokenizer 还原 H2 章节、Markdown 链接、Tab 缩进的父子关系与 HTML 区块；597 个主条目 + 81 个子条目；`Linux`、`macOS` 这类无链接纯标签保留为 `kind: label`；`github.com/topics/awesome` 这类保留路径不当作仓库。
- **指标**：授权 GitHub API 全量核验，**673 / 673（100%）** 仓库拿到 stars、forks、pushedAt、createdAt、language、license、topics、archived，合计 5,979,356 Star。采集失败时保留上一版快照，页面顶部始终显示「数据快照」日期，绝不用 0 或估算值填充。
- **健康分**：`0.45 × 新鲜度(pushed_at) + 0.35 × 热度(log10 stars) + 0.20 × 活跃度(forks / 归档状态)`，三个分量都在 0–100，右侧详情面板展示构成，不做黑箱打分。
- **时间轴**：`history.mjs` 从 Contents API 拉取 24 个真实历史版本逐版比对，得到新增 9 / 移除 27 / 换链接 2，不是模拟数据。

## 视觉体系

版式取 **Editorial Grid / Swiss Style**，因为它服务的是「索引」这件事本身：靠栅格、字号层级和发丝线建立秩序，而不是靠阴影和圆角制造层次。

- **颜色**：纸白 `#faf9f5` / 墨色 `#141413` / 单一朱红强调色 `#a82d22`；深色主题整体反转，强调色提亮为 `#e2604f`。全站只有一个强调色相（实测浅色 5°、深色 7°）。
- **形状**：圆角 0，无阴影、无渐变、无毛玻璃。分栏靠 1px 发丝线，不靠卡片堆叠。唯一保留的功能性圆角是进度条与开关。
- **字体**：标题宋体、正文黑体、数据等宽，全部使用系统中文字体栈（PingFang SC / HarmonyOS Sans SC / Microsoft YaHei / Songti SC）。**不请求 Google Fonts**——那在国内打不开，字体加载失败会让整页排版垮掉。
- **数据色阶**：按观测到的健康分区间拉伸（而非固定 0–100），深色主题使用反向色阶，瓦片文字色按底色相对亮度自动切换深/浅。颜色始终与文字标签配对，从不单独承担信息。
- **可执行的设计约束**：对比度 ≥ 4.5:1、单一强调色相、0 圆角、无渐变文字、无 emoji 当图标、触控 ≥ 44px、`prefers-reduced-motion` 降级，全部写成 `validate.mjs` 里的断言——规范写在文档里会被遗忘，写成测试才不会。

## 本地运行

```bash
python -m http.server 8765     # 或 npm run serve
# 打开 http://127.0.0.1:8765
```

复现数据：

```bash
npm run build:data             # 解析 source/readme.md
node scripts/enrich-full.mjs   # 需要 GitHub 授权
node scripts/history.mjs       # 拉取上游历史版本
node scripts/bundle.mjs        # 生成前端数据
npm run validate               # 数据层验证
```

## 交叉验证

| 层 | 脚本 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| 数据 | `scripts/validate.mjs` | 用独立方法重新统计原始 README，校验解析、URL 归一化、指标范围、i18n 覆盖、历史 diff、产物完整性，并把设计规范变成可执行断言 | **51 / 51** |
| 浏览器 | `scripts/browser-check.py` | 真实 Chrome 无头浏览器点击五个视图、语言切换、命令面板、收藏、空结果回归、图谱标签几何碰撞、表格列溢出、控制台异常 | **67 / 67**，控制台 0 异常 |
| 线上 | 同上，`ATLAS_BASE=...` | 同一套 67 项断言直接打向已部署站点，避免「本地绿、线上坏」 | **67 / 67**，控制台 0 异常 |

详细报告与桌面 / 移动端截图见 [`docs/VALIDATION.md`](docs/VALIDATION.md) 和 `docs/screenshots/`。

## 部署到 GitHub Pages

线上地址：**https://odin1024.github.io/awesome-atlas/**

站点根目录即 Pages 根目录，`.nojekyll` 会跳过 Jekyll 处理。

**方式一：常规 git**（`github.com:443` 可达时）

```bash
git remote add origin https://github.com/<用户名>/awesome-atlas.git
git push -u origin main
```

**方式二：纯 REST API**（`github.com` 被代理拦截、只有 `api.github.com` 可达时）

```bash
GH_TOKEN=<有 Contents 写权限的令牌> node scripts/deploy-pages.mjs
```

脚本把全部 40 个文件作为 Git blob 上传并**合并为一次原子提交**（`blob → tree → commit → ref`），再尝试启用 Pages 并回显地址。`GH_DRY=1` 只打印清单；`GH_REPO` / `GH_BRANCH` 指定目标仓库与分支。

### 三个实际撞到过的坑

脚本里都已处理，改写部署逻辑时不要拆掉：

1. **GitHub App 令牌是只读的。** WorkBuddy 连接器发的 `ghu_` 令牌带 `contents: read`，对任何写入路径（建库、`git/blobs`、Contents API）都返回 `403 Resource not accessible by integration`。部署必须用 classic PAT（`repo` scope）或 fine-grained PAT（Contents 写）。脚本在第一次写入返回 403 时立刻停下并打印替代路径，不再逐文件刷几十行同样的错误。

2. **空仓库不能直接写 blob。** 没有任何提交的仓库，`git/blobs` 与 `git/refs` 一律返回 `409 Git Repository is empty.`。必须先用 Contents API 写一个文件建立第一棵树，之后原子提交才成立。脚本用 `.nojekyll` 作种子——它本来就要发布，所以不会留下额外文件。

3. **开启 Pages 需要 `administration: write`。** `POST /repos/{owner}/{repo}/pages` 的接受权限是 `pages=write,administration=write`；只给 Pages 写权限的 fine-grained 令牌会失败。两条路：给令牌加 Administration 写，或在 **Settings → Pages** 手动选 `main` / `/ (root)`。推荐后者——文件此时已经推送完成，点一次即可，不必为了这一步扩大令牌权限。

### 无凭据时的兜底

```bash
node scripts/bundle-single.mjs
```

把样式、数据和脚本内联成单个 `dist/index.html`（816 KB），可直接拖进 GitHub 网页上传，已实测通过全部浏览器检查。

> 内联有个值得记的陷阱：`String.prototype.replace` 的**字符串**替换串里，`$$` 会塌缩成一个 `$`。`app.js` 同时声明了 `$`（`querySelector`）和 `$$`（`querySelectorAll`），第一版因此把 `const $$ =` 写成第二个 `const $ =`，全文 `$$(...)` 调用静默退化成单元素查询——页面照常渲染，多元素逻辑全错却不报错。改用替换**函数**后解决，并加了「每段内容必须逐字出现在产物里」的构建后断言。

## 许可与边界

源内容来自 `sindresorhus/awesome`（CC0-1.0），本站保留原始名称、描述与链接，中文译文为本站增补。Star / Fork / 最近更新是**采样时点快照**，不是实时数据；生态时间轴反映的是上游 README 的变更与仓库 push 分布，不代表清单本身的质量评级。页面所有统计口径与「诚实边界」都写在页脚的数据说明里。
