# EasyBow v4.6 完整升级实施方案：Token 成本 × 操作决策提速

* **日期**：2026-10-15
* **基线版本**：v4.5.0（当前工作区）
* **文档定位**：本文是**实施级**方案——每项改动落到 `文件:行`、代码草图、兼容性约束、验收标准、回滚开关。策略论证与外部研究见姊妹篇《[EasyBow-v4.6-Token成本与决策提速升级方案](./EasyBow-v4.6-Token成本与决策提速升级方案.md)》（下称「策略篇」），本文不重复论证。
* **行号基准**：本文所有行号以 2026-10-15 工作区为准（含未提交的 v4.5 改动）。合并后若有偏移，以文中引用的代码片段为锚。

---

## 〇、目标与硬约束

### 基线（真实 trace 实测，2026-10-09~11，15 任务 / 448 次云端调用）

| 指标 | 基线 | 目标 | 硬约束 |
|---|---|---|---|
| 单任务 token | 162,735 | ≤ 65,000 | — |
| 云端调用次数/任务 | 29.9 | ≤ 20 | — |
| 单步 P50 耗时 | 4,776ms | ≤ 3,200ms | — |
| 缓存命中率 | **未知（未埋点）** | ≥ 80%（可缓存端点） | — |
| 成功率 | 13.3% | — | **不得下降** |
| 解析失败步占比 | 0.2% | — | **不得升过 0.5%** |
| 强制 L2 跳过率 | 恒 0（T9 验收） | 恒 0 | **不得破坏** |

**三条红线**（任何一条被触碰即回滚对应开关）：
1. 回归用例（`src/main/regression/cases.json`）中 agent 类任务成功率不得下降；
2. `parse_fail` 占比不得上升（输出预算收紧的最大风险）；
3. 密集页（同名候选 ≥2）的点错防护不得削弱（`expect_text` 核验、放大复核、行标识体系全部保留）。

### 编号约定

沿用策略篇的编号：**A**=计量，**C**=单次调用瘦身，**B**=减步数，**D**=判断准确性，**M**=评测。每项给出：现状 → 改法（代码草图）→ 兼容性 → 验收 → 工时。

---

## 一、改动总表

| 编号 | 改动 | 主改文件 | 里程碑 | 工时 | 风险 | 回滚开关（settings） |
|---|---|---|---|---|---|---|
| A1 | 补缓存计量（cachedInputTokens） | `llm.ts` `types.ts` `runner.ts` `telemetry.ts` `analyze-traces.mjs` | P0 | 0.5d | 无（纯计量） | `cacheAccounting` |
| A2 | 调用点分账（site 标签 + verify/clickVerify 补埋点） | `runner.ts` `verify.ts` `executor.ts` `index.ts` | P0 | 0.5d | 无（纯计量） | `cacheAccounting` |
| A3 | pageHash 页面指纹埋点 | `runner.ts` | P0 | 0.25d | 无 | — |
| C1 | 修复 system 缓存断点（附加段迁出 system） | `prompts.ts` `runner.ts` | P0 | 0.5d | 低 | `stableSystemPrompt` |
| C6 | 输出预算分档收紧 | `llm.ts` `runner.ts` `verify.ts` `index.ts` | P0 | 0.5d | 中 | `outputBudget` |
| C4 | 文本模式网格坐标改「首尾保留」 | `extractor.ts` | P0 | 0.25d | 低 | `textGridCoords` |
| C2a | 历史折叠（超长任务） | `prompts.ts` | P1 | 0.5d | 低 | `historyFold` |
| C2b | 多轮消息复用（架构级，选做） | `runner.ts` `llm.ts` | P5 | 3~4d | 高 | `multiTurn` |
| C5 | read_content / extract_images 分片取回 | `executor.ts` `shared/types.ts` | P1 | 1d | 低 | `pagedRead` |
| C3 | 元素列表分级（summary/full） | `extractor.ts` `executor.ts` `runner.ts` | P1 | 1.5d | 中 | `obsDetail` |
| B1 | 打转检测提前 + 失败签名触发 | `runner.ts` | P2 | 1d | 中 | `replanTune` |
| D1 | clickVerifier 分档跳过 | `executor.ts` `index.ts` | P2 | 1d | 中 | `clickVerifyTune` |
| B2 | 本地决策层扩权（错误重试直出） | `runner.ts` `prompts.ts` | P3 | 1d | 中 | `localRetry` |
| B3 | 页面指纹去重（免观测降级） | `runner.ts` | P3 | 1d | 中 | `pageHashSkip` |
| B5 | repeat 自动提示（0 提示词改动） | `runner.ts` | P3 | 0.5d | 低 | `repeatNudge` |
| M1 | MFS 最小失败元素集评测 | `resources/fixtures/` `selftest.ts` | P4 | 1.5d | 无 | — |
| M2 | benchmark 基线存档与对比脚本 | `scripts/` `regression/` | P4 | 0.5d | 无 | — |
| D2 | 本地 grounding 模型评估（选做） | 新模块 | P5 | 3~5d | 高 | 独立模块 |
| D3 | 前后截图 diff 局部复核（选做） | `verify.ts` | P5 | 2d | 中 | `diffVerify` |

**核心路径合计：10~12.5 天**（P0 1.5d → P1 3d → P2 2d → P3 2.5d → P4 2d，部分可并行）。P5 按需。

---

## 二、P0 里程碑：计量先行 + 确定性瘦身（1.5 天）

### A1. 补缓存计量（0.5 天）

**现状**：`llm.ts` 的 `LlmResult.usage` 只有 `{ inputTokens, outputTokens }`（`llm.ts:29-33`）。OpenAI 分支只读 `res.usage?.prompt_tokens`；Anthropic 分支只读 `res.usage?.input_tokens`（`llm.ts:199` 附近）。**缓存字段被整体丢弃**——DeepSeek/OpenAI 的 `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens`、Anthropic 的 `cache_read_input_tokens` 全部没接。

**改法**：

```ts
// llm.ts
export interface LlmResult {
  text: string
  usage: {
    inputTokens: number
    outputTokens: number
    /** 命中前缀缓存的部分（OpenAI cached_tokens / Anthropic cache_read）。缺省=端点未上报 */
    cachedInputTokens?: number
    /** Anthropic 写缓存部分（按 1.25x 计价，单列不并入 cached） */
    cacheWriteInputTokens?: number
  }
  structured?: StructuredSupport
}
```

两个 provider 的 `finish` 各加一行：
- OpenAI：`cachedInputTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? res.usage?.prompt_cache_hit_tokens`
- Anthropic：`cachedInputTokens: res.usage?.cache_read_input_tokens`，`cacheWriteInputTokens: res.usage?.cache_creation_input_tokens`

**下游**：`runner.ts` 的 `this.state.usage` 增加 `cachedIn` 累计；`telemetry.ts:77-102` 的 `task_end` 增加 `tokensCached`；`llm_call` 事件增加 `cachedIn` 字段（`runner.ts:2484-2493`）。

**报表**：`scripts/analyze-traces.mjs` 第 6 节扩展两行——「缓存命中率 = ΣcachedIn / ΣinputTokens」「全价输入 = Σ(input − cached)」。

**验收**：跑一个 ≥5 步任务后，`analyze-traces` 能给出命中率数字；对不支持缓存的端点（如部分中转）字段缺省且报表显示「端点未上报」，不得显示为 0%。

### A2. 调用点分账（0.5 天）

**现状**：`llm_call` 只有 `planner` 布尔（`runner.ts:2484-2493`）；**`verify` 的 L2 调用（`verify.ts:196`）与 clickVerifier（`index.ts:326`）完全不产生 llm_call 埋点**。实测窗口里 401 次 clickVerifier 调用在 token 账上不存在。

**改法**：
1. `llm_call` 事件统一加 `site: 'step' | 'plan' | 'replan' | 'verify' | 'clickVerify' | 'enhance'`，替代/兼容 `planner` 布尔（布尔保留一个版本，报表兼容旧 trace）。
2. `verify.ts` 的 `verifyNode` 增加可选参数 `onUsage?: (u: LlmResult['usage']) => void`，L2 `chat` 返回后回调；`verify.ts` 本身保持无 telemetry 依赖（selftest 可传 undefined）。
3. clickVerifier：`index.ts:326` 的闭包内补 `telemetry.log('llm_call', stepN, { site: 'clickVerify', input, output, cachedIn })`。**同时修两个顺手 bug**：
   - 该闭包**每次调用 `createProvider(s)` 新建实例**——改为模块级缓存（同 settings 引用复用），省一次客户端构造；
   - `provider.chat(...)` 未传 `maxTokens`，吃默认 2048——答案只需 ~30 token，传 `{ plain: true, maxTokens: 256 }`（与 C6 联动）。

**验收**：实测窗口重放后，报表第 6 节出现按 site 分列的次数/input/output 表；clickVerify 的调用次数与 `action_verify` 事件数可对账。

### A3. pageHash 页面指纹埋点（0.25 天）

**改法**：`runner.ts` 在 extract 完成后（`runner.ts:2039` 的 extract 事件处）计算并记录：

```ts
/** 页面指纹：URL+标题+滚动位+候选要素的 FNV-1a，8 位 hex。确定性纯函数，selftest 可测 */
export function pageHashOf(e: { url: string; title: string; scrollY: number; scrollHeight: number; candidates: Array<{ role: string; text: string; extra?: string; state?: string }> }): string {
  let h = 0x811c9dc5
  const s = `${e.url}|${e.title}|${e.scrollY}/${e.scrollHeight}|` +
    e.candidates.map((c) => `${c.role}|${c.text}|${c.extra || ''}|${c.state || ''}`).join('\n')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
```

extract 事件加 `pageHash` 字段；runner 实例上维护 `this.prevPageHash / this.lastPageHash`（B3 依赖）。

**验收**：同页面连续两步 extract 的 pageHash 相同；点击展开弹窗后不同；selftest 加入哈希稳定性与顺序敏感性断言。

### C1. 修复 system 缓存断点（0.5 天）★性价比最高

**现状**：`runner.ts:2412-2418`：

```ts
const systemPrompt =
  (useVision ? SYSTEM_PROMPT + (visionActive ? VISION_ADDON : VISION_FALLBACK_ADDON) : SYSTEM_PROMPT) +
  (extract.canvasEditor ? CANVAS_EDITOR_ADDON : '') +
  (this.testCtx ? TEST_MODE_ADDON : '')
```

任一开关变化 → system 串变 → `llm.ts:183` 的 Anthropic `cache_control` 断点失效，且 OpenAI/DeepSeek 自动前缀缓存的公共前缀也被截断在这里。视觉兜底一触发（最多 3 步），整任务后续缓存全冷。

**关键事实（降低风险用）**：普通任务（无 vision/canvas/test）的 system 本来就只有 `SYSTEM_PROMPT`——**本改动对普通路径逐字节零变更**。只有 vision/canvas/test 步骤的提示词布局变化。

**改法**：四段附加段全部迁出 system，落到 user 消息**末尾**（动态后缀区，`# 下一步` 之前）：

```ts
// prompts.ts 新增：模式说明后缀（仅对应开关开启时非空；文本正文与现行 addon 逐字一致，仅落点变化）
export function buildModeSuffix(ctx: { vision?: 'on' | 'fallback'; canvas?: boolean; test?: boolean }): string {
  const parts: string[] = []
  if (ctx.vision === 'on') parts.push(VISION_ADDON_BODY)
  if (ctx.vision === 'fallback') parts.push(VISION_FALLBACK_ADDON_BODY)
  if (ctx.canvas) parts.push(CANVAS_EDITOR_ADDON_BODY)
  if (ctx.test) parts.push(TEST_MODE_ADDON_BODY)
  return parts.join('\n')
}

// runner.ts
const systemPrompt = SYSTEM_PROMPT // 恒定：跨任务、跨模式逐字节稳定
const userMsg = buildStepMessage(ctx) + buildModeSuffix({ vision, canvas, test })
```

落点选择的原因：
- **不能放 user 消息开头**——OpenAI 式自动前缀缓存的公共前缀是「system + 任务 + 记忆 + 经验 + 历史（追加式）」，放开头会把公共前缀截断在 system 末尾；
- **放末尾**只占用本来就每步变化的动态后缀区，公共前缀延伸到历史末尾不受影响；
- 截图块在 content parts 里位于全部文本之后（`runner.ts:2400-2411` 现状），VISION_ADDON 里「本消息附带一张截图」「截图附在本消息末尾」的表述语义不变。

**Anthropic 侧**：`llm.ts:183` 的 system 断点从此恒命中。（可选增强，P3：在 user 消息的历史区末尾加第二个 `cache_control` 断点，让历史+记忆也进缓存——Anthropic 支持 ≤4 个断点。P0 不做。）

**兼容性**：
- `selftest.ts:1356-1435` 的提示词逐字节回归：normal 路径 system 与 user 消息均逐字节不变，**基线无需更新**；新增断言——vision/canvas/test 三开关全组合下 `systemPrompt === SYSTEM_PROMPT`，且 mode 块出现在 user 消息固定区段。
- `prompts.ts` 中 `VISION_ADDON` 等导出保留（改为内部引用 body），避免外部引用断裂。

**验收**：打开视觉模式跑 5 步任务，`llm_call.cachedIn`（A1 埋点）显示第 2 步起 system 部分命中缓存；触发视觉兜底时缓存不冷。

### C6. 输出预算分档收紧（0.5 天）

**现状**：决策点 `max_tokens: 2048` 默认（`llm.ts:101`），实测平均输出仅 119 token；规划/重规划硬编码 6144（`runner.ts:1424`、`runner.ts:1834`，注释已说明是给推理模型思考留余量）；L2 复核 4096（`verify.ts:196-199`）换一个 ~15 token 的答案；clickVerifier 未传（吃 2048）。**推理模型思考计入输出预算**，一刀切收紧会截断思考 → JSON 解析失败。

**改法**：`llm.ts` 新增集中预算表：

```ts
/** 推理模型判定（思考计入输出预算，预算须放宽）。保守正则：宁可放宽不可截断 */
const REASONING_MODEL_RE = /(^|\/)(o[134](-mini|-preview)?($|-)|gpt-5|deepseek-r\d|qwq|[\w.-]*reasoner|[\w.-]*thinking)/i
export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(model)
}

export type CallSite = 'step' | 'plan' | 'replan' | 'verify' | 'clickVerify'
const BUDGET: Record<CallSite, { fast: number; reasoning: number }> = {
  step:        { fast: 768,  reasoning: 2048 }, // 现状 2048；实测均值 119
  plan:        { fast: 1536, reasoning: 6144 }, // 现状恒 6144
  replan:      { fast: 1536, reasoning: 6144 },
  verify:      { fast: 256,  reasoning: 1024 }, // 现状恒 4096
  clickVerify: { fast: 256,  reasoning: 256 }   // 现状默认 2048
}
export function outputBudget(model: string, site: CallSite): number {
  return BUDGET[site][isReasoningModel(model) ? 'reasoning' : 'fast']
}
```

调用点替换：
- `runner.ts:1424` → `maxTokens: outputBudget(model, 'plan')`；`runner.ts:1834` → `'replan'`；
- step 调用（`runner.ts:2430` 附近，现未传 opts）→ `chat(systemPrompt, messages, signal, { maxTokens: outputBudget(model, 'step') })`；
- `verify.ts:196-199` → `verifyNode` 增加 `model?: string` 参数，`maxTokens: outputBudget(model || '', 'verify')`；
- clickVerifier（`index.ts:326`）→ `{ plain: true, maxTokens: 256 }`。

**截断防护**（必须，与红线 2 联动）：`llm_call` 事件加 `truncated: usage.outputTokens >= maxTokens`。连续 2 步 `truncated && parse_fail` → 本任务自动回退 legacy 预算（2048/6144/4096）并记 telemetry `{ budgetFallback: true }`。这是运行时自愈，不依赖人工发现。

**验收**：
- selftest 断言预算表（含 `gpt-4o-mini`→fast、`o3`/`deepseek-r1`/`qwq`→reasoning 样本）；
- 回归跑完后 `parse_fail` 占比 ≤ 0.5% 且 `budgetFallback` 触发次数为 0（若触发，说明正则漏了用户的模型名——按 trace 里的 model 名补正则）。

### C4. 文本模式网格坐标改「首尾保留」（0.25 天）

**现状**：`extractor.ts:730-736`——`withCoords=false` 时每行输出 `(格x,y)`，80 行 ≈ 640 字符/步的固定开销；v4.4 加它的理由是「顶部菜单/底部下一页」类空间指代，但中间表单区的网格几乎不被引用。

**改法**：`formatCandidates(res, withCoords, keepIdx, gridMode: 'all' | 'edges' | 'off' = 'all')`——`!withCoords && gridMode==='edges'` 时，仅对**渲染序前 8 行与后 8 行**输出网格（页头导航与底部翻页保留，中间省掉）。settings 增加 `textGridCoords: 'edges' | 'all' | 'off'`，默认 `'edges'`。

**兼容性**：`selftest.ts:710-725` 的 `formatCandidates(fakeRes, true)` 用例走 `withCoords=true` 路径不受影响；新增 edges 模式断言（>16 行时中间行无 `(格`，首尾行有）。

**验收**：80 行页面单步元素块字符数下降 ≥15%；「点击底部下一页」回归用例不退化。

---

## 三、P1 里程碑：内容瘦身（3 天）

### C2a. 历史折叠（0.5 天）——附一个策略篇需要修正的结论

**先修正策略篇 C2 的一个不精确处**：历史「每步重发」在**前缀缓存命中时几乎不计费**（追加式历史恰恰是缓存最友好的形态——公共前缀每步单调增长）。所以折叠的真实收益分两种情况：
- **无缓存端点 / 缓存冷**（部分中转、本地 ollama、任务前几步）：折叠省真金白银；
- **缓存命中**：追加式更优，折叠反而把缓存命中边界从「历史末尾」拉回到「聚合行开头」。

**因此 C2a 收窄为**：仅对**超长任务**折叠（`steps > 12` 时，把第 1 ~ (N−6) 步折成 ≤2 行聚合），且可通过 `historyFold: false` 关闭。短任务（绝大多数）保持追加式不动。

**改法**（`prompts.ts:291-302`）：

```ts
export function renderHistoryLines(steps: StepRecord[]): string[] {
  const KEEP = 6
  if (steps.length <= 12) return steps.map(renderOneLine) // 现状行为
  const head = steps.slice(0, steps.length - KEEP)
  const tail = steps.slice(-KEEP)
  const errs = head.filter((s) => s.actions.some((a) => a.error)).length
  const agg = `第1~${head.length}步: ${head.length}步已完成（节点推进 ${head.filter(s => s.nodeAdvanced).length} 次${errs ? `，⚠${errs} 步有动作出错` : ''}）`
  // 用户指导行是最高优先指令，永不折叠；近期出错行保留 2 条供反思
  const keptErr = head.filter((s) => s.actions.some((a) => a.error)).slice(-2).map(renderOneLine)
  return [agg, ...head.filter(isGuidance).map(renderOneLine), ...keptErr, ...tail.map(renderOneLine)]
}
```

段落标题 `# 已执行步骤（摘要）` 不变——`selftest.ts:1426-1427` 的区段顺序断言（任务记忆 < 已执行步骤 < 页签）自动存活。

**验收**：30 步任务第 30 步的历史区从 ~1,350 字符降到 ~600；`renderHistoryLines` 纯函数单测（指导行保留/错误行保留/12 步内不折叠）。

### C5. read_content / extract_images 分片取回（1 天）

**现状**：`read_content` 一次回填 ≤6,200 字符（`executor.ts:1716`，含 `READ_CONTENT_FN(6000)` + OCR 兜底 + 跨 frame 补充），注入 `lastResults` 后上限 6,500（`prompts.ts:325-331`）≈ 4,000 token。`extract_images` 同（`executor.ts:1728`，40 条 URL）。模型通常只需要其中一小段。

**改法**：
1. `AgentAction`（`shared/types.ts`）的 read_content/extract_images 增加可选 `offset?: number; limit?: number`（executor 的动作解析处放行这两个字段）。
2. executor 内新增**页文缓存**：`read_content` 首次全量读入后存 `Map<tabId, { text: string; ts: number }>`（URL 变化即失效）；后续带 `offset/limit` 的调用**直接切片缓存**，不再触发 CDP/OCR（0 延迟 0 token）。
3. **默认行为**：首次 `read_content` 只回填前 800 字符 + 自描述尾注：

```
（页面正文共 6,214 字，以上为前 800 字。需要后续内容时输出：{"name":"read_content","offset":800,"limit":2000}）
```

   说明文字**放在结果文本内**而非 SYSTEM_PROMPT——SYSTEM_PROMPT 本轮零改动，提示词逐字节回归基线不动。`save` 的「存记忆 + `{{key}}` 引用」既有模式继续可用（长正文仍可 save 后引用）。
4. `extract_images` 默认回填前 12 条 URL + 总数 + 同款 `offset` 分页。

**验收**：「读列表页 → 切页签填表」回归用例中，read_content 步的 `llm_call.input` 相比基线下降 ≥2,000 token；带 offset 的二次读取命中缓存（step_timing 中该动作 <50ms）；任务成功率不降。

### C3. 元素列表分级（1.5 天）

**现状**：每步恒定渲染全量字段（`extractor.ts:708-737`）：`[i] <role> "text" ~全称:"full" (截断标记) (行:anchor) #fp (extra) (state) (格x,y) (需滚动到)`，80 行 ≈ 2,200 token——**单次调用的最大区块**。

**改法**（两档，P3 视效果再加 minimal）：

| 档位 | 每行字段 | 触发条件（确定性，runner 判定） |
|---|---|---|
| `full`（现状） | 全字段 | `stepN <= 2`、上一步有动作错误、视觉兜底、canvas 页、密集页（重复文案组 ≥5）、`obsDetail: false` |
| `summary` | `[i] <role> "text" #fp (state) (格x,y)`——**裁掉 `~全称`、截断标记、`(行:anchor)`、`(extra)`，仅语义 Top-12 与视口内前 8 行保留 anchor+extra** | 其余情况 |

- `formatForPrompt(res, limit, withCoords, keepIdx, detail: 'summary' | 'full' = 'full')`（`executor.ts:488`）→ 透传给 `formatCandidates`；
- 裁剪规则放 `formatCandidates` 内（纯函数，selftest 直测）；
- `anchor` 与 `extra` 是密集页行定位的关键——**密集页恒走 full**（红线 3），summary 只省「非密集页」的行宽。

**兼容性**：这是本轮**唯一有意变更 normal 路径提示词内容**的项——`selftest.ts:1356` 的逐字节基线**需要刻意更新**（在 selftest 中注明「v4.6 C3：summary 档裁剪字段」），并把「full 档与 v4.5 基线逐字节一致」作为新断言保底。

**风险与缓解**：全称/extra 裁掉后，模型「从截图抄截断文案」的匹配成功率可能受影响——**语义 Top-12 行保留全称与 extra** 兜底；M1 建库后用 MFS 覆盖率回归（fixture `truncated-labels.html` 正是针对此）。

**验收**：非密集页单步元素块 token −35% 以上（推算）；`truncated-labels` fixture 的定位任务在 summary 档下不退化；密集页 fixture 走 full 档逐字节等价。

---

## 四、P2 里程碑：减步数 + 复核降本（2~3 天）

### B1. 打转检测提前 + 失败签名触发（1 天）

**现状**：`runner.ts`（T9 重规划触发块）——连续 **3** 步无节点推进才置 `replanPending`，重规划上限 **2** 次（`replanCount < 2`）。实测 13 次重规划没救回任何打转任务（6 个任务 42~66 步耗尽）。

**改法**（全部在 `replanTune: true` 时生效）：
1. `noProgressSteps >= 3` → **`>= 2`**；
2. **failSig 快速触发**：`executor.ts:944-1075` 已为失败动作生成签名（`click|<text24>|<anchor|mismatch|ambiguous|verify_fail>`），`runner.ts:2637/2672` 已用于 tried 清单。新增计数：**同一 failSig 在同一节点内第 2 次出现 → 立即 `replanPending`**（不必等 2 步无推进）；第 3 次出现 → 不再重规划，直接注入 `clarify` 建议（`{"name":"clarify","query":"…"}`，消耗既有 ≤3 次 clarify 预算）；
3. `replanCount` 上限 2 → **3**，但第 3 次重规划的 prompt 必须附上次失败后的 `deltaHint`（`buildReplanPrompt` 增加 `delta` 字段，内容取最近一次 `action_verify` 的变更摘要）；
4. replan telemetry（`runner.ts` replan 事件）加 `trigger: 'no_progress' | 'fail_sig' | 'done_held'`，验收用。

**边界**：`replanTune: false` 时全部行为与现状逐字节一致（阈值 3 / 上限 2 / 无 failSig 触发），保证可回滚。

**验收**：构造打转 fixture（按钮点击后页面无变化），触发重规划的步数从 3 降到 2；40+ 步任务占比从 6/15 下降；重规划次数/任务均值上升不超过 0.5（telemetry 对账）。

### D1. clickVerifier 分档跳过（1 天）

**现状**：`executor.ts:1056`——`submitish || dupCount >= 2` 即触发视觉裁剪复核。实测窗口 **401 次**（对比 448 次 llm_call），密集页几乎每次点击都触发；且每次调用新建 provider、吃 2048 输出预算（A2 已修）。`resolveIndex` 的 v4.2 实时文本身份校验**已经**确认了「点到的元素文案 === expect_text」，视觉复核在「文本证据已闭合」时是重复劳动。

**改法**（`clickVerifyTune: true` 时）：

```ts
// executor.ts:1056 现状
if (this.clickVerifier && cand && (submitish || this.dupCount(t, cand) >= 2)) {
// 改为（Executor.clickVerifyDecision 纯函数，selftest 真值表直测）：
const d = Executor.clickVerifyDecision({ submitish, dupCount, expectText, candText, anchor })
// submitish → run（不可逆操作，代价不对称）
// dupCount < 2 → skip('unique')（解析器实时文本身份校验已确认点到=预期）
// dupCount ≥ 2 且 expect_text 含行标识(锚) → skip('row_anchored')
// 其余（同名且无行标识）→ run('ambiguous')
```

**验收**：clickVerify 调用次数下降 ≥50%（401 → ≤200/15任务窗口）；密集页 fixture（`dense-controls.html`）的点错拦截用例**全部仍被拦截**（selftest 真值表：submitish×4 种 anchor 组合）。

---

## 五、P3 里程碑：本地扩权 + 免观测（2.5~3 天）

### B2. 本地决策层扩权（1 天）

**现状**（`runner.ts:2229-2269`）：本地 0.5B 直出门控——`!visionActive && !guidance.length && !kbTips.length && !expTips.length && stepN > 1 && cooldown===0`。**动作报错后的重试步**（纯机械：重提取 → 重新挑候选）也全走云端，而云端模型对「换个候选再点一次」给不出增量信息。

**改法**（`localRetry: true` 时）：
1. 门控追加放行：`this.lastBatchHadError && errorClass === 'locate'`（错误分类复用 `diagnose.ts` 的归类：元素找不到/文本不符/歧义 = locate；网络/验证码/风控 = 除外）；
2. 连续本地重试步 ≤2，之后强制云端（防本地死循环）；
3. `localCooldown` 10 → **5**（冷却本身是 v4 方案的安全阀，10 步过长）；
4. `LOCAL_SYSTEM_PROMPT`（`prompts.ts:134-138`）追加一行：「上一步动作失败时，从当前元素列表重新挑最匹配的编号重试；仍无把握输出空 actions」。**注意**：这改了本地提示词——本地路径无逐字节基线断言，但需在 selftest 加新断言锁定 v4.6 本地基线。

**不做**：放开 vision/人工指导/经验库步（策略篇已论证这些场景判断价值高，云端不可替代）；给 0.5B 放开 `repeat`（误触发翻页循环的代价大于收益）。

**验收**：`llm_call.local` 占比从基线提升（telemetry 对账，目标 +10% 以上）；回归用例成功率不降；本地误触发率（本地决策后动作报错的比例）不超过云端路径的 1.5 倍。

### B3. 页面指纹去重（1 天）

**现状**：每步无条件全量重发元素列表（≈2,200 token），即使页面与上一步**逐字节相同**（wait 后、动作无效果时常见——这正是打转任务的常态）。

**改法**（`pageHashSkip: true` 时，依赖 A3 的 `pageHashOf`）：

```ts
// runner.ts，formatForPrompt 之前
const pageUnchanged =
  settings.pageHashSkip !== false &&
  stepN > 2 &&
  !extract.canvasEditor &&
  !useVision &&
  this.lastPageHash === this.prevPageHash &&   // 本步与上一步页面相同
  executed.length === 0                          // 尚未执行本步动作（决策前）
  // 页签切换步天然 pageHash 变化，无需特判

const elementLines = pageUnchanged
  ? '（页面与上一步完全相同，元素列表省略。若需要换方式，可先 scroll 或换目标；需要完整列表说明理由）'
  : this.executor.formatForPrompt(extract, settings.maxElements, useVision, keepIdx, detail)
```

**注意边界**：
- 只在「决策前」判定，动作执行后的复核不受影响；
- canvas/vision 页排除（正文变化不反映在候选集里，哈希会假阴性）；
- 连续 2 次 `pageUnchanged` 后第 3 次强制回全量列表（防模型在无列表状态下反复空转）；
- telemetry：extract 事件加 `omitted: true`，统计触发率。

**验收**：打转 fixture 上省掉 ≥2 次全量列表（每次 ≈2,200 token）；正常任务触发率 <20%（不该频繁出现页面不变）；成功率不降。

### B5. repeat 自动提示（0.5 天，0 提示词改动）

**现状**：`repeat` 动作已存在（`executor.ts:1656`，一次决策执行多轮，0 LLM 调用），SYSTEM_PROMPT 也有说明（`prompts.ts:21`）——但模型几乎从不主动用。

**改法**：runner 维护 `sameShapeRun` 计数：连续 ≥3 步的动作形状相同（同名动作 + 目标文案同模式，如连续「点击[下一页]」且 pageHash 各不相同）→ 通过 `lastResults` 注入系统提示（沿用既有「系统提示:」模式，`runner.ts:2453` 同款）：

```
系统提示: 已连续 3 步执行同构动作（翻页/批量同类操作）。若页面模式稳定，可输出 {"name":"repeat","amount":N} 一次执行多轮，省去逐步决策。
```

不改 SYSTEM_PROMPT → 提示词逐字节回归零影响。

**验收**：翻页采集回归用例中出现 repeat 触发且总步数下降；非翻页任务零误触发。

---

## 六、P4 里程碑：评测闭环（2 天，建议与 P1 并行启动）

### M1. MFS 最小失败元素集评测（1.5 天）

**机制**（出处见策略篇 7.1）：给每个 fixture 标注「任务成败依赖的最小元素集合」，任何提取/压缩/预筛改动先跑 MFS 覆盖率——确定性、0 token、毫秒级，替代昂贵的端到端回归。

**改法**：
1. `resources/fixtures/*.html` 的关键元素加 `data-mfs="字段名"` 标注（现有 `dense-controls.html`、`truncated-labels.html` 先标，新增 2~3 个典型页：分页列表页、多步表单页、canvas 编辑器页）；
2. `selftest.ts` 新增用例「MFS 覆盖率」：对每个 fixture 跑真实 `EXTRACT_FN`（已有 fixture 加载机制），然后在 `{detail: 'summary' | 'full'} × {prescreen on/off} × {gridMode 三态}` 组合下断言：**每个 `data-mfs` 元素都出现在渲染行里**；
3. 该用例注册为 C3/C4/预筛改动的**强制门**：任何让 MFS 元素从提示词消失的改动 = 测试失败。

**验收**：`npm run selftest` 含 MFS 用例且全绿；故意在 summary 裁剪里去掉 anchor 后用例转红（验证用例有效性）。

### M2. benchmark 基线存档与对比（0.5 天）

1. 改动前先跑 `npm run benchmark` 存 `reports/baseline-v4.5.json`（4 配置 × 用例级 `steps/tokens/stepMs`）；
2. `scripts/analyze-traces.mjs` 增加 `--compare <baseline.json>`：输出 token/调用数/步耗时的逐项对比与回归判定（成功率下降 → 非零退出码，可接 CI）。

**验收**：`node scripts/analyze-traces.mjs --compare reports/baseline-v4.5.json` 输出对比表；人为注入一次劣化（如关闭 C1）能被对比脚本抓到。

---

## 七、P5 选做项（按 P4 数据决策）

### C2b. 多轮消息复用（3~4 天，收益最大、改动最深）

把「无状态单 user 消息」改为真实多轮对话：`[sys, u(step1上下文), a(step1输出), u(step2增量), a(step2输出), …]`——配合 C1 的缓存断点，每步输入成本趋近「新增增量」（策略篇 TurnCost：98.6% 输入可被缓存覆盖）。这是 browser-use / Claude Code 的标准形态。

**前置条件**：P0 的缓存计量跑出真实命中率；若 C1 修复后命中率已 ≥80% 且单任务 token 已进目标，**本项目可以不做**（收益/风险比不合算）。
**风险**：abort/重试路径的消息一致性、`parseModelJson` 失败后的 corrective 注入方式变化、提示词回归体系需重建。若启动，单独立项评审。

### D2. 本地 grounding 模型（3~5 天）

OmniParser V2（MIT 检测器）或 GroundingDINO 做候选框 ↔ 语义打分，替代/增强 `scoreCandidate` 关键词匹配。看两点再立项：P4 数据里「语义提示没帮上忙」的占比；以及图标密集页的 OCR 增强 2.5s 软预算被命中的频率。**硬约束**（策略篇 D2）：候选必须保底（现 `keepIdx = picked ∪ top3 ∪ vpTop8` 结构不得改为硬截断）。

### D3. 前后截图 diff 局部复核（2 天）

`verify.ts` 的 `sliceTargetRegion` 已做文本侧定向切片；补视觉侧：动作前后截图像素 diff → 只把变化区域裁剪图 + 变更摘要送 L2 复核。对 canvas 页（DOM 盲区，复核只能看图）收益最大。`deltaVerify`（`runner.ts` action_verify 体系）已有变更信号，接其输出做裁剪定位。

---

## 八、设置项与 UI

`shared/types.ts` Settings 增加一个版本块（沿用 v2.0/v3.0 的「全部默认开启、独立开关可逐层回滚」惯例，`types.ts:113`、`:128` 同款）：

```ts
// v4.6 Token 成本与提速：全部默认开启（独立开关可逐层回滚）
cacheAccounting: true      // A1/A2 计量埋点（无行为影响，不建议关）
stableSystemPrompt: true   // C1 附加段迁出 system
outputBudget: true         // C6 动态输出预算
textGridCoords: 'edges'    // C4: 'edges' | 'all' | 'off'
historyFold: true          // C2a 超长任务历史折叠
pagedRead: true            // C5 read_content 分片
obsDetail: true            // C3 元素分级（false = 恒 full）
replanTune: true           // B1 打转阈值调优
clickVerifyTune: true      // D1 视觉复核分档
localRetry: true           // B2 本地错误重试扩权
pageHashSkip: true         // B3 页面指纹去重
repeatNudge: true          // B5 repeat 提示
```

UI：设置页「智能增强」分组下新增「Token 优化」子分组，复用 v4.2 的智能开关网格组件（`TaskPanel.tsx`）。`textGridCoords` 用三态选择。所有开关读取处用 `settings.xxx !== false` 兜底（旧配置文件缺字段 = 开启），与现仓库惯例一致。

---

## 九、selftest / regression / benchmark 更新清单

| 文件 | 更新 |
|---|---|
| `selftest.ts:710-730` | formatCandidates 用例：补 `gridMode: 'edges'` 断言（>16 行时中间行无 `(格`，首尾有）；`withCoords=true` 现有断言不动 |
| `selftest.ts:1356-1435` | 10.2 提示词回归：normal 路径基线**仅在 C3 合入时更新一次**（注明变更原因）；新增断言——三开关全组合下 system === SYSTEM_PROMPT；mode 块落位断言 |
| `selftest.ts`（新增） | `renderHistoryLines` 纯函数单测；`outputBudget`/`isReasoningModel` 表断言；`pageHashOf` 稳定性；read_content 切片与缓存命中；clickVerifier 分档真值表；B3 `pageUnchanged` 判定边界 |
| `selftest.ts`（新增） | MFS 覆盖率用例（M1） |
| `regression/cases.json` | 补 2 个用例：翻页采集（验 B5/repeat）、读长文填表（验 C5） |
| `scripts/analyze-traces.mjs` | 第 6 节扩展（A1/A2：命中率 + site 分账）；`--compare` 模式（M2）；`extract` 事件的 `pageHash/omitted` 统计 |
| `telemetry.ts` | `llm_call` 增加 `site/cachedIn/truncated`；`task_end` 增加 `tokensCached`；`replan` 增加 `trigger`；`action_verify` 增加 `clickVerify` |

---

## 十、里程碑排期与验收门

```
P0（1.5d）A1 A2 A3 C1 C6 C4 ──► 验收门 G0：报表能算命中率与分账；parse_fail ≤0.5%；
                                  selftest 全绿（normal 提示词零变更）；benchmark 基线存档
P1（3d）  C2a C5 C3  ∥ M1 M2 ──► 验收门 G1：单步输入 token −35% 以上（非密集页）；
                                  MFS 覆盖率 100%；回归成功率不降
P2（2~3d）B1 D1 ──────────────► 验收门 G2：调用次数/任务 ≤22；clickVerify −50%；
                                  40+ 步任务占比下降；密集页拦截用例全过
P3（2.5d）B2 B3 B5 ───────────► 验收门 G3：单任务 token ≤65k；本地调用占比上升；
                                  打转 fixture 不再耗尽步数
P4（收尾）全量 benchmark 四配置对比 ──► G4：四项主指标进目标区，红线全绿 → 发版 v4.6.0
```

P5（C2b/D2/D3）在 G4 后按数据决策，不进 v4.6 主线。

---

## 十一、风险与回滚

| 风险 | 概率 | 影响 | 缓解 / 回滚 |
|---|---|---|---|
| C6 预算收紧截断推理模型思考 → parse_fail 上升 | 中 | 高 | `isReasoningModel` 分档 + **运行时自愈**（连续 truncated+parse_fail 自动回退 legacy 预算）+ 红线 2 监控；开关 `outputBudget: false` 即回现状 |
| C1 附加段落位变化影响模型行为（system 权重 > 正文） | 低 | 中 | 附加段文本逐字保留仅挪位置；普通路径逐字节零变更；视觉/测试用例回归；开关 `stableSystemPrompt` |
| C3 summary 裁掉全称/extra → 截断文案匹配退化 | 中 | 中 | 语义 Top-12 + 视口前 8 保留全字段；密集页恒 full；M1 `truncated-labels` fixture 强制门；开关 `obsDetail` |
| B1 重规划变频繁 → 步数反增 | 低 | 中 | replan telemetry 按 trigger 对账（G2 验收含「重规划均值上升 ≤0.5」）；failSig 触发仅限同节点内；开关 `replanTune` |
| B3 哈希假阴性（SPA 异步渲染中途哈希） | 中 | 低 | 连续 2 次省略后强制回全量；canvas/vision 排除；只在决策前判定；开关 `pageHashSkip` |
| D1 跳过视觉复核 → 密集页点错 | 低 | 高 | submitish 恒复核（不可妥协）；`dense-controls` 拦截用例全过才准发；开关 `clickVerifyTune` |
| B2 本地 0.5B 重试误点 | 中 | 中 | 连续 ≤2 步 + cooldown 5 + `validateLocalActions` 窗口校验（既有）+ expect_text 核验兜底（既有）；误触发率验收门；开关 `localRetry` |
| C2b（若启动）消息一致性破坏 abort/重试路径 | 高 | 高 | 前置：命中率数据证明收益；单独立项；不进 v4.6 |

**总回滚策略**：全部行为改动挂独立开关且默认值可单独关闭；计量类（A1/A2/A3）无行为影响常开。任一红线被触碰 → 关对应开关 → 热更新配置（`settings.ts` 已有即时生效机制）→ 不需回滚版本。

---

## 十二、附录

### 12.1 提示词逐字节守则（本轮延续 v4.5 纪律）

1. normal 路径（无 vision/canvas/test、非测试任务）的 system+user 消息，除 C3 的 summary 档字段裁剪外**逐字节不变**；
2. 所有新注入内容（mode 块、repeat 提示、read_content 尾注）全部走「动态后缀区 / 结果文本自描述」，不动 SYSTEM_PROMPT；
3. 任何必须改 SYSTEM_PROMPT 的需求 → 先在 selftest 10.2 建新基线并注明变更原因，禁止静默改；
4. 本地提示词（LOCAL_SYSTEM_PROMPT）无历史基线，B2 改动后在 selftest 锁定 v4.6 基线。

### 12.2 本轮新增发现（策略篇未覆盖）

1. **clickVerifier 每次调用新建 provider 实例且吃默认 2048 输出预算**（`index.ts:326`）——401 次/窗口的调用全是这个形状，A2/D1 一并修；
2. **C2 的缓存悖论**：追加式历史在前缀缓存命中时几乎免费，折叠只在无缓存端点/超长任务有正收益——策略篇「历史每步重发 = O(N²) 浪费」的说法需要这个修正（本文 C2a 收窄了范围，C2b 才是缓存时代的正解）；
3. **clickVerifier 与 L2 复核不在 token 账里**——A2 修复前，本项目的成本优化都是在盲区里做决策。

### 12.3 与既有文档的关系

- 策略篇（本文姊妹篇）：外部研究、论文引用、收益论证——本文不重复；
- `docs/EasyBow-v3-实施计划（评审整合版）.md`、`docs/EasyBow-v4.5-精准快速与节点可靠性优化方案.md`：已落地，本文在其之上叠加成本/步数维度，不改动其验收过的行为（T9 强制 L2 跳过率恒 0、复核证据包、接地规划等全部保留）。
