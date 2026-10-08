# EasyBow 渲染层 UI / 交互体验审查报告

> 审查范围：`src/renderer/**`（3701 行）+ 主窗口配置 `src/main/index.ts`  
> 代码版本：v1.2.0 · React 19.3 + TypeScript 7 + electron-vite 5 · 无 UI 框架  
> 结论：**视觉一致性已具备中等水准，但存在 7 个会直接产生可见故障的 P0 缺陷，另有 11 项 P1 体验短板。** 建议按 P0 → P1 → P2 三批推进。

---

## 一、项目结构与技术栈

### 1.1 技术栈

| 层        | 选型                                                                    | 说明                                                                             |
| -------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 桌面壳      | Electron 44                                                           | 主进程 15 个 TS 模块，preload 走 `contextBridge` 暴露 `window.easybow`                   |
| 渲染       | React 19.3 + ReactDOM                                                 | 无路由、无状态库、无 CSS 框架                                                              |
| 构建       | electron-vite 5 + Vite 7                                              | 三段式：main / preload / renderer，别名 `@`→`src/renderer/src`、`@shared`→`src/shared` |
| 样式       | **单文件原生 CSS**（`styles.css`，612 行）                                     | 无 CSS Modules / Tailwind / styled-components，无 CSS 变量体系（仅有 `:root` 11 个变量）     |
| 类型       | TypeScript 7，`strict: true`                                           | `tsconfig.web.json` / `tsconfig.node.json` 双配置                                 |
| 浏览器内容    | `WebContentsView` 原生视图                                                | 由主进程按渲染层上报的 `getBoundingClientRect()` 摆位                                       |
| OCR / AI | onnxruntime-node、@huggingface/transformers、openai / @anthropic-ai/sdk | 全部在主进程                                                                         |

**关键架构特征**：浏览器网页区域不是 DOM，而是原生 `WebContentsView` 叠在渲染层之上。因此弹窗打开时必须调用 `setBrowserHidden(true)` 主动隐藏原生视图，否则原生视图会盖住 DOM 弹窗。

### 1.2 目录组织

```
src/
├── main/                主进程（15 模块：agent/ tabs/ overlay/ ocr/ testcase/ scheduler…）
├── preload/index.ts     contextBridge 白名单 API（src/preload/index.ts:1-60+）
├── shared/types.ts      466 行共享类型 + LAYOUT 布局常量 + DEFAULT_SETTINGS
└── renderer/
    ├── index.html       含 CSP meta（style-src 'unsafe-inline'，故内联 style 可用）
    └── src/
        ├── main.tsx     13 行入口：StrictMode > ErrorBoundary > App
        ├── App.tsx      303 行 · 唯一状态中枢，14 个 useState
        ├── styles.css   612 行 · 全部样式
        └── components/  10 个组件
```

### 1.3 组件划分

| 组件                    | 行数  | 职责                                           | 状态形态                                  |
| --------------------- | --- | -------------------------------------------- | ------------------------------------- |
| `App.tsx`             | 303 | 全局壳：页签/工具栏/收藏栏/面板 + 6 个弹窗开关 + Toast + 倒计时条   | **唯一"store"**，14 个 useState，无 Context |
| `TaskPanel.tsx`       | 555 | 右侧 AI 任务面板：任务输入、人工介入、状态条、最近任务、记忆、时间线、用量、反馈弹卡 | 5 个 useState + localStorage           |
| `TestPanel.tsx`       | 549 | 浏览器仿真测试：4 Tab（需求→用例/运行/报告/用例库）               | **20+ useState**，最重                   |
| `SettingsModal.tsx`   | 304 | AI 接口配置 + 预设 + cc-switch 导入 + 本地模型           | 10 个 useState                         |
| `ScheduleModal.tsx`   | 235 | 定时任务 CRUD                                    | 10 个 useState                         |
| `HistoryDropdown.tsx` | 173 | 历史搜索下拉（含 favicon 回退）                         | 3 个 useState                          |
| `KnowledgeModal.tsx`  | 139 | 问题经验库                                        | 6 个 useState                          |
| `TaskEditorModal.tsx` | 115 | 任务大编辑器 + 4 套模板                               | 0（受控）                                 |
| `Toolbar.tsx`         | 87  | 地址栏 + 导航 + 状态按钮                              | 2 个 useState                          |
| `TabBar.tsx`          | 41  | 页签栏                                          | 0（无状态，纯展示）                            |
| `BookmarksBar.tsx`    | 40  | 收藏栏（空时不渲染）                                   | 0                                     |
| `ErrorBoundary.tsx`   | 69  | 顶层崩溃兜底 + 「恢复界面」                              | class 组件                              |

**划分特征**：全部为"扁平单层"——**无一个容器/展示分离**。`TaskPanel` 同时承担数据订阅、7 个 UI 区块、3 个内联交互态（guide / hist / askDone）；`TestPanel` 把 4 个 Tab 塞进同一文件 549 行。所有数据经 `App.tsx` 的 props 单向下钻，**无 Context、无 reducer**。

### 1.4 全局样式方案

- **单文件全局 CSS**，`:root` 仅 11 个变量（`styles.css:1-14`）：`--bg / --panel-bg / --border / --text / --text2 / --accent / --accent-dark / --danger / --success / --warn / --chip-bg / --radius`。
- **无设计令牌体系**：圆角只有一个 `--radius: 8px`，却实际使用了 4px/5px/6px/8px/10px/11px/12px/15px 共 8 种圆角；阴影 3 种、灰阶 30+ 种硬编码 hex。
- 4 个 `@keyframes`：`fadeIn` `fadeUp` `popIn` `slideDown`（`styles.css:19-22`）+ `spin` `slidein`。
- **无 `:focus-visible`、无 `@media`、无 `prefers-reduced-motion`、无暗色主题**（全文件 0 处媒体查询）。
- 布局常量以 TS 对象形式共享：`LAYOUT = { TAB_BAR_H:36, TOOLBAR_H:44, PANEL_W:420 }`（`src/shared/types.ts:53-57`），与 CSS 数值**双份维护、无联动校验**。

### 1.5 状态管理方案

纯 `useState` + `useRef` + `useCallback`，**三级数据流**：

```
主进程 IPC ──onEvent──> App.tsx (useState) ──props──> 子组件
                              ↕
                    localStorage (bookmarks / history / fbAsked)
```

- 事件订阅：`App.tsx:85-114` 单个 `onEvent` switch，管理 tabs / agent-status / step / toast / ocr-status / countdown。
- 持久化：`App.tsx:60-70`（bookmarks）、`TaskPanel.tsx:41-47`（history）、`TaskPanel.tsx:200-202`（fbAsked 去重）。
- **无路由**——"视图切换"靠 6 个布尔开关（`settingsOpen` / `taskEditorOpen` / `kbOpen` / `historyOpen` / `scheduleOpen` / `testOpen`）+ TestPanel 内 1 个 `tab` 枚举，弹窗全部**条件挂载**（`{x && <Modal/>}`）。

---

## 二、分维度审查与优化建议

### P0 — 会直接产生可见故障（先修这批）

#### P0-1 `.hist-item` 类名冲突，两个完全不同的组件互相覆盖样式

- **位置**：冲突定义在 `src/renderer/src/styles.css:286-302` 与 `src/renderer/src/styles.css:510-519`；使用点在 `HistoryDropdown.tsx:113` 与 `TaskPanel.tsx:393`。
- **现状**：CSS 后定义者胜。`styles.css:510` 的 `.hist-item { font-size:12px; padding:3px 6px; display:flex; gap:6px }` 覆盖了 `styles.css:286` 的 `padding:6px 8px` 及配套 `.hist-info / .hist-title / .hist-url / .hist-time` 布局。结果：历史下拉里的条目**丢失 hover 背景 `#f4f6fa`、丢失 `visibility:hidden→hover 显示` 的操作按钮逻辑**，行高偏挤。
- **原因**：两个语义无关的组件共用了过于通用的类名，且 CSS 未做命名空间隔离。
- **建议**：历史下拉改用 `.hrow / .hrow-title / .hrow-url / .hrow-time / .hrow-op`（对齐既有 `h-*` 命名习惯）；TaskPanel 侧保持 `.hist-item`。
- **预期效果**：两处列表各自还原设计稿密度；历史下拉重新获得"hover 显形"的操作按钮与正确的行高。**改动量最小、收益最高，建议第一个做。**

#### P0-2 Toast 容器定位错误，遮挡工具栏右侧按钮

- **位置**：`styles.css:491` `.toasts { top: 46px; right: 12px; z-index: 200 }`。
- **现状**：TabBar(36) + Toolbar(44) = 顶部有 **80px** 才是工具栏底边。`top:46px` 让 Toast 起始位置落在工具栏**内部**，视觉上直接压住 🧪 测试 / ⚙ 设置 / 继续任务 按钮。Toast 又无 pointer-events 屏蔽，会吞掉点击。
- **原因**：写死 46 时只算了 TabBar(36)+10，与后续 Toolbar 增高的改动脱钩。
- **建议**：`top: calc(var(--tabbar-h) + var(--toolbar-h) + 10px)`，并把 `LAYOUT` 的三个常量落到 `:root` 作为 CSS 变量（`LAYOUT` 保留给主进程用，CSS 侧独立声明但同源注释关联）；同时 `.toasts { pointer-events: none }` + `.toast { pointer-events: auto }`。
- **预期效果**：Toast 落在收藏栏下方、不再遮挡与吞掉点击；窗口高度变化时位置自适应。

#### P0-3 倒计时条出现时，历史下拉面板定位错位

- **位置**：`HistoryDropdown.tsx:94` `style={{ top: LAYOUT.TAB_BAR_H + LAYOUT.TOOLBAR_H + 6 }}`；倒计时条在 `App.tsx:162-178`，渲染在 TabBar **之上**。
- **现状**：`sched-countdown-bar` 约 33px 高且插在 TabBar 上方，而历史面板的 `top` 是常量 36+44+6=86px，**没有计入倒计时条**。倒计时活跃期间打开历史面板，面板会盖住收藏栏、位置比平时高 33px。
- **原因**：布局用常量而非实测 DOM，与"倒计时条是可选的额外行"这一动态特性冲突。
- **建议**：`App.tsx` 用 `countdown ? 36+33 : 0` 偏移并把结果作为 prop 传给 `HistoryDropdown`；更好的做法是给 `.hist-panel` 改为 `position: absolute; top: 100%` 并挂在工具栏容器内，让偏移自动生效。
- **预期效果**：任何状态下历史面板都锚定在工具栏正下方，消除"位置会跳"的感知缺陷。

#### P0-4 三个"已使用但无样式"的类名（死样式 / 裸元素）

- **位置**：`TestPanel.tsx:325` `className="test-run-btns"`、`HistoryDropdown.tsx:156` `className="hist-foot-tip"`、`TestPanel.tsx:19` `cls: 'run-stopped'`。三者在 `styles.css` 中**均无定义**（已逐个 grep 确认）。
- **现状**：
  - `.test-run-btns` 无定义 → ④ 个 form-row 横排时该行按钮组没有 `display:flex; gap`，与上方 `.form-inline` 内其他行风格脱节，垂直方向还会被 `.form-inline { gap:12px }` 的 align-items:stretch 拉伸变形。
  - `.hist-foot-tip` 无定义 → 沿用 `.hist-foot` 的父级文字样式，但 `.hist-foot` 的 `font-size:11px` 继承到它，"单击在当前页签打开 · ⊕ 新页签打开"这句引导语字号过小且无次级色弱化。
  - `run-stopped` 无定义 → 已停止的运行横幅没有配色，与 `.run-passed/.run-failed/.run-running` 不成套。
- **建议**：补 `.test-run-btns { display:flex; gap:8px; align-items:flex-end }`、`.hist-foot-tip { color: var(--text2); opacity:.8 }`、`.test-run-banner.run-stopped { background:#f0f2f5 }`。
- **预期效果**：三处细节归位，成本极低。

#### P0-5 `--brand` 变量未定义，测试 Tab 激活态靠 fallback 兜底

- **位置**：`styles.css:553` `.test-tab.active { background: var(--brand, #3370ff); border-color: var(--brand, #3370ff) }`。
- **现状**：`:root`（`styles.css:1-14`）中**没有** `--brand`。目前靠 fallback 值 `#3370ff` 与 `--accent` 巧合相同而显示正常。一旦有人调整主题色改的是 `--accent`，测试 Tab 会**颜色漂移**，与 `.btn.primary`、`.status-badge.running` 不一致。
- **建议**：`:root` 增加 `--brand: var(--accent)`（或直接把这两处换成 `var(--accent)`）。
- **预期效果**：消除隐性分叉点，主色修改一处即可全局生效。

#### P0-6 TestPanel 把"未加载"渲染成"暂无"，首屏必然闪烁

- **位置**：`TestPanel.tsx:46` `useState<Array<...>>([])` + `TestPanel.tsx:461` `{reports.length === 0 && <div>暂无报告——运行一次测试后生成</div>}`；`TestPanel.tsx:49` cases 同样初值 `[]` + `TestPanel.tsx:496`。
- **现状**：这两个列表的"加载中"和"确实为空"共用 `length === 0` 判断。打开面板瞬间先渲染"暂无报告"/"用例库为空"，`IPC` 返回后才切换成真实内容或真正的空态。**这是一次明确的视觉跳变**（对比 `HistoryDropdown.tsx:37,106` 用 `entries === null` 区分，是正确写法，同项目内不一致）。
- **建议**：初值改为 `null`，判据统一为 `reports === null`（骨架/加载中）/ `reports.length === 0`（空态引导）。
- **预期效果**：消除首屏文案闪烁；与 HistoryDropdown 的加载态范式对齐。

#### P0-7 `Toolbar` 用数组字面量当 state，且编辑中的地址会被页签切换覆盖

- **位置**：`Toolbar.tsx:20` `const editing = useState(false)`；`Toolbar.tsx:23-25` 的 `useEffect` 依赖里没有 `editing`。
- **现状**：
  1. `editing[1](true)` 这种写法绕过了 Hook 解构（每次渲染都新建数组字面量），虽能工作但极易被误改，也拿不到稳定的 `setEditing` 引用。
  2. 真正的缺陷：用户正在地址栏里输入（`editing === true`）时，若 AI 触发页签切换导致 `activeTab.url` 变化，`useEffect` 里 `if (!editing[0])`虽会阻止覆盖——但 `editing` 是闭包快照，且**新一次渲染中 `useState` 返回的 `editing[0]` 才是新值**，逻辑勉强成立；一旦有人给该 effect 加了其他依赖或改成 `useRef`，就会立刻退化为"覆盖用户输入"。
- **建议**：改用 `const editingRef = useRef(false)`（或标准 `const [editing, setEditing] = useState(false)`），并在 effect 内读 `editingRef.current`；同时在 `onKeyDown` 的 Enter 分支里同步复位为 false。
- **预期效果**：把隐式契约变成显式状态，杜绝"输入被自动覆盖"这类难以复现的输入体验 Bug。

---


### P1 — 体验短板（本批建议一次做完）

#### P1-1 布局：无断点、无栅格，面板宽度写死 420px

- **位置**：`styles.css:161-167` `.panel { width: 420px; flex: none }`；窗口 `src/main/index.ts:96-99` `width:1480 / minWidth:1120`。
- **现状**：全文件 **0 处 `@media`**。最小窗口 1120px 时浏览器区仅剩 700px；`1120→760`（虽受 minWidth 限制，但拖到窄屏显示器/分屏）下面板会占到视口 50% 以上。更关键的是**面板内部没有任何响应式**：`.task-input` 固定 `height:128px`，`.usage-bar` 是 4 项 `gap:14px` 的单行 flex，在 420px 减去 padding 后刚好挤满、字体一旦放大就换行错位。
- **建议**：
  1. 引入 3 个断点：`@media (max-width:1280px){ .panel{width:360px} }` / `@media (max-width:1120px){ .panel{width:320px} .usage-bar{flex-wrap:wrap} }`；
  2. 面板加折叠态（`.panel.is-collapsed { width: 44px }` + 图标按钮），并在 `LAYOUT` 里加 `PANEL_W_COLLAPSED`，`App.tsx:127` 的 `setBrowserRect` 自动跟随（现有 `ResizeObserver` 已就绪，**零额外成本**）；
  3. `.usage-bar` 改 `flex-wrap: wrap; row-gap:4px`。
- **预期效果**：窄屏/分屏下可用性显著提升；折叠态让"以 AI 为主"的长任务场景能把整屏留给网页。

#### P1-2 布局：面板内左右间距四套混用（14 / 16 / 0）

- **位置**：同一列右对齐的区块用了 3 种水平内边距——`.panel-head { padding:10px 16px 7px }`（`styles.css:169`）、`.task-box { padding:0 16px 10px }`（`:176`）、`.status-line { margin:0 16px }`（`:224`）、`.mem-section { padding:8px 16px }`（`:330`）、`.timeline { padding:8px 16px 12px }`（`:339`）是 16，但 `.hist { padding:0 14px 6px }`（`:505`）与 `.usage-bar { padding:8px 14px }`（`:420`）是 **14**。
- **现状**：肉眼可辨的 2px 错位——"最近任务"模块与"任务记忆"模块左边界不重合，底部用量条又与上方错开 2px。这直接破坏用户偏好的"对称间距 / 明确对齐"观感。
- **建议**：抽 `--pad-x: 16px`（可选 `--pad-x-sm: 14px` 若确需视觉分组，则**成对使用**：`.hist` 与 `.usage-bar` 同为"底部归组"，用 14 是合理的，但必须统一说明），推荐做法是**全部统一为 16px**，靠背景/分隔线而非缩进表达分组。
- **预期效果**：右侧面板形成一条贯穿上下的干净左轴，对齐感立刻提升。

#### P1-3 视觉：字号 11 级（10 → 16px），缺层级系统

- **位置**：全文件散落 `10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15 / 16px`（例：`styles.css:65` 12px、`:118` 12px、`:192` 11px、`:205` 12px、`:437` 16px、`:541` 15px、`:456` 13px、`:573` 11.5px）。
- **现状**：相邻层级的差异只有 0.5px（如 12 / 12.5 / 13 三个字号用在同一面板内），这在 Windows 渲染（`-apple-system` 回落到 Segoe UI）下会出现**半像素抖动与字重视觉失衡**，是"看起来不精致"的典型来源。
- **建议**：收敛为 5 档令牌并写进 `:root`：
  ```css
  --fs-caption: 11px;  /* 时间戳、meta、tag */
  --fs-body:    13px;  /* 正文（当前基准，已是 13px） */
  --fs-sub:     14px;  /* 弹窗标题区 */
  --fs-title:   15px;  /* 面板标题 */
  --fs-h:       16px;  /* 弹窗 h3 */
  ```
  同级差至少 1px。
- **预期效果**：文字层级一眼可辨，消除"到处都是字"的噪声感。

#### P1-4 视觉：硬编码 hex 泛滥，主题变量只覆盖了 20%

- **位置**：`#f4f6fa`（`:224` `:289` `:335` `:509` `:514` 5 处）、`#f7f8fa`（`:100` `:413` `:521` `:550` `:563` `:583`）、`#b3bac4`（`:157` `:285` `:467` 3 处）、`#a2a8b3`（`:73` `:192` `:296` `:305` 4 处）、`#f0f2f5`（`:90` `:102` `:352` `:458` `:475` 5 处）……此外 `.btn.danger` 在 `styles.css:219` 与 `:389` **重复定义且颜色不一致**（`var(--danger)` #e54545 vs `#c0392b`），后者胜出。
- **建议**：补齐 `:root` 令牌（`--hover: #f0f2f5` / `--subtle-bg: #f4f6fa` / `--input-bg: #f7f8fa` / `--text3: #a2a8b3` / `--placeholder: #b3bac4`）；**删除 `.btn.danger` 的重复定义，保留一处**。
- **预期效果**：改一处即可全局换肤；消除 danger 色出现两个值的隐患（当前"停止"按钮与"删除"按钮颜色其实不同）。

#### P1-5 视觉：交互控件 4 套圆角/尺寸体系并存

- **位置**：`.btn` 32px 高 / `padding:0 16px` / radius 8（`:209`）vs `.btn.mini` `padding:3px 10px; font-size:11px; height:auto`（`:527`）vs `.preset` `padding:3px 10px; radius:12px`（`:480`）vs `.fav-chip` `height:22px; radius:11px`（`:127`）vs `.expand-btn` `height:22px; radius:11px`（`:187`）。
- **现状**：同一个 `.btn` 家族因 `.mini` 覆写 `height` 导致**基础按钮与 mini 按钮垂直居中行为不同**；`preset` 与 `fav-chip` 是 chip 却半径不同（12 vs 11），肉眼几乎看不出差别但属于不一致。
- **建议**：定义 3 档尺寸令牌 `--btn-h-lg:32 / --btn-h-md:28 / --btn-h-sm:22` + 2 档 chip 半径（全部 11px），`.mini` 不再覆写 `height` 而用 `height:22px; padding:0 10px`。
- **预期效果**：按钮族视觉重量统一，行内混排（`.sch-item-ops` 的 改/停/删 三连按钮）不再忽高忽低。

#### P1-6 交互：全局零焦点样式，键盘用户"看不见自己在哪"

- **位置**：全文件仅 4 处 `:focus`（`.addr` `:103`、`.hist-search input` `:282`、`.task-input` `:206`、`.form-row input/select` `:447`、`.sch-task-input` `:388`、`.test-md-input` `:561`），**全部是 `:focus`（鼠标点击也会触发）而非 `:focus-visible`，且没有任何 `:focus-visible` 规则**。
- **现状**：`<button className="btn">`、`.nav-btn`、`.preset`、`.tab`、`.hist-item` 等**全部无可见焦点环**。`.nav-btn` 只有 `border:1px solid transparent`，即使加了 outline 也需注意与边框合并。
- **建议**：


  ```css
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  input:focus-visible { outline: none; } /* 输入框已有 border+ring 反馈 */
  ```
  同时给 `.tab-nav-btn` 保留 `border-color: var(--accent)` 以免 outline 与边框重叠。
- **预期效果**：Tab 键遍历时始终有可见落点；同时因为用的是 `:focus-visible`，鼠标点击**不会**出现多余焦点框——正好符合"视觉干净"的要求。

#### P1-7 交互：交互元素用 `div`/`span` 承载，完全不可键盘操作

- **位置**：`TabBar.tsx:14`（页签 `<div onClick>`）、`Toolbar.tsx` 历史/测试/设置用 `<button>`（好）、`BookmarksBar.tsx:18`（收藏 chip `<span onClick>`）、`HistoryDropdown.tsx:111`（历史条目 `<div onClick>`）、`TaskPanel.tsx:393`（最近任务 `<div onClick>`）、`SettingsModal.tsx:141`（预设 `<span onClick>`）、`KnowledgeModal.tsx:112-129`（✅/✎/🗑 `<button>` 但无 `aria-label`）、`App.tsx:216`（关闭按钮 `<span className="close-x">`）、`TestPanel.tsx:463`（报告行 `<div onClick>`）。
- **现状**：除真正的 `<button>` 外，约 **10 处可点击元素是 div/span**，无 `tabIndex`、无 `role`、无键盘事件。全应用**没有任何全局快捷键**（无 Ctrl+T 新建页签、Ctrl+W 关闭页签、Ctrl+L 聚焦地址栏、F5 刷新、Esc 全局兜底）——对浏览器类应用这是相当明显的功能缺口。
- **建议**（按投入从低到高）：
  1. **低成本**：所有弹窗的 `.close-x`（`SettingsModal.tsx:127`、`ScheduleModal.tsx:123`、`TaskEditorModal.tsx:66`、`KnowledgeModal.tsx:59`、`TestPanel.tsx:217`）改为 `<button type="button" aria-label="关闭">`——本项目最集中的无障碍缺口，5 处；
  2. **中成本**：`TabBar` / `BookmarksBar` / `HistoryDropdown` / `TaskPanel` 的可点元素补 `role="tab"/"button"` + `tabIndex={0}` + `onKeyDown` 处理 Enter/Space（可抽一个 `useClickable` hook 统一）；
  3. **独立收益**：`App.tsx` 挂一个全局 `keydown`：Ctrl/Cmd+T/W/L、Ctrl+R/F5、Esc（Esc 优先级：无弹窗→关闭历史面板 → 清空地址栏）。注意需 `window.easybow` 暴露对应方法。
- **预期效果**：全键盘可完成"新建页签→输入网址→运行任务"主流程；自动化测试与屏幕阅读器可用。

#### P1-8 交互：弹窗无焦点陷阱、无焦点归还、多数无 Esc 关闭

- **位置**：5 个弹窗中**只有 `TaskEditorModal.tsx:62,90` 支持遮罩点击关闭 + Esc**；`HistoryDropdown.tsx:51-57` 有 Esc 但只是 `onClose`；`SettingsModal` / `ScheduleModal` / `KnowledgeModal` / `TestPanel` **既无 Esc 也无焦点管理**（`SettingsModal.tsx:122` 还特意注释"不做点击遮罩关闭"——意图合理，但同样没补 Esc）。
- **现状**：打开设置弹窗 → 焦点仍在 `Toolbar` 的 ⚙ 按钮上；连按 Tab 会跑到**遮罩背后的地址栏、页签**（因为 DOM 顺序在后面），用户会"消失"。关闭后焦点也不回到触发按钮（依赖浏览器默认，多半落在 body）。
- **建议**：抽 `useModalFocus(ref, onClose)` 统一处理 4 件事——打开时 `focus()` 首个可聚焦元素/容器、保存 `document.activeElement`、监听 Tab 做 focus trap、关闭时归还焦点；并给全部弹窗挂 Esc（`SettingsModal` 保持"点遮罩不关闭"但 Esc 关闭，两者语义不冲突）。
- **预期效果**：键盘与鼠标体验统一；顺带解决"弹窗打开后浏览器区被隐藏（`App.tsx:154`）但 DOM 焦点仍在背景"的隐性割裂。

#### P1-9 动画：只有进场没有退场，弹窗/面板切换是"硬切"

- **位置**：4 个 keyframes（`styles.css:19-22`）全为 `from → to`，无退出态；`.modal-mask` 只有 `animation: fadeIn .18s`（`:429`）、`.modal` 只有 `popIn .2s`（`:435`）；`.toast` 只有 `slidein`（`:494`）；`.img-viewer`（`:502`）与 `.fb-mask`（`:532`）**完全无动画**。
- **现状**：所有弹窗关闭时元素立即从 DOM 移除，退场无过渡——在 120~240ms 的入场动画对比下，关闭显得"生硬"。`.fb-card`（任务完成反馈）是最高频打扰弹层，却零动画。
- **建议**：新增退出动画并配合卸载时机：
  ```css
  @keyframes fadeOut { to { opacity: 0 } }
  @keyframes popOut { to { opacity: 0; transform: scale(.97) } }
  .modal-mask.closing { animation: fadeOut .14s ease-in forwards; }
  .modal.closing { animation: popOut .14s ease-in forwards; }
  .fb-mask { animation: fadeIn .18s ease-out } .fb-card { animation: popIn .22s cubic-bezier(.2,.9,.3,1.2) }
  ```
  JS 侧加 140ms 的 `closing` 态再置 `null`（抽 `useDelayedUnmount(open, ms)` 复用 6 处弹窗）。入场曲线建议统一为 `cubic-bezier(.2,.8,.3,1)`。
- **预期效果**：开合有呼吸感；顺带把当前混用的 `ease-out` / `linear` / 默认 `ease` 收敛为一套缓动。

#### P1-10 动画：`.btn.primary` 的 hover 上浮 + active 缩放互相打架

- **位置**：`styles.css:218` `.btn.primary:hover { transform: translateY(-1px); box-shadow: 0 3px 10px ... }` 与 `:215` `.btn:active { transform: scale(.97) }`。
- **现状**：hover 时按钮上浮 1px，鼠标按下瞬间又从 -1px 变成 scale(.97)（缩小），产生"缩回"的突兀位移；且 hover 阴影 `0 3px 10px` 比默认态重很多，在 `.guide-ops` 这种紧凑行里显得过响。
- **建议**：`:active` 改为 `transform: translateY(0) scale(.97)`（保持向下语义连贯），或直接给 primary 的 hover 只加阴影不加位移；阴影从 `0 3px 10px rgba(...,.28)` 降到 `0 2px 6px rgba(...,.22)`。
- **预期效果**：按下反馈稳定，不再"跳一下"。

#### P1-11 动效时长与缓动不统一

- **位置**：`.12s`（`styles.css:135,215`）、`.14s`（`:212`）、`.15s`（多处 input）、`.18s`（`:429`）、`.2s`（`:435,494`）、`.22s`（`:242`）、`.25s`（`:226,342,373`）、`.8s`（spin `:64`）——共 8 档；缓动值混用 `ease`（默认）、`ease-out`、`linear`。
- **建议**：定义 `--t-fast:120ms / --t-base:180ms / --t-slow:250ms` 与 `--ease: cubic-bezier(.2,.8,.3,1)`；`spin` 保留 `linear`（旋转必须匀速）、`@keyframes spin .8s` 明确为"加载指示器时长"，不参与体系。
- **预期效果**：界面"呼吸节奏"统一；后续新增动画有明确取值参照。

#### P1-12 功能切换：弹窗条件挂载导致状态丢失（用例编辑成果会消失）

- **位置**：`App.tsx:241-293` 六个弹窗全为 `{x && <Comp/>}`，且 `App.tsx:153` 会把状态同步给主进程隐藏浏览器视图。
- **现状**：最痛的一条是 **`TestPanel.tsx:525` 的 ⏰ 按钮** → `App.tsx:271-275` 关闭 TestPanel、打开 ScheduleModal。TestPanel 里的 `reqMd` / `caseMd`（用户可能写了半小时的用例 MD）、`tab` 位置、滚动位置**全部卸载丢失**。定时任务弹窗只能靠 `onScheduleCase` 传 id/name 重建，之后想回去改用例要重新粘贴。同理 `SettingsModal` 与 `TestPanel` 叠加时，TestPanel 因为仍挂载（`testOpen` 未变）所以幸免，但 `kbOpen` / `historyOpen` 之间互切同样是整块卸载。
- **建议（分两档）**：
  - **轻量**（推荐先做）：把弹窗改为"常驻挂载 + `hidden`/`display:none`"或用 CSS `visibility` 控制，配合 `useDelayedUnmount` 做退场动画。改动集中在 `App.tsx:241-293`，`onClose` 语义不变。
  - **彻底**：把 `TestPanel` 的用例草稿（`reqMd`/`caseMd`/`libTags`）提到 `App.tsx` 或 localStorage（key 建议 `easybow.testcase.draft`），与弹窗生命周期解耦。
- **预期效果**：用户跨弹窗往返不丢工作内容——这是"功能切换时状态保持"的核心诉求。

#### P1-13 状态管理：无 Context，props 逐层下钻导致 3 处真实逻辑缺陷

- **位置**：`App.tsx:225-238`（TaskPanel 收 12 个 props）、`TestPanel.tsx` 内 20+ useState、`TaskPanel.tsx:117-119` 的 `useEffect(..., [status.task])` 读取 `props.steps`。
- **现状**：
  1. `App.tsx:3` `import { LAYOUT } from '@shared/types'` **完全未被使用**（死导入，`noUnusedLocals: false` 掩盖了它）；同一常量在 `HistoryDropdown.tsx:94` 真正在用——说明布局常量的归属没理清。
  2. `TaskPanel.tsx:180-194` 写历史的 effect 依赖数组是 `[status.state]`，但体内读 `props.steps`——依赖缺失，若将来 `steps` 更新时机变化会写入过期摘要。（`App.tsx:117-119` 同类问题：`useEffect` 体内用 `status.stepCount`，依赖却是 `[status.task]`。）
  3. `App.tsx:152-158` 的 `hidden` 与 `browserCovered` 是**两份完全相同的七元素 OR 表达式**，改一处忘另一处就会出现"弹窗开着但浏览器没隐藏"的严重视觉 bug。
- **建议**：
  1. 抽出 `const overlayOpen = settingsOpen || viewer || …` 单一来源，`hidden` 与 `browserCovered` 复用（**这个必须修**，属埋雷）；
  2. 补齐两个 effect 的依赖数组（`[status.state, status.stepCount, props.steps]` / `[status.state, status.stepCount]`），必要时用 `useRef` 拿最新值避免过度触发；
  3. 删除 `App.tsx:3` 的死导入。
- **预期效果**：消除"两处表达式不同步"这一类必然发生的 bug，并让后续 hook lint 干净。

#### P1-14 滚动：未定义滚动条样式，紧凑 UI 下默认滚动条过宽抢戏

- **位置**：全文件仅 `.favbar-list::-webkit-scrollbar { display:none }`（`styles.css:120`）一处滚动条处理；`.timeline`（`:339`）、`.hist-list`（`:284`）、`.mem-section`（`:330`）、`.sch-list`（`:369`）、`.kb-list`（`:466`）、`.modal`（`:432`）、`.test-steps`（`:598`）等 7 处可滚动容器共用系统默认滚动条。
- **现状**：Windows 默认滚动条宽约 17px，在 420px 面板里占掉 4% 宽度；`.mem-section` 只有 130px 高却要吃掉一条 17px 滚动条，非常刺眼。
- **建议**：
  ```css
  .timeline, .hist-list, .mem-section, .sch-list, .kb-list, .test-steps {
    scrollbar-width: thin; scrollbar-color: #c8ccd4 transparent;
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: #c8ccd4; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #aeb4c0; }
  ::-webkit-scrollbar-track { background: transparent; }
  ```
- **预期效果**：面板可用宽度增加，滚动不再喧宾夺主；跨平台一致（`scrollbar-width` 同时覆盖 Windows/Linux）。

---

### P2 — 打磨项（可延后）

| #    | 问题                                        | 位置                                                                            | 建议                                                                                                                                                                                                                                   | 预期效果                                                            |
| ---- | ----------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| P2-1 | 无 `prefers-reduced-motion` 支持             | `styles.css` 全文                                                               | 追加 `@media (prefers-reduced-motion: reduce){ *,::before,::after { animation-duration:.01ms!important; animation-iteration-count:1!important; transition-duration:.01ms!important } }`（**必须保留 `spin` 的可读性**，可对 `.t-loading` 单独豁免为 3s） | 前庭敏感用户可用；遵循 WCAG 2.3.3                                          |
| P2-2 | 语义化不足，屏幕阅读器不可用                            | `TaskPanel.tsx:374` 状态条、`.status-badge`                                       | `role="status" aria-live="polite"`（状态变化）、`role="dialog" aria-modal="true" aria-labelledby`（各弹窗）、`aria-label`（`KnowledgeModal.tsx:112-129` 的 ✅/✎/🗑 与 `Toolbar.tsx` 各 icon 按钮 title 已有，可直接提升为 aria-label）                             | 状态变更能被朗读                                                        |
| P2-3 | Emoji 与文字按钮混用，无图标体系                       | `Toolbar.tsx:68-83`（🕐🧪⚙）、`TaskPanel.tsx`（⏸▶⏹📚⏰📷）、`TabBar.tsx:29,35`（✕ ＋）  | 短期保留 emoji（已形成语言一致性，替换成本高），但**统一尺寸容器**（`.nav-btn` 已是 30×30 居中；给 `.expand-btn`/`.btn.mini` 内的 emoji 加 `font-size:12px; line-height:1`），避免不同 emoji 字形导致的基线抖动                                                                           | 按钮文字不再"忽高忽低"                                                    |
| P2-4 | `.modal-mask` 无背景模糊，深色模式下弹窗边界弱            | `styles.css:427`                                                              | 改为 `background: rgba(15,20,30,.38); backdrop-filter: blur(2px)`；同时 `.modal` 补 `display:flex; flex-direction:column` + 头/体/脚三段（`.modal { max-height:88vh; overflow:auto }` 目前整体滚动，标题栏会随内容滚走——这是**独立的小缺陷**，见下）                         | 弹窗层级更清晰                                                         |
| P2-5 | 弹窗标题栏随内容滚走                                | `styles.css:432-437` `.modal { overflow:auto }` + `h3 { margin-bottom:16px }` | 改为 `max-height:88vh; display:flex; flex-direction:column`，`h3` 固定（`flex:none; border-bottom:1px solid var(--border); padding-bottom:10px`），内容区 `flex:1; overflow:auto`                                                               | `SettingsModal` 内容很长，滚动时 ✕ 关闭按钮不再消失——**这是当前真实可见的可用性问题，建议提到 P1** |
| P2-6 | 面板 `.timeline` 空态是纯文字，无引导动作               | `TaskPanel.tsx:451-457`                                                       | 空态加一个"插入模板"按钮（复用 `TaskEditorModal.tsx:3-36` 的 4 套模板），点击直接开大编辑器                                                                                                                                                                       | 新用户 0→1 路径更短                                                    |
| P2-7 | `LAYOUT` 与 CSS 数值双份维护                     | `src/shared/types.ts:53-57` vs `styles.css` 各处                                | 保留 `LAYOUT`（主进程需要），但在 `:root` 注释标注"与 LAYOUT 同步"，并在 `App.tsx:122-142` 的 `report()` 里加 dev 断言：`Math.abs(el.getBoundingClientRect().top - LAYOUT.TAB_BAR_H - LAYOUT.TOOLBAR_H) > 4` 时 console.warn                                      | 改动 TabBar 高度时能被立刻发现                                             |
| P2-8 | `.test-tab { transition: all .15s }` 性能隐患 | `styles.css:551`                                                              | 改为 `transition: background-color .15s, border-color .15s, color .15s`                                                                                                                                                                | 避免未来给该元素加 `width/height` 时产生意外过渡                                |

---

## 三、建议实施顺序

| 批次                | 内容                                                                                                         | 理由                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **第 1 批（约 1 小时）** | P0-1 `.hist-item` 冲突 · P0-2 Toast 定位 · P0-3 历史面板定位 · P0-4 三个缺失类 · P0-5 `--brand` · P1-2 间距统一 · P2-5 弹窗标题固定 | 全是纯 CSS，改动小、零回归风险，直接消除全部肉眼可见缺陷               |
| **第 2 批（约 2 小时）** | P0-6 TestPanel 空态闪烁 · P0-7 Toolbar editing · P1-13 两处表达式去重 + 依赖补齐 · P1-14 滚动条                              | 修真实逻辑缺陷，防"必然发生的 bug"                         |
| **第 3 批（约 3 小时）** | P1-6 焦点样式 · P1-7 键盘可达 + 快捷键 · P1-8 焦点陷阱 hook                                                               | 无障碍一次性铺到位（5 个 `.close-x` 改 button 是性价比最高的起点） |
| **第 4 批（约 4 小时）** | P1-1 响应式 + 面板折叠 · P1-3 字号令牌 · P1-4 颜色令牌 · P1-5 控件尺寸 · P1-9 退场动画 · P1-10/11 动效体系 · P1-12 弹窗常驻               | 需要重构，建议单独一轮                                  |
| **可选**            | P2 全部                                                                                                      |                                              |

## 四、说明与未覆盖项

- 本报告仅审查**渲染层 UI/交互**。主进程 15 个模块（agent / tabs / OCR / executor 等）与构建脚本未做质量审查。
- 未实际启动应用做像素级走查（需 `npm run dev` 且依赖 GPU/WebContentsView 环境）。所有结论基于源码静态分析；标注"需实机确认"的项请在实施时验证。
- 建议落地后跑 `npm run typecheck` 确认改动未引入类型问题；样式改动建议逐条肉眼回归（尤其 P0-1 会同时影响历史下拉与最近任务两处）。
