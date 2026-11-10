# TRAE 实践记录（3 个任务 · 3 个 Session ID）

> 赛事要求：提供至少 3 个 TRAE Session ID + 对应截图，证明作品是用 TRAE 做出来的。
> 本文把本项目真实的三个开发阶段整理成可直接截图的任务卡。**Session ID 必须从你的 TRAE 客户端复制真实值，不要编造**——评委可能核验。

## 0. 怎么拿到 Session ID（30 秒）

1. 打开 TRAE，左侧点「历史会话」。
2. 按下面的任务标题找到对应会话（标题通常是首条提问的前半句）。
3. 打开该会话 → 右上角 `···` 或会话标题旁的下拉 → 复制会话 ID / 分享链接。
4. 把 ID 填进本文对应任务的 `Session ID` 行，并截一张「会话列表 + 该会话标题」的图。

| 任务 | 对应会话的首条提问（用于在历史里找） | Session ID |
| --- | --- | --- |
| 任务 A · 方案与信息架构 | 「做一个 awesome 清单的可视化站点……」 | `【填真实 Session ID】` |
| 任务 B · 数据管线与五视图 | 「把上游 README 解析成数据，并做分类地图 / 图谱 / 榜单……」 | `【填真实 Session ID】` |
| 任务 C · 全量审计与修复 | 「全面检查项目情况，看看还存在哪些问题」 | `【填真实 Session ID】` |

> 如果历史会话标题与上表不完全一致，以内容为准：任务 C 对应的是包含「13 个问题清单」「95/95」「127/127」的那次会话。

---

## 任务 A · 方案与信息架构

**目标**：把一篇几万字的 Markdown 清单，设计成一套能回答具体问题的可视化结构。

**在 TRAE 里做的事**
- 让 TRAE 先做「问题拆解」：列出用户打开 awesome 文档时真正想做的 5 件事，再倒推需要几个视图。
- 确定信息架构：分类地图（结构）、关系图谱（从属）、检索榜单（查找）、生态时间轴（演化）、数据洞察（分布）。
- 定设计令牌：纸白 `#f7f5f0` / 墨黑 `#14130f` / 单一朱红强调色；0 圆角；四档数据色阶；深浅色各一套。
- 产出可执行的验收口径：对比度 ≥ 4.5:1、触控 ≥ 44px、颜色不单独编码信息。

**可核验产物**
- `index.html` 的 5 个 `role="tab"` 视图与 `assets/styles.css` 令牌层。
- `README.md` 的「五个视图」与「设计约束」章节。
- 设计约束后来全部变成了 `scripts/validate.mjs` 里的断言。

**截图建议**：TRAE 会话里「问题拆解 → 视图方案」的回复；再截一张线上首屏。

---

## 任务 B · 数据管线与五视图实现

**目标**：让页面上每个数字都能被脚本复算，而不是手写。

**在 TRAE 里做的事**
- 写解析器：从上游 README 抽取分类、条目、链接、锚点与父子层级。
- 用 GitHub GraphQL 批量补全 673 个仓库的星标 / Fork / 语言 / 归档 / 最近推送（`scripts/enrich-full.mjs`）。
- 对上游 24 次修订做差分，得到新增 / 移除 / 改链，生成生态时间轴（`scripts/history.mjs`）。
- 实现五个视图与命令面板、URL 状态同步、深浅色、移动端底部导航。
- 建立校验体系：`validate.mjs`（数据层）+ `browser-check.py`（真实 Chrome 逐控件点击）。

**可核验产物**
- 提交 `d1ccf48`（`Stop shipping preview artifacts, track the CI workflow`）及之前的构建提交。
- `data/catalog.json`：27 分类 / 678 条 / 673 个 GitHub 仓库 / 466 条中文译文。
- `data/history.json`：24 次修订，2025-10-27 → 2026-09-02。
- `docs/VALIDATION.md`：自动生成的校验报告。

**截图建议**：TRAE 会话里出现「GraphQL 批量查询」「补全 673 个仓库」的片段；终端里 `node scripts/validate.mjs` 的输出。

---

## 任务 C · 全量审计与修复（本次）

**目标**：在报名前把「看起来能用」变成「经得起评委逐项点」。

**在 TRAE 里做的事（13 项问题 → 全部关闭）**
1. **后退失效**：原来只有 `replaceState`，浏览器后退直接离开站点。改为离散操作 `pushState`，`popstate` 重新应用 URL 状态。
2. **存储禁用白屏**：`localStorage.getItem` 未捕获异常会中断整个脚本，页面 0 瓦片。改为 `readStore` / `writeStore` 兜底。
3. **命令面板焦点**：无焦点陷阱、关闭后焦点丢失。改为 Tab 循环 + 焦点归还触发按钮 + `aria-expanded`。
4. **表格行键盘**：`tr` 有 `tabindex` 但回车无效。改为 Enter / Space 等价点击。
5. **图谱键盘**：分类节点鼠标专属。补 `tabindex` + `role="button"` + `aria-label`。
6. **标签栏**：补 roving tabindex、左右方向键、Home / End、`aria-controls`。
7. **axe 违规**：树图 `role="img"` 内嵌可聚焦瓦片 → 改 `role="group"`；页脚正文链接补下划线；移动端视图切换补 `role="group"` + `aria-pressed`。
8. **对比度**：选中分类计数 4.23:1 → 改用 `--ink-2`，实测过 4.5:1。
9. **触控尺寸**：移动端星标 26×22、外链 15×15、文字按钮 22×23 → 全部 ≥ 44×44，并写进断言。
10. **隐私文案与元数据**：移除唯一第三方脚本（访问量统计），让「无境外依赖」成为事实；`og:image` 从不匹配的 3200×920 横幅改为 2400×1260 社交卡。
11. **部署清单**：跳过 `.preview` 与 `submission`，不再上传本地渲染产物。
12. **脚本一致性**：`npm run enrich` 从 31% 抽样旧链路改为全量 GraphQL；旧链路保留为 `enrich:legacy`。
13. **文档真实性**：README 中英两版的体积、文件数、断言数量与隐私表述全部对齐实测。

**可核验产物**
- 本次修复提交：`【填 git log --oneline -1 的 7 位哈希】`
- `node scripts/validate.mjs` → **95 / 95 passed**
- `python scripts/browser-check.py` → **127 / 127 passed，0 console errors**
- axe-core（桌面 / 移动 / 深色 / 命令面板）→ **0 违规**
- CI：数据层 + 浏览器层双 job（`.github/workflows/validate.yml`）

**截图建议**：TRAE 会话里「13 个问题」的表格；终端里 95/95 与 127/127 两行输出。

---

## 证据链（评委核验用）

| 证据 | 位置 |
| --- | --- |
| 线上可体验 | https://odin1024.github.io/awesome-atlas/ |
| 源码 | https://github.com/odin1024/awesome-atlas |
| 数据层报告 | `docs/VALIDATION.md` / `data/validation.json` |
| 浏览器层报告 | `data/browser-check.json` |
| 上游一致性 | `scripts/validate.mjs` 重新抓取 README 并比对哈希 |
| CI | GitHub Actions · `Validate data` / `browser` 两个 job |
