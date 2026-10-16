# EasyBow v4.5 优化方案：操作精准度、速度与节点可靠性

* **日期**：2026-10-14
* **基线版本**：v4.4.0
* **作者视角**：逐文件精读当前源码后的结论，全部标注 `文件:行`；性能数字是**代码路径推演的相对量**，落地需按第七节的度量方法实测确认。
* **两个专项**：
  1. **截断识别** —— 页面模块名/表单字段名被 CSS 省略号或 JS 截断时，如何保证模型拿到的是全称、并能稳定命中。
  2. **节点可靠性** —— 节点规划要"接地、可复核、能自愈"，而不是盲飞 + 事后补救。

---

## 〇、TL;DR

现状不是"模型不够强"，而是**三个结构性缺口**：

| # | 缺口 | 证据 | 后果 |
|---|---|---|---|
| **A** | **规划完全盲飞**：节点链在第一次提取页面**之前**生成，模型看不到任何真实元素 | `runner.ts:1758-1762` 先 `buildPlan(task)`，`buildPlan` 只传任务文本（`runner.ts:1324`）；第一次 `extract` 在 `runner.ts:1811` | 节点是"凭想象写的工作流"，`expected` 与页面实际叫法脱节 → 复核必然 uncertain → 退化放行 → 复核形同虚设 |
| **B** | **文本单源 + 截断长度不对称**：元素文案只取一个来源，JS 截断时全称被丢弃；快照 80 字 vs 实时回读 40 字 | `extractor.ts:146-147`（innerText 空才读 title）、`extractor.ts:144`（截 80）、`extractor.ts:782`（RESOLVE 回读截 40） | 模型从截图看到"收货人姓名…"，DOM 里全称在 `title` 里却被丢弃；`expect_text` 用截断串匹配全称时双向 `includes` 有边界失败 |
| **C** | **复核证据取样位置错**：L1/L2 复核喂的是 `body.innerText` **前 1200 字** | `verify.ts:88-90` | ERP 长页面上目标区域常在第 5000 字之后 → 云端大模型也看不到证据 → 只能判 uncertain → 按"未通过"处理 → 反复重规划耗步数 |

三个 P0 修复（合计约 3～4 天，全部有确定性验收）：

1. **`textOf` 多源采集 + `truncated` 标记 + 统一截断长度**（专��一）
2. **接地规划：先提取页面再规划 + `PlanValidator` 确定性校验 + 节点强制 `check`**（专项二 A）
3. **复核证据包：变更摘要 + 目标区域切片，取代全文前 1200 字**（专项二 B）

---

## 一、现状体检

### 1.1 规划与执行链路（实测顺序）

```
loop()  runner.ts:1725
  ├─ buildPlan(task)            ← L1758-1762，【无页面快照】
  ├─ extract() + screenshot + AX  ← L1811-1865，并行
  ├─ deltaVerify                ← L1889-1952（只做诊断提示，不拦）
  ├─ friction / captcha         ← L1966-2016
  ├─ prescreen（本地 0.5B 初筛） ← L2106-2152，soft budget 1200ms
  ├─ formatForPrompt            ← L2153-2180（重排后的编号渲染）
  ├─ provider.chat()            ← L2238
  ├─ executeBatch               ← L2447-2464
  ├─ diagnose / applyDiagnosis  ← L2517-2560（自愈提示）
  └─ verifyNode()               ← L2671-2701（L0/L1/L2）
```

**关键观察**：节点链在第一行 `extract` 之前就产出了。此时模型手里只有任务文本，它写的 `expected`（"页面出现搜索结果列表"）是**先验知识**而非**观察**。这是与 Codex/Doubao 类产品最大的结构性差距——它们每一步的决策都锚在当轮真实观测上（见第五节对标）。

### 1.2 定位链（`resolveIndex`，executor.ts:559-670）

现有阶梯已经很扎实，这部分**不需要重写**，只需要加"更便宜的入口"和"更准的指纹"：

```
path + expectTag  →  实时 text 身份校验(v4.2)  →  【全页重提取 L585】  →  ②anchor 消歧
                                                                        →  ①tag+精确文本
                                                                        →  ②′extra 提示匹配
                                                                        →  ③role+tag 最近邻
                                                                        →  ④坐标兜底(HIT_TEST 守卫)
```

问题不是阶梯不够，是**入口判定太晚**：`executor.ts:585` 的全页重提取（`this.extract(t)`，整棵 DOM 重新遍历 + 跨域 frame 补采）在任何 path/tag/text 失败时被无条件触发，是失败路径上最贵的一步。而且 `executor.ts:585` 的重提取**不带 task**（不做语义重排），候选池质量低于正常步骤。

### 1.3 文本采集与匹配的全部比较点

| 位置 | 规则 | 文件:行 |
|---|---|---|
| 快照文案 | `innerText.slice(0,80)` → 空则 `aria-label(50)` → 空则 `title(50)` | `extractor.ts:144-147,163` |
| 实时回读文案 | `innerText \|\| aria-label \|\| title`，截 **40** | `extractor.ts:766-782` |
| v4.2 身份校验 | 空白折叠 + 双向 `includes`；INPUT/TEXTAREA/SELECT 豁免 | `executor.ts:570-582` |
| `expect_text` 校验 | 空白折叠 + 双向 `includes` + 分词全命中 | `executor.ts:37-46` |
| HIT_TEST 文案校验 | 双向 `includes` | `executor.ts:102-109` |
| anchor 消歧 | **严格 `===`** | `executor.ts:614-622` |
| extra 提示匹配 | 按 `/[\s=]/` 切块后 `includes` | `executor.ts:630-641` |

**共性问题**：7 处各写各的字符串比较，没有共享的归一化与省略号语义。任一处对"截断串 vs 全称"处理不一致，就会出现"能定位但 `expect_text` 拒绝"或"重提取后选错兄弟"。

---

## 二、专项一：截断与全称识别

### 2.1 先把事实写清楚（避免后来人改坏）

| 场景 | `innerText` 返回 | 全称在哪儿 | 当前是否拿到 |
|---|---|---|---|
| CSS `text-overflow: ellipsis` + `overflow:hidden` | **完整文本**（ellipsis 是渲染层效果，不改 DOM） | 已在 `innerText` | ✅ 已拿到 |
| `title` 属性做 tooltip，`innerText` 被 CSS 截断 | 完整文本 | 已在 `innerText` | ✅ 已拿到 |
| **JS 截断**：`s.slice(0,10)+'…'` 或 `text-overflow` 由脚本模拟 | 只有截断串 | `title` / `data-*` / 内层 `<span title>` | ❌ **丢弃**（`extractor.ts:146` 只有 text 为空才读 title） |
| SVG `<text>` 内渲染 | `innerText` 在部分浏览器为 undefined | `textContent` | ❌ **丢失**（`extractor.ts:144` 只用 innerText） |
| `::before{content:"…"}` 伪元素 | 不在 DOM | 计算样式 `content` | ❌ 不可得 |
| canvas 渲染文案 | 不在 DOM | 不可得 | ❌ 已有 `canvasEditor` 分支告知模型 |

结论：**"CSS 省略号"这一最常见场景其实已经安全**（`innerText` 给全量）。真正的漏洞是 **JS 截断 + SVG + title 未被利用**。这一条要写进代码注释，防止有人"优化"成 `textContent.slice()` 时把已修好的地方改坏。

### 2.2 方案：文本多源采集（`textOf` 升级）

把 `Candidate` 的单 `text` 拆成三个字段：

```ts
export interface Candidate {
  /** 主文案（模型看到并引用的短文案）：优先级 title > aria-label > innerText > textContent */
  text: string
  /** 全称：与 text 不同且更长时才有值（JS 截断场景=title；SVG=textContent） */
  fullText?: string
  /** 截断来源：css(js 模拟) | js | svg | none */
  truncatedBy?: 'css' | 'js' | 'svg'
  /** 其余字段不变 */
}
```

采集优先级（在 `textOf` 内实现，`extractor.ts:110-164`）：

```
1. innerText（CSS 省略号场景已是全量）        → text
2. 若 scrollWidth > clientWidth + 2 且 innerText 已含 '…' 或 CSS text-overflow != visible
   → 尝试 title / data-original / data-full / 内层 title 属性
     命中且长度 > text 长度 → fullText = 命中值, truncatedBy = 'css'
3. textContent 兜底（SVG <text>、innerText undefined）→ text
4. 若 text 自身含 '…'/'...' 且 title 比它长 → fullText = title, truncatedBy = 'js'
5. aria-label / title 仍为空才走原兜底
```

### 2.3 统一截断长度（消除 80 vs 40 不对称）

`extractor.ts:144` 截 80、`extractor.ts:782` 截 40 —— 同一元素在两条链路上长度不同，`executor.ts:570-582` 的身份校验靠双向 `includes` 侥幸通过，但一旦来源不同（快照读 aria-label、实时读 innerText）就会误判失败并触发全页重提取。

改法：新增 `src/main/textmatch.ts`，导出：

```ts
export const TEXT_CAP = 80          // 单一真源，extractor 与 RESOLVE_FN 共用
export function normalizeText(s: string): string   // 全角→半角 / 折叠空白 / 去零宽字符
export function stripEllipsis(s: string): string   // 去尾部 … ... 【更多】 查看更多 >
export function textMatch(a: string, b: string): { ok: boolean; score: number; via: string }
```

`RESOLVE_FN`（`extractor.ts:645`）与 `EXTRACT_FN` 的 `textOf` 都引用同一个 `TEXT_CAP` 常量（作为注入函数的自包含参数传入）。

### 2.4 `textMatch` 匹配器（替换 7 处各写各的 includes）

```ts
export function textMatch(want: string, got: string) {
  // 1. 双向子串（归一化后）
  // 2. 省略号前缀匹配：stripEllipsis(want) 是 got 的前缀（≥2 字）→ 命中，via='ellipsis'
  //    这条直接解决「模型从截图抄了"收货人姓名…"，DOM 里是"收货人姓名（必填）"」
  // 3. 分词全命中：按 /[\s,，、;；]+/ 切 want，≥2 字的 token 全部出现在 got
  // 4. Dice ≥0.72 兜底（复用 semantic.ts:69 的 dice）
  // 5. 全部失败 → { ok:false, score, via } —— 返回结构而非 bool，自愈链需要"为什么不像"
}
```

返回结构化 `via` 的价值：`executor.ts:903-905` 的拒绝文案可以变成"预期「收货人姓名…」与实际「收货人（必填）」不匹配（省略号前缀不吻合）"，模型下一步就知道该改文案而不是换元素。

### 2.5 提示词呈现（让模型两种说法都能引用）

`formatCandidates`（`extractor.ts:525`）中，全称与短文案不同时追加后缀：

```
[7] <input文本> "收货人姓名…" (全称:收货人姓名（必填）)(~截断) (adj=基本信息) @520,410
```

模型既可以引用截图里看到的"收货人姓名"，也可以引用全称，系统两边都能匹配上。

### 2.6 测试

新增 `resources/fixtures/truncated-labels.html`，覆盖：CSS ellipsis + title、JS slice 截断 + title、SVG `<text>`、超长 label（>80 字）、同名截断元素。`selftest.ts` 增加断言：

1. `fullText` 在 JS 截断场景被正确填充
2. `truncatedBy` 标记正确
3. `textMatch('收货人姓名…', '收货人姓名（必填）').ok === true`
4. `executor` 用截断串做 `expect_text` 点击**不**被拒
5. 快照 text 与 RESOLVE 回读 text 长度上限一致（回归护栏，防 80/40 不对称复现）

---

## 三、专项二：节点规划的可靠性

### 三层结构：**接地 → 复核 → 自愈**。当前只有"复核"和"自愈"两层是实的，"接地"这层缺失。

### 3.1 【A】接地规划（Ground-then-Plan）

**现状**：`runner.ts:1758-1762` 在首次提取前调用 `buildPlan`，`buildPlan`（`runner.ts:1322-1327`）只把 `task.slice(0,2000)` 喂给模型。

**改法**：

1. 循环顺序调整：首次迭代**先 extract + 首屏截图**，把「页面签名摘要」喂给规划器，再进入常规步循环。
   - 页面签名摘要复用 `snapshotSummary()`（`runner.ts:1618` 已有：title/URL/前 12 候选），并补上：表单字段清单（role=input 的 `text + placeholder + label`）、按钮清单、同名歧义警示。
   - 成本：零额外 CDP 往返（复用同一次 extract）。

2. `PLAN_SYSTEM_PROMPT`（`agent/plan.ts:17`）升级，节点 schema 扩展：

```json
{"nodes":[{
  "intent":"填写收货信息",
  "expected":"收货人/电话/地址三个字段均已填入任务记忆中的值",
  "target":{"kind":"field","label":"收货人姓名","near":"地址"},
  "check":{"kind":"selector_text","selector":"...","value":"张三"},
  "risk":"write",
  "precheck":{"kind":"text_visible","value":"收货信息"}
}]}
```

   - `target` 是**接地锚**：描述要作用的对象（不是 index——编号每步会变，见 4.2）。`kind ∈ {field, button, link, text, row_action}`。
   - `risk: 'write'` 标记提交/保存/删除/支付/修改类节点 → 触发 3.2 的强制 L2。
   - `precheck` 是**进入节点前的门**：不满足就不该进这个节点（典型：没登录就不该进"填写收货信息"）。

3. **`PlanValidator`（新增，`agent/plan.ts` 内，纯函数 0 token）**——规划后立刻确定性校验，不合格让模型补一次：

```ts
export function validatePlan(nodes: PlanNode[], snap: PlanSnapshot, task: string):
  { ok: boolean; issues: PlanIssue[] }
```

   校验项：
   - **C1 每个节点必须有 `check`**（可确定性校验）—— 现在 `plan.ts:66` 是"能给出才给"，改成硬要求。给不出 check 的节点标记 `weak`，其复核只能走 L2 且 `uncertain` 不放行。
   - **C2 `check.value` 幻觉检测**：`check.value` 在当前页面文本 + 任务文本中出现率 <60% → 判定为模型臆造，触发一次重规划。这条直接消灭"expected 用了页面上根本没有的词"。
   - **C3 任务实体覆盖**：把任务里的数据值（单号/商品名/数量/金额）抽出来，检查是否有节点的 `expected` 或 `check.value` 覆盖到。漏掉 = 漏步骤。
   - **C4 `target` 可达性**：`target.label` 在当前候选池里语义得分 ≥0.4（复用 `semantic.ts:232` 的 `scoreCandidate`）。得分为 0 的 target 说明规划器在想象不存在的字段 → 要求改写或标 `deferred`（延后节点，等页面变化后再做）。
   - 校验失败 → 把 `issues` 作为 user 消息回灌规划器，最多修复 1 次；仍失败则**降级为无节点链执行并 toast 告知**（保持现有"不阻塞任务"的兜底）。

**收益**：节点从"先验工作流"变成"针对当前页面的可执行计划"。C2 是当前最大的幻觉来源，一次校验抵得上十几步试错。

### 3.2 【B】复核层加固

#### B1. 复核证据包（修 `verify.ts:88-90` 的取样位置问题）

现状 `PAGE_TEXT_FN` 返回 `document.body.innerText`，上层 `.slice(0,1200)`。ERP 长页面目标区域常在 5000 字开外，L1/L2 拿到的证据里根本没有目标区域。

改为**定向证据包**，由主进程组装（不再靠页内全文）：

```
# 本步变更（执行前 → 执行后）
URL: … → …
标题: … → …
候选元素文本差异: 新增 [...]; 消失 [...]
DOM 变更数: 37（新增12 / 移除3 / 文本22）

# 目标区域切片（按节点 target 定位，不是从头截）
收货信息表单区: "收货人姓名 [____] 电话 [____] 地址 [____]"

# 关键状态
焦点元素: input#receiver（value="张三"）
新增对话框: 「确认提交订单？」[取消][提交]
```

- 目标区域切片来源：`target.label` 语义命中的候选的 `anchor` / 相邻行文本（复用 `extractor.ts:183-206` 的 `adjacentOf` 逻辑，通过 CDP 定点读取），而非 `body.innerText.slice`。
- 变更摘要：复用 `deltaVerify`（`runner.ts:1568-1615`）已有的前后快照 diff，零额外 CDP。
- token 反而更少（定向切片 300 字 vs 全文 1200 字），准确率显著更高。

#### B2. 动作级证据（补最大的缺口：点击是否生效）

现状：非提交类点击执行后**没有任何确认**（`executor.ts:985-1034` 只有 toggle 态变化、新窗口、软断言三种软失败处理）。点了没反应，模型只能靠"页面看起来没变"猜。

新增 `ActionEvidence`：

```ts
interface ActionEvidence {
  action: string
  urlDelta: boolean; titleDelta: boolean
  domMutations: number            // domstable.ts 已有统计
  newCandidates: string[]         // 新出现的候选文本（弹窗/新页面/新行）
  goneCandidates: string[]
  focusText?: string              // 点击后获得焦点的元素及其文本
  valueReadback?: string          // type 已有（executor.ts:1201-1205）
  ariaStateChanged?: boolean      // 展开/选中/禁用态变化
  networkHits: number             // CDP Network 已有（waitNetworkQuiet 用同一套）
}
```

`no_effect` 判定：`click` 后 `urlDelta=false && titleDelta=false && domMutations<3 && newCandidates.length===0 && !ariaStateChanged` → 动作标记 `noEffect`，**不计入成功**，触发自愈（见 3.3 第 4 条）。

这直接解决"点了没反应 → 模型换个编号再点 → 换个编号再点 → 耗尽步数"的空转模式。

#### B3. `node_done` 必须附证据

现状：模型输出 `node_done:true` 就走 `verifyNode`（`runner.ts:2671-2701`）。

改：`node_done` 需附 `node_evidence`（引用本步动作的 index 或自然语言片段）。无证据的 `node_done` 直接按 `uncertain` 处理，不进入 L0 短路。这让"模型自己觉得做完了"不能白嫖通过。

#### B4. `forceL2` 扩面

现状 `forceL2` 只在 `replanCount > 0` 的 done 门禁生效（`runner.ts:2727-2765`）。

扩到：**所有 `risk:'write'` 的节点 + 最后一个节点**，`uncertain` 一律不放行（`verify.ts:132` 已有该逻辑，扩触发面即可）。只读节点保留 L1 快速放行，避免 token 爆炸。

### 3.3 【C】自愈梯升级

现有自愈已经很完整（定位链 4 级 + `diagnose` 6 类 + `triedList` 反思 + 重规划 2 次）。**不需要重写，需要的是"预算分级"和"策略升级而非参数重试"**。

#### 1) 元素指纹（fingerprint）替代易变编号

```ts
// extractor 内计算，跨步骤稳定（DOM 结构不变即不变）
fp = hash(role | tag | normalize(fullText || text) | anchor | structuralPath)
```

- 快照里同时给 `index`（易变，快）和 `fp`（稳定）。
- 模型可以输出 `{"name":"click","fp":"a3f2","expect_text":"删除"}` —— 跨步骤指向同一个元素，不受每步重排影响。
- 这同时修了 4.2 的编号漂移问题和"密集页同名按钮"的消歧问题：同名元素的 `fp` 因 `anchor` 不同而不同。
- `parseModelJson`（`runner.ts:147-200`）的白名单加 `fp`；`resolveIndex` 增加"fp 优先"入口（**最便宜的一跳**）。

#### 2) 歧义显式化与硬门禁

同名候选 ≥2 时，`formatCandidates` 已经输出警示（`extractor.ts:566-575`）。补一条**执行侧硬门禁**：同名候选且模型**既没带 `expect_text` 又没带 `anchor`/`fp`** → 直接拒绝并回传"该文案有 N 处，必须带行标识"，不给模型"猜一个"的余地。现在是提示，靠模型自觉。

#### 3) 分级预算：按「方式指纹」而非次数

现状：`runner.ts:2430-2446` 按 `name|text|anchor` 签名，同签名失败 2 次就拦。问题是模型的"换一种方式"常常只是换个 index/换个措辞，本质是同一种方式。

改：签名改为 `target_fp + locatorStrategy`，`locatorStrategy ∈ {index_path, fp, anchor, text, coord, vision}`。同一个 `target_fp` 上每种策略**各给 1 次**预算；耗尽 → 判定该目标在当前页面不可达 → 进入 4) 状态复位或升级人工。避免"同一种失败换 3 种皮"。

#### 4) 状态复位探针（Rehearsal）—— 新增

现在所有重试都在**当前状态**上叠加。表单填了一半、弹窗挡着、页面滚到一半 —— 在坏状态上重试只会更糟。

新增 `recoverPage()`，在同目标连续失败 ≥1 次时先跑：

1. 关闭所有 `.ant-modal-mask` / `.el-dialog__wrapper` / `[role=dialog]` 遮罩（可见且可关的）
2. `window.scrollTo(0,0)`（清除滚动导致的"元素在视口外"）
3. 清掉 `input[type=file]` 的残留值、撤销未提交的 URL hash 跳转
4. 重新 extract 一次（刷新快照）
5. 若有 `new_tab` 未关闭的，关闭并切回原页签

成本 ~200ms（单次 CDP evaluate），收益是让重试在干净状态下开始。**这是自愈里性价比最高的一条**。

#### 5) `no_effect` 的专门路径

`noEffect` 不进 `triedList`（它不是"方式失败"，是"目标不对"）。路径：

```
noEffect → wait_for(0.8s) → 重读证据
        → 仍无变化 → fp 链找同区域其他候选（anchor 相同、role 相近）→ 列出 Top3 候选回传模型
        → 模型仍点错 → 同 target_fp 预算耗尽 → 人工介入
```

回传 Top3 候选比回传"点击未生效"有用得多——模型缺的正是"我点的到底是什么"。

#### 6) 重规划的 `check` 继承

现在 `doReplan`（`runner.ts:1632-1723`）让模型输出全新节点，新节点大概率又不给 `check`。改为：重规划时把原节点的 `target` / `check` / `precheck` 作为"已知有效的锚"传给规划器（`buildReplanPrompt`，`agent/plan.ts:119`），并在 `PlanValidator` 里对**新计划的每个节点**同样执行 C1–C4。重规划的质量不能低于首规划。

### 3.4 可靠性总览（改后）

```
接地（首步 + 每次重规划）
  └─ extract → 页面签名摘要 → PLAN_SYSTEM_PROMPT(带 target/check/risk/precheck)
       └─ PlanValidator（C1 check必填 / C2 幻觉值 / C3 实体覆盖 / C4 target可达）
            └─ 合格才进循环；不合格修复 1 次；仍不合格 → 降级无节点链 + toast

执行前
  └─ fp 优先定位 → path+tag → 实时身份 → [局部复查，非全页重提取]
       └─ 同名歧义硬门禁（无 expect_text/anchor/fp → 拒绝）

执行中
  └─ waitSettle（已有）→ ActionEvidence 采集
       └─ noEffect 判定

节点门
  └─ precheck（进节点前）→ 执行 → postcheck/verifyNode
       └─ 证据包（变更摘要 + 目标区域切片，非全文前1200字）
            └─ L0 check → L1 本地 → L2 云端；write 节点与末节点强制 L2，uncertain 不放行

自愈
  └─ recoverPage() 状态复位 → noEffect 专门路径 → diagnose 分类
       └─ target_fp × locatorStrategy 分级预算
            └─ 耗尽 → nodeFails≥3 / 重规划(继承 target/check) → 人工介入
```

---

## 四、速度（"快速"的另一半）

精准度和速度不冲突——**把"错了重试"换成"一次对"就是最快**。以下按性价比排序。

### 4.1 定位失败不再全页重提取（最大单点）

`executor.ts:585` 的 `await this.extract(t)` 在任何 path/tag/text 失败时触发，代价是整棵 DOM 遍历 + 跨域 frame 补采。

改法：
1. **先试局部复查**：只在当前快照的候选池里按 `fp` / `anchor` / `text` 重匹配（内存操作，0 CDP）。命中即返回。
2. **局部未命中再降级**到全页重提取，且**带上 task**（当前 `executor.ts:585` 的重提取不带 task，不做语义重排，候选质量低于正常步骤）。
3. 加 `this.extract` 结果的**短 TTL 缓存（800ms）**：同一秒内的多次定位失败复用同一次提取结果。

预期：密集页/虚拟列表场景的定位失败路径省 0.3～1.5s/次。

### 4.2 元素编号跨步稳定化

每步重排（`extractor.ts:611` `rerankByTask`）+ 重新提取 → 编号全变。模型无法建立跨步的元素记忆，只能每步重新认路，token 和误操作双涨。

改法：`fp`（3.3-1）落地后，提示词里**编号旁并列稳定指纹**（`[7]#a3f2`），并支持模型用 `fp` 引用。渲染时若某 `fp` 在上一步出现过，追加 `(上一步:[7])` —— 这是纯本地计算，零额外成本。

### 4.3 OCR 与 prescreen 的触发收紧

- `ocr` 增强（`runner.ts:1849-1862`）目前命中"无文本小图/role=image 候选"就跑全页 PNG + ONNX（1～6s）。改为：候选里**确实存在视觉上无法从 DOM 推断的图标按钮**（父容器是 toolbar 且候选无 text/extra）才跑；普通 `<img>` 装饰图不触发。
- prescreen（`runner.ts:2106-2152`）已有 1200ms soft budget + 2 次超时熔断，保留；再加一条：候选数 ≤8 时直接跳过 prescreen（没什么可筛的）。

### 4.4 按任务性质选择动作延迟档

`executor.ts:530-534` 的 `humanDelay`（fast 0～40 / normal 280～650 / slow 800～1600ms）是反检测成本。策略：任务全程为**只读**（无 `risk:'write'` 节点、`save`/`click` 目标均为查询/展开）→ 自动用 fast 档；任务含写操作 → normal 档。这不是新功能，是把已有档位接进节点元数据。

### 4.5 增量提取（中期）

`domstable.ts` 已有 MutationObserver 统计。可扩展为**驱动重提取**：DOM 变更数 < 阈值且无 URL 变化时，只重扫变更子树而非全页。对表单页（局部输入触发大量无关动画 class）收益显著。列为 P2。

---

## 五、对标分析

> **核实说明**：本环境无实时联网检索（与 `docs/OPTIMIZATION-PROPOSALS.md` 同况）。下表基于各产品**公开可观察的产品行为**与**公开技术描述**整理。标注 ⚠ 的是需要二次核实的推断项，落地前建议复核。产品迭代很快，对标结论取其**设计思路**而非具体参数。

### 5.1 能力矩阵

| 维度 | Codex / OpenAI Operator 系 | 豆包浏览器自动化 | Stagehand | browser-use | **EasyBow 现状** |
|---|---|---|---|---|---|
| 观察表示 | 可访问性树 + **Set-of-Marks**（截图上叠编号框）⚠ | 截图为主 ⚠ | DOM 抽取为结构化 `observe()` 元素列表 | DOM 序列化 + 候选打分 | 文本编号列表 + 视觉模式 @x,y 坐标（SoM 角标已有，`runner.ts:2153-2180`） |
| 元素身份 | 稳定 ID + 空间坐标 | ⚠ 坐标/描述 | selector + 文本 + 位置三元组 | index + 打分 | **index（每步漂移）+ anchor** |
| 接地方式 | **每轮决策基于当轮实时观测** ⚠ | ⚠ | `infer()` 在 `observe()` 结果上规划 | 每步 observe→act | ❌ **首步规划盲飞** |
| 规划 | 显式计划 + 可复核步骤 | ⚠ | `infer()` 返回动作序列 | Agent 自决策 | 有节点链但 `check` 常缺 |
| 执行前确认 | 破坏性动作需人工确认 ⚠ | ⚠ | 可配 `beforeEach` | 可配 | 提交类有 `protectedSubmit` 弹窗 + 放大复核 ✅ |
| 点击后验证 | 结果模型自查 | ⚠ | `extract()` 复核 | Agent 自查 | ⚑ 部分（toggle/新窗/软断言），**普通点击无确认** |
| 失败自愈 | 重试 + 重新观察 | ⚠ | 选择器缓存 + 失败回退 | 候选重打分 | ✅ 四级定位链 + diagnose + 重规划 |
| 截断文本处理 | AX 树不受 CSS 截断影响 ⚠ | ⚠ | 读 DOM text | 读 DOM text | ⚠ **单源，JS 截断丢全称** |

### 5.2 三条可直接借鉴的设计

1. **Set-of-Marks 的核心不是画框，是"稳定编号"**。
   Operator 系把编号直接烧进截图，模型看到的和操作的是同一个编号；EasyBow 的编号在文本列表里、截图上没有强对应（视觉模式虽有角标，但 `runner.ts:2153-2180` 只对部分元素画）。**建议**：视觉模式下对**所有视口内候选**画编号角标 + 按 `fp` 着色（同一 `fp` 全程同色，模型跨步能记住）。

2. **接地规划（observe → plan，而非 plan → observe）**。
   这是 EasyBow 与主流产品最大的结构性差距，也是第三节 A 的全部内容。一次 extract 的复用就能拿到页面签名摘要，成本几乎为零，收益是节点从"想象"变成"针对当前页面"。

3. **"点击后验证"是一等公民，不是异常分支**。
   Operator 系把结果验证作为独立环节，EasyBow 目前只有 `submitish` 和单动作 zero-delta 两条窄路径。把 `ActionEvidence` 做成**每个动作的标配产物**（B2），比继续加 `if` 分支更有价值——它同时是 `noEffect` 判定、复核证据包、`diagnose` 分类的统一数据源。

---

## 六、实施路线

每批独立可验收、独立可回滚（都有 feature flag，`settings.ts` 已有同类开关模式）。

### P0 — 确定性护栏（约 3～4 天）

| 项 | 文件 | 验收标准 |
|---|---|---|
| P0-1 文本多源采集 + `fullText`/`truncatedBy` | `extractor.ts` | `truncated-labels.html` fixture 全通过 |
| P0-2 `textmatch.ts` + 统一 `TEXT_CAP` | 新增 + `extractor.ts` / `executor.ts` | 7 处比较点全部改用 `textMatch`；快照与回读长度上限一致 |
| P0-3 复核证据包（变更摘要 + 目标区域切片） | `verify.ts` | 长页面 fixture 上 L2 不再因"看不到证据"判 uncertain |
| P0-4 定位失败改局部复查 + 800ms 提取缓存 | `executor.ts` | 定位失败路径 CDP 往返数下降（trace 可验） |

### P1 — 规划可靠性（约 5～6 天）

| 项 | 文件 | 验收标准 |
|---|---|---|
| P1-1 首步先提取再规划 + 页面签名摘要入 prompt | `runner.ts` / `agent/plan.ts` | 规划首步消耗 0 额外 CDP 往返 |
| P1-2 节点 schema 扩展（`target`/`risk`/`precheck`） | `shared/types.ts` / `plan.ts` | 类型贯通，`parsePlan` 兼容旧格式 |
| P1-3 `PlanValidator`（C1–C4）+ 修复回路 | `agent/plan.ts` / `runner.ts` | 幻觉 `check.value` 在规划阶段被拦截（新增 selftest 用例） |
| P1-4 `ActionEvidence` + `noEffect` 判定 | `executor.ts` / `domstable.ts` | 点错元素能在 1 步内被发现，不空转 |
| P1-5 复核层加固（证据强制、write 节点强制 L2） | `verify.ts` / `runner.ts` | 无证据 `node_done` 不放行 |

### P2 — 自愈与性能（约 4～5 天）

| 项 | 文件 | 验收标准 |
|---|---|---|
| P2-1 元素指纹 `fp` + 提示词并列 + `resolveIndex` 优先入口 | `extractor.ts` / `executor.ts` / `prompts.ts` | 跨步 `fp` 稳定率 ≥99%（虚拟列表 fixture） |
| P2-2 同名歧义执行侧硬门禁 | `executor.ts` | 无 `expect_text`/`anchor`/`fp` 的同名点击被拒 |
| P2-3 `recoverPage()` 状态复位探针 | 新增 | 弹窗/滚动残留场景重试成功率提升 |
| P2-4 `target_fp × locatorStrategy` 分级预算 | `runner.ts` | 同方式换皮重试被拦截 |
| P2-5 `no_effect` 专门路径（回传 Top3 候选） | `runner.ts` / `executor.ts` | 回传内容含候选列表而非仅错误文案 |
| P2-6 重规划继承 `target`/`check` + 新计划同样过 Validator | `agent/plan.ts` | 重规划后的节点 `check` 覆盖率不下降 |
| P2-7 视觉模式全量 SoM + `fp` 着色 | `runner.ts` / `overlay.ts` | 视觉模式定位错误率下降（regression 基准） |
| P2-8 增量提取 | `extractor.ts` / `domstable.ts` | 表单页单步 `extractMs` 下降 |

### 度量先行（P0 第 0 天就要做）

上线前先把这几个指标接进 `telemetry.ts`（已有 `step_timing` / `failure` 埋点），否则改完无法证明：

| 指标 | 埋点位置 | 目标 |
|---|---|---|
| 首步一次成功率 | `runner.ts` 首个动作无重试的比例 | 基线 → +20% |
| 定位失败次数/任务 | `executor.ts:875-903` 各 throw 点 | −40% |
| 定位失败平均 CDP 往返 | trace | −50% |
| `noEffect` 检出数/任务 | P1-4 | 从 0 → 可观测（先建基线） |
| 复核 uncertain 率（分 L0/L1/L2） | `verify.ts` 各 return 点 | −30% |
| 节点计划 `check` 覆盖率 | P1-2 | ≥90%（现≈0） |
| 单步 P50/P95 耗时 | 已有 `StepTimings` | 持平或下降 |
| 任务总 token | `state.usage` | 持平或下降 |

---

## 七、测试与验收

### 7.1 新增 fixture（`resources/fixtures/`）

| 文件 | 覆盖 | 对应项 |
|---|---|---|
| `truncated-labels.html` | CSS ellipsis + title、JS slice 截断、SVG text、>80 字长 label、同名截断元素 | P0-1/P0-2 |
| `long-page-target.html` | 正文 5000+ 字，目标区域在末尾（复核取样位置问题） | P0-3 |
| `stale-path.html` | 触发 SPA 重渲染使 `path` 失效但元素仍在（局部复查验证） | P0-4 |
| `fp-stability.html` | 虚拟列表 + 分页，验证 `fp` 跨步稳定 | P2-1 |
| `stuck-state.html` | 残留弹窗 + 滚动偏移，验证 `recoverPage` | P2-3 |

### 7.2 回归与基准

- `npm run regression`（已有）纳入新 fixture
- `npm run benchmark`（已有）跑 P0/P2 前后对比
- `npm run selftest` 新增断言：P0-1~P0-4 各 3～5 条、P1-3 Validator 四条校验各 1 条

### 7.3 验收原则

1. **每条改动都有确定性断言**，不靠"跑几个真实任务感觉好点了"。
2. **提示词字节级回归**：`prompts.ts` 现有大量"缺省时逐字节不变"的契约（`prompts.ts:252,299,328`），任何提示词改动必须保持 feature flag 关闭时逐字节一致，且 selftest 已有对应断言——不要破坏这个约定。
3. **计划阶段不能变慢超过 200ms**：接地规划复用同一次 extract，超出即说明实现有问题。

---

## 八、风险与已知代价

| 风险 | 说明 | 缓解 |
|---|---|---|
| 提示词变长 | `fullText` 后缀 + `fp` 并列会增加每步 token | 后缀仅在 `fullText !== text` 时出现；`fp` 只用 4 位；P0 度量盯着 token |
| `fp` 稳定性 | 虚拟列表滚动 / 表格重排会让结构路径变化 | `fp` 只用 `role+tag+text+anchor`，**不含** children 索引路径；`structuralPath` 用 tag 序列而非 index |
| 强制 L2 扩面 → token 上升 | write 节点全部走云端复核 | 只在节点退出时触发一次，不是每步；只读节点仍走 L1 |
| PlanValidator 误杀 | C2 幻觉检测可能误判合法 `check.value` | 阈值 60% 且只触发一次修复；仍不合格是**降级**不是中止 |
| `recoverPage` 误关弹窗 | 某些弹窗是任务需要的中间态 | 只关 `role=dialog` 且**不含任务关键词文本**的遮罩；关不掉就跳过不报错 |
| 回填 `fullText` 后的匹配放宽 | `textMatch` 引入 Dice 0.72 兜底，可能放过相似但不同的元素 | 兜底只在 `expect_text` 场景开启，定位链的精确匹配保持严格 |

---

## 九、一句话总结

**当前 EasyBow 的执行层（定位链 + 自愈 + 反检测）已经是同类产品里相当扎实的水平；短板集中在"决策前的接地"和"证据的取样"。**

三个 P0 改动——**文本多源采集**（拿全称）、**接地规划**（先看页面再规划）、**定向复核证据**（看变化而非全文）——都是零模型成本或极低成本的确定性改动，合计 3～4 天，能同时解决"字段名被截断导致选错"和"节点计划不可靠"两个用户可感知的问题。P1/P2 再补上动作级证据与元素指纹，解决"点了没反应一路空转"和"编号跨步漂移"。

建议按 P0 → P1 → P2 顺序推进，每批独立发布并用第六节的指标验证。
