# EasyBow v4.6：Token 成本与操作决策提速升级方案

* **日期**：2026-10-15
* **基线版本**：v4.5.0（当前工作区，含未提交改动）
* **数据来源**：`scripts/analyze-traces.mjs --days 0` 真实运行 trace（2026-10-09 ~ 10-11，15 个任务 / 3258 条事件）+ 逐文件读码 + 前沿方案/论文核查（文末链接均已逐条验证可达）
* **方法声明**：下文分两类数字——**【实测】**来自 trace，可直接引用；**【推算】**来自代码路径推演与字符/token 换算，落地需按第七节基准方法实测确认。

---

## 〇、TL;DR

**一句话结论：现在的问题不是"单步 prompt 太大"，而是"步数太多 + 每步都在重复描述同一页"。**

【实测】单任务平均 **162,735 token / 29.9 次云端调用**，成功率 **13.3%**，6 个任务跑满 42~66 步打转至耗尽。

三个杠杆，按投入产出排序：

| 杠杆 | 依据 | 预期收益 | 工作量 |
|---|---|---|---|
| **A. 先把账算清**（缓存命中率/调用点分账） | TurnCost（arXiv:2610.15093）：600 条真实轨迹里 **98.6% 输入 token 命中前缀缓存**，按面值估成本会**高估约 7 倍**；轮次数解释 **84%** 的成本方差，观测大小只解释 **4%** | 决策依据本身 | 1 天 |
| **B. 减步数**（打转收敛 + 本地层扩权 + 免观测复用） | 同上，轮次是主因 | 调用次数 29.9 → 18~20 | 5~8 天 |
| **C. 每次调用瘦身**（分级观测 + 历史折叠 + 输出预算收紧） | A11y-Compressor（arXiv:2605.00551）：token 降到 22%，OSWorld **反而 +5.1pp** | 单次输入 -50% | 3~5 天 |

B × C 叠加：**162.7k → 约 50~65k token/任务（-60%~-70%）**，单步 P50 4.78s → 约 3.2s。

**最重要的单点**：`SYSTEM_PROMPT` 每步重发 4,150 字符（约 2.7k token），而 vision/canvas/test 附加段被拼进同一个 system 串（`runner.ts:2415-2418`），任一开关变化就**击穿 Anthropic `cache_control` 断点**（`llm.ts:183`），整轮任务后续全部按全价计费。而 `llm.ts` 只读 `input_tokens`、**从不读 `cache_read_input_tokens`**，所以你至今不知道自己有没有真的命中缓存。**这是全项目最便宜的一笔修复。**

---

## 一、诊断：钱和時間到底花在哪

### 1.1 【实测】成本画像（15 个真实任务）

| 指标 | 数值 |
|---|---|
| 云端调用 | 448 次 |
| 输入 token | 2,978,267 |
| 输出 token | 53,150 |
| 单次调用平均输入 | **6,648 token** |
| 单任务平均 | **162,735 token / 29.9 次调用** |
| 成功率 | **13.3%（2/15）** |
| 重规划 | 13 次（涉及 7 个任务） |
| **clickVerifier 视觉复核** | **401 次** ← 未计入上表 token 账 |

### 1.2 【实测】单步耗时解剖（P50，337 个样本）

```
总步耗时 4,776ms
├─ llm 模型调用  3,167ms  ████████████████ 66%   ← 瓶颈
├─ act 动作执行     414ms  ██  9%
├─ settle 批后等待  312ms  █   7%
├─ shot 截图         97ms
├─ extract 提取      95ms
└─ ax AX Tree        58ms
```

**关键观察**：本地提取链路（extract + ax）合计仅 153ms，**不是**速度问题。66% 的时间在等云端模型，而云端调用次数又被步数放大——所以**减步数同时省钱和省时间**，是唯一能同时打两个靶的杠杆。

### 1.3 【实测】失败形态：打转

步数明细：42 / 49 / 53 / 65 / 65 / 66，共 6 个任务步数超过默认值 `maxSteps: 30`（`shared/types.ts:102`）仍耗尽。成功率 13.3% 与此一致：**6 次重规划没能把这些任务救回来**，说明当前的重规划触发条件太晚、且给模型的信息不足以跳出循环。

### 1.4 【推算】6,648 token 花在哪（单次调用）

| 区块 | 位置 | 推算 token | 说明 |
|---|---|---|---|
| **system prompt** | `prompts.ts:5` | ~2,700 | 4,150 CJK 字符，**每步重发**；含 vision/canvas/test 附加段 |
| **元素列表** | `prompts.ts:319` | ~2,200 | 80 行 × ~50 字符 |
| **`lastResults`** | `prompts.ts:325` | 0 ~ 4,000 | `read_content` 单次可达 6,200 字符（`executor.ts:1716`），上限 6,500 |
| **历史摘要** | `prompts.ts:291` | 0 ~ 1,500 | **随步数线性增长，从不折叠** |
| 页签/页面/记忆/经验 | `prompts.ts:264-317` | ~500 | |
| 截图（视觉模式） | `runner.ts:2011` | ~1,200 | 1280×720 JPEG |

### 1.5 【实测+读码】被漏记的两笔账

1. **401 次 clickVerifier 视觉复核不进 token 账**。`executor.ts:1056` 在"同名候选 ≥2 或 submitish"时触发，密集 ERP 页几乎每次点击都触发；它只在 `runner.ts:1693-1718` 记 `action_verify` 事件，**不带 usage**。
2. **L2 节点复核同样不计**（`verify.ts:196`，`maxTokens: 4096` 换一个 `{"pass":true}` 约 15 token 的答案）。

**所以真实的单任务成本比 162.7k 更高，而周报看不到。**

---

## 二、核心判断：三条杠杆的优先级

用 TurnCost（arXiv:2610.15093，600 条真实轨迹）的结论校准：

> **轮次数解释 84% 的轨迹成本方差；平均观测大小只解释 4%。**

**含义**：把元素列表从 4,000 字符砍到 2,000 字符，省的是那 4%；把 30 步打成 15 步，省的是那 84%。

**但顺序不能反**——因为 Step A（把账算清）是你唯一能验证 B 和 C 是否生效的手段。按 TurnCost 的说法，在没有缓存命中率数据时按面值估成本会高估约 7 倍，你现在的所有"贵/不贵"判断都建立在这个错误基数上。

---

## 三、Step A：先把账算清（1 天，零风险）

### A1. 补缓存计量

**现状**：`llm.ts` 的 `finish` 只读 `res.usage?.prompt_tokens` / `input_tokens`（`llm.ts:115`、`llm.ts:199`），**完全丢弃缓存字段**。

**改**：
- OpenAI 兼容分支：读 `res.usage.prompt_tokens_details.cached_tokens` → `LlmResult.usage.cachedInputTokens`
- Anthropic 分支：读 `res.usage.cache_read_input_tokens` / `cache_creation_input_tokens`
- `shared/types.ts` 的 usage 结构加两个可选字段
- `telemetry.ts` 的 `llm_call` 事件带上 `cachedIn`

### A2. 给每次调用打上「调用点」标签

现在 `llm_call` 只有 `planner: boolean`，且 `verify` / `clickVerifier` 根本没埋点。改为显式 `site: 'plan' | 'step' | 'verify' | 'clickVerify' | 'replan' | 'enhance'`，**全部带 usage**。

### A3. 埋点「页面指纹」

`runner.ts:2039` 的 `extract` 事件已有 `candidates/totalFound/truncated`，追加一个 `pageHash`（URL + 标题 + 候选元素文本的 FNV 哈希）。这个字段后面是 B3「免观测复用」的基础。

### 验收

改完后 `npm run analyze-traces` 的第 6 节能给出**缓存命中率**与**按调用点分账**。这是后续所有优化的唯一裁判。

---

## 四、Step C：每次调用瘦身（3~5 天，全部确定性改动，零模型风险）

### C1. 修复 system prompt 缓存断点 ★最高性价比

**问题**：`runner.ts:2415-2418` 把 `VISION_ADDON` / `VISION_FALLBACK_ADDON` / `CANVAS_EDITOR_ADDON` / `TEST_MODE_ADDON` 直接拼进 system 字符串。一旦某步进入视觉兜底（最多 3 步）或 canvas 页，整个 system 串变化 → `llm.ts:183` 的 `cache_control` 断点失效。

**改**：system 只保留 `SYSTEM_PROMPT`（逐字节稳定）+ 任务描述（`buildStepMessage` 里的 `# 任务` 段，任务内不变）。把模式类附加段作为**独立的第二个 system block** 并**单独打 `cache_control: ephemeral`**，或降级为 user 消息末尾区块。

Anthropic 支持最多 4 个缓存断点，这样 vision 段单独缓存，切换模式只损失一个断点而非全部。

> 注意：OpenAI/DeepSeek 的自动前缀缓存不需要显式断点，但同样要求"前缀逐字节稳定"——把附加段放最后能救自动缓存，放 system 里会击穿它。**两边都受益。**

### C2. 历史摘要环形缓冲 ★

**问题**：`prompts.ts:291-302` 每步重发**全部**已执行步骤，N 步任务第 N 步要重发 N-1 行 × ~45 字符。第 30 步时约 1,350 字符，且**早先的行每步都在被重新计费**。

**改**：保留最近 6 步逐行明细 + 更早步骤折叠成 3 行聚合（"第 1~24 步：登录→筛选→批量填表，⚠3 步出错，详见记忆"）。锚点类信息（用过的 URL、已定位的 fp）保留完整——它们是跨步定位的关键，不能压。

> 与前缀缓存的关系：历史在**变化区之前**，把它折叠成定长文本可以让自动缓存的命中边界更靠后。但注意——**不要**把变化的时间戳/步号塞进这个区。

### C3. 元素列表分级 ★

charlotte（`TickTockBent/charlotte`，181★）实测同一批站点相对 Playwright MCP `browser_snapshot` 的压缩比：example.com 1.1×、httpbin 表单 3.0×、GitHub 仓库 10×、Wikipedia 文章 51×、Hacker News 139×。

按 EasyBow 现状实现三档：

| 档位 | 内容 | 用途 | 推算 token |
|---|---|---|---|
| `minimal` | 标题/URL/页签 + 语义 Top-8 元素 + 元素总数 | 定位（动作成功后确认页还在） | ~400 |
| `summary`（默认） | Top-30 元素 + 重复名警告 + 语义提示 | 执行 | ~1,300 |
| `full` | 全部 80~120 元素 | 密集页 / 兜底 / 失败重试 | ~2,200 |

**切换规则（确定性，不用模型判断）**：
- 上一步动作**成功**且无报错 → `minimal`
- 新页面 / URL 变化 / `node_done` → `summary`
- 上一步**报错**、触发了视觉兜底、密集页（同名候选 ≥5 组）→ `full`

这正好对应 Signal-Driven Observation（arXiv:2606.06708）的核心主张：**"把观测频率耦合到动作频率上是一个架构错误"**——只有信号触发时才做全量观测。

### C4. 关闭无视觉时的网格坐标

`extractor.ts:730-736`：即使 `withCoords=false`（纯文本模式）也给每行加 `(格x,y)`，80 行约 640 字符 ≈ **450 token/次的纯开销**。Vision 模式已有 `@x,y` 精确坐标，粗粒度网格在纯文本下的增益远小于成本。

**改**：`withCoords=false` 时不输出 `(格x,y)`；若实测发现"顶部菜单/底部翻页"类空间指代判断变差，改为**只对页面前 8 个 + 后 8 个元素**输出网格坐标（省 80%，保住空间感知）。

### C5. `lastResults` 分片取回

**问题**：`read_content` 单次回填 6,200 字符（`executor.ts:1716`，含 `READ_CONTENT_FN(6000)` + OCR 兜底 + 跨 frame 补充），上限 6,500 字符 ≈ **4,000 token**，而且模型通常只需要其中一行。

**改**（两条，二选一或并用）：
- **默认只回填 800 字符预览 + 显式告知总量**："已读页面正文 6,200 字，当前显示前 800 字。需要其他部分请 `{"name":"read_content","offset":800,"limit":1200}`"。
- `read_content` 增加 `offset`/`limit` 参数；`save` 已有"存记忆 + `{{key}}` 引用"的现成模式，可同样用于正文。

> 这一条对"读列表页 → 填表单"类任务（`save` + `switch_tab` + `type` 流程）收益最大，且不损失信息——信息还在，只是改成按需取。

### C6. 收紧输出预算

| 调用点 | 现状 | 建议 | 依据 |
|---|---|---|---|
| L2 复核 `verify.ts:198` | `maxTokens: 4096` | **256** | 答案就是 `{"pass":true}`，约 15 token；推理模型的思考 token 在此预算内**按量计费** |
| 规划 `runner.ts:1424` | 6144 | **1536** | 2~6 个节点，实测输出 JSON 远小于此 |
| 重规划 `runner.ts:1834` | 6144 | **1536** | 同上 |
| 单步决策 `llm.ts:101` | 2048 | **768** | 最多 5 个动作，实测平均输出 119 token |

**注意**：这一条是**输出**侧，对延迟和 TTFT 的改善通常比输入侧更直接（输出 token 是串行生成的）。【实测】平均输出 119 token 却申请 2048，说明预算完全没校准。

---

## 五、Step B：减步数（5~8 天，最大杠杆）

### B1. 打转检测提前 + 强制换路

**现状**：`runner.ts:3020-3034`，**连续 3 步无进展**才触发重规划，且重规划 ≤2 次/任务。13 次重规划没救回任何打转任务。

**问题诊断**：3 步太长（一个循环已经烧掉 3 次云端调用 ≈ 20k token），且 `REPLAN_SYSTEM_PROMPT` 给的"已失败方式"不足以让模型跳出——因为它只说"别重复这些做法"，却没告诉模型**为什么失败**和**页面上现在有什么新东西**。

**改**：
- 触发阈值 3 → **2**，并新增一条：**同一 `failSig` 重复出现**（`executor.ts` 已有 `a.failSig = click|expect|verify_fail` 机制）立即触发，不必等 3 步。
- 重规划预算从 2 次提到 3 次，但**每次必须带上前一次失败的页面 diff**（`deltaHint` 已有，扩展成结构化的"哪块变了"）。
- 重规划仍失败 1 次 → 直接进 `clarify` 问人，而不是继续烧步数。

> 依据：OSWorld 2.0（arXiv:2606.29537）的中位数是 **318 次工具调用**，在这个量级下"每 3 步才回头看一眼"必然在循环里耗尽。

### B2. 本地决策层扩权（0 cloud token 的步数）

**现状**（`runner.ts:2229-2244`）：本地 0.5B 直出被严格门控——禁 vision、禁人工指导、禁经验库、禁测试模式、首步不走，冷却 10 步。

**扩权建议**：目前**最该省云端调用的场景恰好全被门控挡住了**。放开这三类：

| 场景 | 现在 | 建议 | 理由 |
|---|---|---|---|
| **动作报错后的重试**（元素找不到/文本不符） | 走云端 | **本地重试**：重提取 + 本地挑候选，2 次内不上云 | 纯机械重试，云端模型给不出更多信息 |
| **`wait` / `scroll` 后确认页面稳定** | 走云端 | 本地直出 | 无判断含量 |
| **人工指导刚结束后的第 1 步** | 走云端 | 保持云端 | 这里判断最重要，不要动 |

`LOCAL_SYSTEM_PROMPT`（`prompts.ts:134`）需相应放开 `repeat` 和错误重试，并**扩大窗口**：`windowN = 30` 对密集页偏小，但窗口校验已经修好（`runner.ts:2245-2247` 的 `validateLocalActions(p, Math.min(windowN, ...))` 与渲染同窗口，这个 v4 的 bug 已经填了）。

### B3. 免观测复用（页面指纹去重）

用 Step A 埋的 `pageHash`：

- **命中且上一步无报错** → 直接复用上一步决策的剩余动作，不调模型（"repeat" 的自动版）
- **命中且上一步报错** → 只发"上次动作 + 错误 + 页面无变化"给模型，**不发全量元素列表**

这直接落地 SDO（arXiv:2606.06708）：全量 DOM 观测只在 URL 变化 / 出现新可交互元素 / 动作失败 / 外部浏览器事件时触发。

### B4. 动作缓存（跨任务）

Stagehand（`browserbase/stagehand`，25.6k★）默认开启动作缓存，缓存键 = 指令 + 页面内容 + 选项，命中即**零 LLM 推理、零 token**。

对 EasyBow 的形态：`(site + 页面指纹 + 目标文案)` → 上次成功动作 + `expect_text`。注意 Stagehand 的缓存依赖 Browserbase 的托管会话，**自建必须自己实现**——且要注意 Session 态（登录后页面内容不同）的失效策略。

### B5. 提高批量度

每步上限已是 5 个动作。补一条规则到 system prompt：**同一类操作连续 ≥3 次时用 `repeat`**（`executor.ts:1656` 已有该动作，0 LLM 调用）。这在"翻页采集""批量填表"场景是数量级差异。

---

## 六、第四层：让判断更准（与 B/C 并行）

### D1. clickVerifier：401 次调用零计量，先分类再上视觉

【实测】401 次 / 448 次云端调用——**几乎每次动作都触发一次额外的视觉裁剪调用**。这既是成本，也是延迟。

**改**（三档）：
1. `expect_text` 与候选元素文本**精确匹配**且同名候选唯一 → 跳过视觉复核（现有 `resolveIndex` 的实时身份校验已经做了这件事，把它作为视觉复核的前置条件）
2. 文本匹配但同名 ≥2 → 保留视觉复核（这是它真正该干的场景）
3. submitish（提交/删除/支付）→ **始终保留**，这类点错的代价不对称

预期：401 → 150 次左右，且不降低密集页安全性。

### D2. 本地 grounding 给候选打分

现在的候选排序是 `scoreCandidate`（关键词/语义重合，`runner.ts:2323`）+ 0.5B 预筛。可替换/增强为真正的 grounding 模型：

- **OmniParser V2**（`microsoft/OmniParser`，25.5k★，MIT 检测器）——把图标按钮解析成可点击语义，正好治 EasyBow 已有的痛点（图标按钮 OCR 增强要 2.5s 软预算，`runner.ts:2030`）
- **GroundingDINO**（`IDEA-Research/GroundingDINO`，10.7k★）——文本条件开放集检测，CPU 可跑，做 a11y 节点 ↔ 候选框打分

**重要警告**（arXiv:2609.27770）：零样本稠密检索器把正确元素放进候选集的概率只有 **0.52（Mind2Web）/ 0.47（WebArena）**。**绝不能在弱检索器上做 top-k 硬截断**——会静默摧毁任务。当前的 `keepIdx = picked ∪ top3 ∪ vpTop8` 结构是安全的（保底而非截断），改造时**必须保留这个保底结构**。

### D3. diff 观测 + 局部复核

Read-More-Think-More（arXiv:2604.01535）结论：diff 表示是全量重观测的 token 高效替代。EFR（arXiv:2608.24015）把它做成两阶段 reflector（先用 SoM 定位候选变化区域 → 描述并过滤动作相关变化 → 据清洗后的证据判断），reflector 准确率 **+7.11%**，端到端 OSWorld-Verified **+5.94%**。

对 EasyBow：`verify.ts` 的 `sliceTargetRegion`（≤1400 字符）已经是这个方向的一半。补上**动作前后截图的像素 diff → 只把变化区域的裁剪图送给复核器**即可，canvas 页面（DOM 盲区）尤其受益。

### D4. ⚠️ 压缩强度要按模型能力分档（重要反直觉结论）

Read-More-Think-More（arXiv:2604.01535）**推翻了"观测越少越好"的旧共识**：

> 紧凑观测（a11y tree）对**能力较弱的模型**有利；详细观测（原始 HTML）对**能力更强的模型**有利，且**增加思考 token 会进一步放大 HTML 的优势**。机制是前沿模型能从 HTML 里挖掘**布局**信息用于动作定位。

**对 EasyBow 的直接含义**：C3 的压缩档位**不能设成固定比例**，要跟着主模型走。用 Opus/GPT-5 级 + extended thinking 时，`minimal` 档要放宽、`full` 档要给更多结构信息；用 0.5B/3B 本地模型时才激进压缩。建议把压缩档位做成**跟随模型设置的派生值**，而不是写死。

---

## 七、评测：没有这个，前面全是盲改

### 7.1 用 MFS 代替端到端成功率做回归

arXiv:2605.29397 的核心贡献，值得单独说：

- 它评估 11 种观测缩减方法 × 32 种配置 × 33 个 WorkArena-L1 任务，**累计耗时 232.4 小时**——这就是为什么多数已发表的剪枝结论不可信
- 提出 **MFS（Minimal Failure Set）**：使任务失败的最小 HTML 元素集合。"覆盖率"= 缩减方法完整保留 MFS 的比例，与端到端 SR 强相关，**快 100 倍以上，且不需要联网、不需要 LLM 推理**
- 其自研的学习式剪枝器：**WorkArena L1 单步延迟 2.2×、SR 保留 84%；WebLinx 3.1×、89%**

**落地**：EasyBow 的 `resources/fixtures/`（已有 `dense-controls.html`、`truncated-labels.html`）就是天然的 MFS 载体——给每个 fixture 标注"任务成败依赖哪几个元素"，然后任何压缩改动都先跑 MFS 覆盖率，快且确定。

### 7.2 直接用现成的 A/B 台

`npm run benchmark` 已有 4 个配置（`regression/index.ts:357`）：`cloud` / `hybrid` / `hybrid-fast` / `soak`，逐用例记录 `steps / durationMs / stepMs[] / tokens / expects / triage`。

**建议的验收口径**（每次改动都要过）：

| 指标 | 现状 | 目标 |
|---|---|---|
| 单任务 token | 162.7k【实测】 | ≤ 65k |
| 云端调用次数 | 29.9【实测】 | ≤ 20 |
| 单步 P50 耗时 | 4,776ms【实测】 | ≤ 3,200ms |
| 缓存命中率 | 未知（未埋点） | ≥ 80% |
| 成功率 | 13.3%【实测】 | **不得下降**（这是硬约束） |
| MFS 覆盖率 | 未建 | 建立后 ≥ 基线 |

---

## 八、排期建议

| 阶段 | 内容 | 工作量 | 前置 |
|---|---|---|---|
| **P0** | Step A 计量（A1/A2/A3）+ C1 缓存断点 + C6 输出预算 + C4 网格坐标 | **1.5 天** | 无 |
| **P1** | C2 历史折叠 + C5 `lastResults` 分片 + C3 元素分级 | **2.5 天** | P0 计量 |
| **P2** | B1 打转收敛 + D1 clickVerifier 分档 | **3 天** | P0 |
| **P3** | B2 本地层扩权 + B3 指纹去重 + B5 repeat 规则 | **3 天** | P1 |
| **P4** | 7.1 MFS 评测基线 + 7.2 A/B 台跑基线 | **2 天** | 建议与 P1 并行 |
| **P5** | D2 本地 grounding / D3 diff 复核（可选，按 P4 结果决定） | **3~5 天** | P4 |

**前 4 天就能拿到 60% 的收益**（P0+P1 合计 4 天，覆盖全部"确定性瘦身"）。

---

## 九、不要做的事（避免踩坑）

1. **不要上 LLM-in-the-loop 的行级抽取器**（FocusAgent 式，arXiv:2510.03204 观测砍 50%）。arXiv:2605.29397 的负面结论很明确：*"抽取式 HTML 缩减方法要么计算成本高、要么需要领域专优化，才能在保持性能的同时降低延迟"*——**抽取器自己的前向传播往往盖过省下的收益**。要剪就用确定性规则，并按 MFS 离线拟合。
2. **不要在弱检索器上做 top-k 硬截断**（arXiv:2609.27770，零样本召回仅 0.47~0.52）。
3. **不要压缩均匀地施加到所有模型档位**（arXiv:2604.01535，见 D4）。
4. **不要在优化观测大小之前先优化轮次**——84% vs 4%。
5. **不要用 LLM 在文本上做自我验证**。arXiv:2607.24300 指出自证式验证在启发式自改进 agent 中不可靠；而 VLM 看截图判完成度可行——arXiv:2511.20067 达到 **73%** 成功率判别准确度、端到端 **+27%**。EasyBow 的 canvas 页面正好是这个场景。
6. **不要继续往 system prompt 里加规则**。现在 4,150 字符里规则已经到第 18 条，规则密度已经影响可执行性（模型在密集页仍会点错行）。加规则前先做 C3 的分级观测——**给更准的观测比给更多规则便宜得多**。

---

## 十、可直接借鉴的参考实现（链接已逐条验证可达）

| 项目 | 用途 |
|---|---|
| [`TickTockBent/charlotte`](https://github.com/TickTockBent/charlotte)（181★） | 分级观测（minimal/summary/full）的实测压缩比来源；MCP 快照 |
| [`browserbase/stagehand`](https://github.com/browserbase/stagehand)（25.6k★） | `observe(goal)` 返回真实选择器 + 默认开启的动作缓存（缓存键设计） |
| [`browser-use/browser-use`](https://github.com/browser-use/browser-use)（118k★） | 属性白名单（`DEFAULT_INCLUDE_ATTRIBUTES`）、`compute_stable_hash`、`filter_dynamic_classes`、hash→xpath→ax-name 三级回退、双序列化器（LLM 视图 / eval 视图分离） |
| [`APUS-AI-Lab/fast-browser-use`](https://github.com/APUS-AI-Lab/fast-browser-use)（229★） | System-1 本地引擎：候选动作映射为**单 token**（A/B/C），softmax 选；动作与 DONE **同一次前向打分**，推理次数 14→4；结构上消除选择器幻觉 |
| [`microsoft/OmniParser`](https://github.com/microsoft/OmniParser)（25.5k★） | OmniParser V2 图标/截图解析（YOLOv9-E 检测器，MIT） |
| [`ServiceNow/BrowserGym`](https://github.com/ServiceNow/BrowserGym)（1.4k★） | 统一 obs/action 的基准框架，可作自建评测底座 |
| [`justrach/kuri`](https://github.com/justrach/kuri)（366★） | token 高效 CDP 快照 |

**本地模型现状对照**：EasyBow 已内置 Qwen2.5-0.5B-Instruct q8（`resources/fastmodel/`，512MB，onnxruntime-web WASM 单线程）+ whisper-base + PP-OCR，均为 0 cloud token。缺的是**grounding 专用模型**（OmniParser/GroundingDINO）和**"单 token 候选选择"输出头**——后者是把 0.5B 从"生成 JSON"改成"打分选择"，是本地层扩权的关键技术前提（见 B2）。

---

## 十一、关键论文（arXiv 编号均已验证可达）

| 编号 | 标题要点 | 本方案引用处 |
|---|---|---|
| [arXiv:2610.15093](http://arxiv.org/abs/2610.15093) | TurnCost：轮次解释 84% 成本方差；98.6% 缓存命中；面值高估 7× | 〇、Step A、Step B |
| [arXiv:2604.01535](http://arxiv.org/abs/2604.01535) | Read More, Think More：压缩收益与模型能力**反向相关**；diff 历史 | D4、B3 |
| [arXiv:2605.00551](http://arxiv.org/abs/2605.00551) | A11y-Compressor：token →22%，OSWorld +5.1pp | Step C |
| [arXiv:2605.29397](http://arxiv.org/abs/2605.29397) | 观测缩减方法全面评估；MFS 代理指标；抽取式剪枝的负面结论 | 7.1、九(1) |
| [arXiv:2606.06708](http://arxiv.org/abs/2606.06708) | Signal-Driven Observation：观测频率不应耦合动作频率 | C3、B3 |
| [arXiv:2608.24015](http://arxiv.org/abs/2608.24015) | EFR：基于动作诱导视觉差异的反思，reflector +7.11% | D3 |
| [arXiv:2511.20067](http://arxiv.org/abs/2511.20067) | "Are We Done Yet?"：视觉判完成度 73% | 九(5) |
| [arXiv:2609.27770](http://arxiv.org/abs/2609.27770) | 候选过滤：零样本召回仅 0.47~0.52 | D2、九(2) |
| [arXiv:2606.10423](http://arxiv.org/abs/2606.10423) | WebChallenger / PageMem：DOM 确定性构造的分层页面表示 | C3 |
| [arXiv:2605.07134](http://arxiv.org/abs/2605.07134) | Region4Web：观测粒度 ≠ 动作粒度 | C3 |
| [arXiv:2508.04412](http://arxiv.org/abs/2508.04412) | DOM Downsampling（D2Snap）：子树合并式有损压缩 | C3 |
| [arXiv:2510.03204](http://arxiv.org/abs/2510.03204) | FocusAgent：LLM 行级抽取（**注意其负面结论**，见九(1)） | 九(1) |
| [arXiv:2410.13825](http://arxiv.org/abs/2410.13825) | AgentOccam：动作空间对齐 +9.8 WebArena | 附录参考 |
| [arXiv:2607.24300](http://arxiv.org/abs/2607.24300) | 自证式验证在自改进 agent 中不可靠 | 九(5) |

---

## 附录：与既有方案文档的关系

- `docs/EasyBow-速度与准确率专项改进-2026-10-10.md` —— 已在 v4.x 落地（并行竞速、OCR 按需、极速档、SoM 标注、预筛窗口修复、fp 指纹、网格坐标）。本文**不重复**这些。
- `docs/EasyBow-v4.5-精准快速与节点可靠性优化方案.md` —— 已落地（多源截断识别、接地规划、PlanValidator、复核证据包）。本文在其之上叠加**成本与步数**维度。
- 本文新增的、与前两份不重叠的核心结论：**缓存断点被击穿且从未计量**（C1）、**输出预算未校准**（C6）、**clickVerifier 401 次零计量**（D1）、**打转检测过晚**（B1）、**压缩强度需按模型档位**（D4）。
