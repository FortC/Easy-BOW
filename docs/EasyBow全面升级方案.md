# EasyBow 全面升级方案

> **愿景**：让 AI 真正丝滑地操作浏览器完成复杂工作。
>
> **版本**：v2.0（整合版）　**日期**：2026-10-09　**适用**：EasyBow v1.4.0（Electron 44.6.0）
>
> 本方案整合三个议题：
> ① 字段名语义不一致导致的操作链中断（原《语义匹配增强方案》）
> ② AI 操作智能度与顺滑度的系统性提升（原《丝滑化改造方案》）
> ③ 反风控与操作拟人化（新增第 8 章）

---

## 目录

- [第 0 章 适用边界与工程原则](#第-0-章-适用边界与工程原则)
- [第 1 章 现状评估](#第-1-章-现状评估)
- [第 2 章 目标架构](#第-2-章-目标架构)
- [第 3 章 语义智能 S1](#第-3-章-语义智能-s1)
- [第 4 章 自愈智能 S2 + S4](#第-4-章-自愈智能-s2--s4)
- [第 5 章 感知增强 S3 + S6](#第-5-章-感知增强-s3--s6)
- [第 6 章 记忆进化 S5](#第-6-章-记忆进化-s5)
- [第 7 章 度量体系 S0](#第-7-章-度量体系-s0)
- [第 8 章 反风控与拟人化](#第-8-章-反风控与拟人化)
- [第 9 章 实施路线图](#第-9-章-实施路线图)
- [第 10 章 风险总表与回滚](#第-10-章-风险总表与回滚)
- [附录 A 失败分类学速查](#附录-a-失败分类学速查)
- [附录 B 语义词表扩展指南](#附录-b-语义词表扩展指南)

---

# 第 0 章 适用边界与工程原则

## 0.1 本方案的适用边界

本方案的能力目标是**降低正常自动化操作被误判的概率**，适用于：

| ✅ 覆盖 | 场景说明 |
|---|---|
| 自有账号业务自动化（RPA） | 用户用自己的账号操作自己的电商后台、ERP 系统 |
| 自有系统自动化测试 | 对自己开发的 Web 应用做 E2E 测试 |
| 降低误判 | 让正常操作不被风控系统错误识别为机器人 |
| 优雅降级 | 遇到风控挑战时正确识别、暂停、交还人工 |

| ❌ 不覆盖 | 原因 |
|---|---|
| 验证码 / 滑块破解 | 属于绕过访问控制，且技术上不可持续 |
| 绕过登录或身份认证 | 同上 |
| 大规模爬取他人数据 | 违反服务条款与法律 |
| 伪造身份进行欺骗性操作 | 违法 |
| 绕过付费墙 / 访问权限 | 同上 |

> **重要**：EasyBow 的核心场景是"用户自己的账号 + 自己的业务系统"。在这个场景下，
> **保持真实登录态的价值远高于任何指纹伪装技术**——这是第 8 章的核心论点。

## 0.2 五条工程原则

1. **不增加新的云端 LLM 调用**——新增逻辑走本地计算或复用已有调用
2. **每阶段独立可上线、独立可回滚**——全部走 `Settings` 开关
3. **不动 iframe 穿透核心**——既有优势，任何改造不得削弱
4. **不做过度伪装**——指纹"一致性"远比"伪装程度"重要（见 8.2）
5. **被拦截时优雅降级，不硬闯**——识别风控 → 暂停 → 交还人工

---

# 第 1 章 现状评估

## 1.1 已有能力（保留，不推倒）

| 层 | 实现 | 文件 | 评价 |
|---|---|---|---|
| 感知 | iframe 穿透（2 层）、Shadow DOM 图片扫描、可见性/遮挡检测 | `extractor.ts` | iframe 场景**强于 AX Tree** |
| 感知 | OCR 整页识别兜底 | `ocr/index.ts` | 覆盖视觉盲区 |
| 感知 | 视觉模式 + 视觉兜底 `click_xy` | `prompts.ts` | 坐标级兜底已有 |
| 推理 | 本地小模型快速决策 + 云端大模型 | `fastllm.ts` | 分层推理已有 |
| 规划 | 节点链（2-6 节点，含可观察预期） | `agent/plan.ts` | 与业界 HTN 规划同思路 |
| 复核 | L0 确定性 / L1 本地 / L2 云端终审 | `agent/verify.ts` | **三层判定是成熟设计** |
| 执行 | 真实键入 → 回读验证 → 原生 setter 兜底 | `executor.ts` | 硬校验已有 |
| 记忆 | 任务内 `save`/`recall` | `agent/prompts.ts` | 任务内可用 |
| 记忆 | 人工经验库（按域名注入） | `knowledge.ts` | 有，但**完全靠人写** |
| 风控 | 验证码/登录摩擦检测 | `extractor.ts` `DETECT_FRICTION_FN` | 已有基础探测 |

## 1.2 八个真实短板

### 短板 1：兜底触发条件太窄（最关键）

`agent/runner.ts:1570-1577`：

```typescript
const locateFail = executed.some(
  (a) => !!a.error && /已失效|不可见|找不到|无法定位|没有可点击|超出范围/.test(a.error)
)
if (locateFail) this.locateFailStreak++
```

只认"定位失败"一类。真实失败至少七类（见[附录 A](#附录-a-失败分类学速查)），其余六类**不产生 error**，兜底永不触发。

### 短板 2：语义匹配压在模型裸奔

`extractor.ts:266-284` `formatCandidates` 只做格式化，零语义处理。模型每步都要做一次高难度近义词推理，小模型模式下更不可靠。

### 短板 3：猜错是静默的

`executor.ts` `case 'type'` 只校验"值填对了吗"，不校验"填的是不是那个字段"：

```typescript
if (vr.ok && vr.value === text) { /* 成功 */ }
```

用户要填"商品名称"，模型误填进"名称编码" → 值正确 → 无 error → 数据静默写错。

### 短板 4：候选元素信息量不足

`extractor.ts:83-129` `textOf` 缺失三类语义锚点：
- `name` / `id` / `autocomplete` 属性
- **邻近文本**（表格布局里 label 常在相邻 `td`——`adjacentOf` 只存在于 `testcase/fields.ts`，主 extractor 没有）
- 元素层级上下文

后果：老式 ERP（聚水潭表格布局）中字段在提示词里显示为 `[12] <input文本> ""`，**完全空白**。

### 短板 5：目标元素可能在提取阶段被截断

`extractor.ts:251` `out.slice(0, maxElements)` 硬截断，排序只按 `_score`（视口+角色+文本长度），**与任务意图无关**。300+ 元素页面，目标可能在第 85 位被切掉。

### 短板 6：经验库是"人写"的，AI 不会自己提炼

`knowledge.ts` 的 `SEED` 和 `setKB` 全部来自用户手工录入。AI 今天踩的坑明天原样再踩。

### 短板 7：模型被迫单点押注

当前契约要求模型从清单里挑**一个**编号。没有"多候选让系统裁决"的机制，也没有"我不确定"的表达通道。

### 短板 8：UA 直接暴露 Electron 身份

`src/main/index.ts:99` 创建窗口时 `webPreferences` 只有 `preload` 和 `sandbox`，**无 UA 覆盖**。默认 UA 末尾带 `Electron/44.6.0`——等价于主动声明"我是 Electron 应用"。

---

# 第 2 章 目标架构

## 2.1 八层模型

```
┌──────────────────────────────────────────────────────────────┐
│ L8 反风控层  指纹一致性 / 行为拟真 / 会话复用 / 优雅降级  【第8章】│
├──────────────────────────────────────────────────────────────┤
│ L7 度量层    trace / 回归套件 / 成功率看板             【S0】  │
├──────────────────────────────────────────────────────────────┤
│ L6 记忆层    站点经验库 / 字段指纹 / 失败教训          【S5】  │
├──────────────────────────────────────────────────────────────┤
│ L5 恢复层    失败分类学 → 分类自愈策略                【S2】  │
├──────────────────────────────────────────────────────────────┤
│ L4 规划层    节点链 + 偏离重规划                      【S2】  │
├──────────────────────────────────────────────────────────────┤
│ L3 决策层    多候选 + 不确定性表达                    【S4】  │
├──────────────────────────────────────────────────────────────┤
│ L2 定位层    语义召回 + 别名扩展 + 指纹重定位         【S1】  │
├──────────────────────────────────────────────────────────────┤
│ L1 感知层    DOM + iframe穿透 + OCR + AX Tree(并联)   【S3】  │
├──────────────────────────────────────────────────────────────┤
│ L0 执行层    真实键入 + 回读校验 + 语义校验           【S1】  │
└──────────────────────────────────────────────────────────────┘
```

## 2.2 三条闭环

| 闭环 | 解决的问题 | 对应 | 效果 |
|---|---|---|---|
| **A 语义对齐** | 商品名称 ≠ 名称 | S1 | 断链率大幅下降 |
| **B 失败归因** | 七类失败只认一类 | S2 | 自愈率提升，静默错误归零 |
| **C 经验沉淀** | 坑要踩两次 | S5 | 二次执行显著更快更准 |

---

# 第 3 章 语义智能 S1

> 解决"商品名称 ≠ 名称"断链 + "填错字段不报错"静默错误。**收益最大，优先做。**

## 3.1 新建 `src/main/semantic.ts`

纯函数模块，不依赖 Electron/CDP，可单测。

```typescript
export interface SemanticCandidate {
  text: string
  extra: string
  role: string
  tag: string
}

/** 业务同义词组：组内任意词视为等价 */
export const SYNONYM_GROUPS: string[][] = [
  ['商品', '产品', 'sku', '货品', '宝贝', '物品'],
  ['名称', '名字', '标题', '品名', '商品名', '产品名称'],
  ['价格', '单价', '金额', '总额', '费用', '售价'],
  ['数量', '个数', '件数', 'qty'],
  ['收货人', '联系人', '买家', '收件人', '客户姓名'],
  ['地址', '收货地址', '详细地址', '所在地区'],
  ['电话', '手机', '联系电话', '手机号', '联系方式'],
  ['邮箱', '邮件', '电子邮箱', 'email'],
  ['编号', '编码', 'code', '序列号'],
  ['图片', '主图', '照片', 'image', 'pic'],
  ['详情', '描述', '介绍', '说明', 'detail'],
  ['备注', '说明', 'note', 'remark'],
  ['类目', '分类', '类别', 'category', '类型'],
  ['店铺', '店铺名', 'store', 'shop'],
  ['时间', '日期', 'date', '创建时间'],
  ['状态', 'state', 'status']
]

/** 归一化：全角→半角、去空格、去标点、小写 */
export function normalize(s: string): string {
  if (!s) return ''
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .replace(/[：:，,。.、（）()【】[\]"'"'`~*#]/g, '')
    .toLowerCase()
    .trim()
}

/** 同义词展开：输入词 → 所在组全部词（含自身） */
export function expandSynonyms(word: string): Set<string> {
  const w = normalize(word)
  const out = new Set<string>([w])
  for (const g of SYNONYM_GROUPS) {
    const gn = g.map(normalize)
    if (gn.includes(w)) gn.forEach((x) => x && out.add(x))
  }
  return out
}

/** 抽取任务关键名词（中文 2-6 字窗口 + 英文词） */
export function extractKeywords(task: string): string[]

/** Dice 二元组字符相似度 */
export function dice(a: string, b: string): number

/** 综合语义打分 0~1 */
export function scoreCandidate(cand: SemanticCandidate, task: string): {
  score: number
  matchedVia: string[]
}
```

**打分三级**：
1. 直接包含 → `0.85 + min(0.1, len×0.02)`（"名称"在"商品名称"里）
2. 同义词等价 → `0.78`（商品↔产品）
3. Dice 模糊 → `dice × 0.7`（抗字面差异）

角色加成：目标为输入类元素时 `+0.05`。

## 3.2 改造 `extractor.ts`

### 改动 A：`extra` 上限 90 → 160

为新增语义线索留空间。

### 改动 B：`EXTRACT_FN` 内新增两个采集函数

```typescript
/** 属性锚点：name / id / autocomplete（表单字段的英文语义线索） */
function attrsOf(el: Element): string {
  const bits: string[] = []
  const nm = normText(el.getAttribute('name'))
  const id = normText(el.getAttribute('id'))
  const ac = normText(el.getAttribute('autocomplete'))
  if (nm) bits.push(`name=${nm.slice(0, 24)}`)
  if (id && id !== nm) bits.push(`id=${id.slice(0, 24)}`)
  if (ac) bits.push(`ac=${ac}`)
  return bits.join(' ')
}

/**
 * 邻近文本：表格布局里 label 常在相邻 td。
 * 注：此能力原仅存在于 testcase/fields.ts，主 extractor 缺失，
 * 导致老式 ERP（聚水潭等）字段在提示词里是空白元素。
 */
function adjacentOf(el: Element): string {
  try {
    const cell = el.closest('td,th')
    if (cell?.parentElement) {
      const t = normText((cell.parentElement as HTMLElement).innerText)
      if (t) return t.slice(0, 60)
    }
    const wrap = el.closest('.form-item,.form-group,.field,.ant-form-item,.el-form-item')
    if (wrap) return normText((wrap as HTMLElement).innerText).slice(0, 60)
    const prev = el.previousElementSibling
    if (prev && !/^(INPUT|SELECT|TEXTAREA)$/.test(prev.tagName)) {
      const t = normText((prev as HTMLElement).innerText)
      if (t && t.length <= 12) return t.slice(0, 24)
    }
  } catch {}
  return ''
}
```

在 `collect()` 的 `out.push` 处并入 `extra`。

### 改动 C：语义重排

```typescript
export function rerankByTask(res: ExtractResult, task: string, topBoost = 8): ExtractResult
```

语义分 ≥ 0.5 的元素显著提前，其余保持原序。填充 `semanticHints`（Top-6 命中项及理由）。

### 改动 D：`formatCandidates` 末尾追加提示段

```
# 语义匹配提示（下列元素与任务描述语义相关，已排在前面，优先从中选择）
  [3] 名称 — 同义:商品名称≈名称 (相似度 82%)
  [7] 商品标题 — 模糊:商品名称(0.61) (相似度 43%)
注意：以上提示基于字面与同义词推断，仅供参考；仍需结合 role 与实际语义确认。
```

## 3.3 改造 `executor.ts`：填后语义校验

新增 `READ_LABEL_FN`（读元素 label/placeholder/name/adjacent），在 `case 'type'` 成功分支插入：

```typescript
// 语义校验：填对了值 ≠ 填对了字段
if (settings.semanticVerify !== false && ctx.task) {
  const lr = await t.cdp.evaluate<LabelResult>(READ_LABEL_FN, [framePaths, path]).catch(() => null)
  if (lr?.found) {
    const actual = [lr.label, lr.placeholder, lr.name, lr.adjacent].filter(Boolean).join(' ')
    const want = extractTargetField(ctx.task)
    if (want && actual) {
      const sim = scoreCandidate(
        { text: lr.label, extra: `${lr.placeholder} ${lr.name} ${lr.adjacent}`, role: '', tag: '' },
        want
      ).score
      if (sim < 0.45) {
        a.error = `疑似填错字段：目标「${want}」但实际是「${actual.slice(0,20)}」（相似度 ${(sim*100).toFixed(0)}%），请改选更匹配的输入框`
        return false
      }
    }
  }
}
```

**这一步把静默错误变成显式可自愈的失败——S1 中价值最高。**

## 3.4 扩展提取

`extractBoosted(tab, task, 160)`：任务关键名词一个都没命中候选时，提高上限重提取一次（`retryRaised` 标志防重复）。

同时把 `EXTRACT_FN` 里 `window.innerHeight * 4` 放宽到 `* 8`，减少"必须滚动"的往返。

## 3.5 验收

| # | 任务 | 页面字段 | 预期 |
|---|---|---|---|
| 1 | 填入商品名称 | 名称 | 选中 |
| 2 | 填入商品名称 | 商品名 | 选中 |
| 3 | 填写收货人电话 | 联系人 / 手机 | 拆分正确 |
| 4 | 设置商品价格 | 单价 | 选中 |
| 5 | 填入商品标题 | 名称 | 选中 |
| 6 | 填入商品名称（页面仅有"名称编码"） | 名称编码 | **报错，不静默成功** |

---

# 第 4 章 自愈智能 S2 + S4

## 4.1 S2 失败分类学

新建 `src/main/diagnose.ts`：

```typescript
export type FailureKind =
  | 'locate'        // 定位失败：元素失效/不可见/找不到
  | 'semantic'      // 语义选错：填进了语义不匹配的字段
  | 'page_changed'  // 页面异变：URL 变了 / 出现弹窗 / 意外跳转
  | 'data_missing'  // 数据取不到
  | 'verify_fail'   // 复核未通过
  | 'loop'          // 循环：同一动作连续失败 ≥3
  | 'exhausted'     // 步数耗尽

export interface Diagnosis {
  kind: FailureKind
  hint: string                    // 给模型看的人话，直接注入下一步提示词
  strategy: 'retry' | 'rerank' | 'reextract' | 'replan' | 'escalate' | 'abort'
}
```

### 判定顺序（先具体后一般）

| 优先级 | 条件 | 判定 | 策略 |
|---|---|---|---|
| 1 | error 匹配 `/已失效\|不可见\|找不到\|无法定位/` | `locate` | `reextract` → `escalate` |
| 2 | error 含"疑似填错字段" | `semantic` | `rerank`（列 Top-5 候选）|
| 3 | URL 变化且非 goto 动作导致 | `page_changed` | `reextract` + 告知 |
| 4 | 出现新弹窗（DOM Modal / 原生对话框）| `page_changed` | `reextract` |
| 5 | `read_content` 空 / `extract_images` 返回"没有" | `data_missing` | `retry` |
| 6 | 复核未通过 | `verify_fail` | 已有逻辑 + 注入标签 |
| 7 | 同一动作名连续失败 ≥3 | `loop` | `escalate` |
| 8 | `stepNo > maxSteps` | `exhausted` | `abort` + 结构化诊断 |

### 接入 `runner.ts`

替换现有 `locateFail` 单点判定：

```typescript
const d = diagnose({
  actions: executed, extract, prevExtract: this.prevExtract,
  sameActionStreak: this.sameActionStreak, stepNo: stepN, maxSteps
})
if (d) {
  this.telemetry.log('failure', stepN, { kind: d.kind, strategy: d.strategy })
  await this.applyStrategy(d)
  this.lastResults.push(`系统诊断: ${d.hint}`)
}
```

### 步数耗尽诊断化

当前 `runner.ts:1248` 只输出一句"已达到最大步数"。改为：

```
已达最大步数 30，任务未完成。诊断：
- 卡在节点 3「填写商品信息」
- 最后 5 步持续失败类型：semantic（疑似填错字段）
- 建议：检查目标页面字段命名，或在经验库中补充该站点字段对应关系
```

## 4.2 S4 多候选与不确定性

### 契约扩展

`shared/types.ts` `AgentAction` 增加：

```typescript
candidates?: number[]   // 多候选编号，让系统裁决
uncertain?: number      // 模型自述不确定度 0~1
```

### 提示词改造（`prompts.ts`）

```
18. **不确定时不要硬选**：列表里没有把握的目标时，输出
    {"name":"clarify","query":"你指的是哪个字段？候选：<3个最像的编号与文字>"}。
    禁止猜一个凑数
19. **多候选优先**：能缩小到 2-3 个但无法定夺时，输出 "candidates":[3,7,12]，
    系统结合语义分裁决，比你硬选更准
```

新增动作 `clarify`（不消耗失败预算，升级人工）。

### 裁决器

```typescript
if (a.candidates?.length) {
  const scored = a.candidates
    .map((i) => ({ index: i, score: scoreCandidate(extract.candidates[i], taskText).score }))
    .sort((x, y) => y.score - x.score)
  if (scored[0]?.score >= 0.6) {
    a.index = scored[0].index
    a.result = `已从 ${a.candidates.length} 个候选中裁决为 [${scored[0].index}]（相似度 ${(scored[0].score*100).toFixed(0)}%）`
  } else {
    a.error = '多候选均不匹配，请重新观察页面'
  }
}
```

---

# 第 5 章 感知增强 S3 + S6

## 5.1 S3 AX Tree 并联

> **并联而非替换**。AX Tree 拿不到 iframe 内容，但浏览器引擎计算的 role/name/state 比手搓映射准。

### 可行性

`cdp.ts:88` 已有通用 `send()` 通道，无需改底层：

```typescript
await cdp.send('Accessibility.enable')
const { nodes } = await cdp.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')
```

### 实现 `src/main/axtree.ts`

```typescript
/** 取 AX 树并扁平化为「backendDOMNodeId → 语义描述」映射 */
export async function fetchAxSemantics(cdp: Cdp): Promise<Map<number, string>>
```

只保留 `ignored !== true` 且有 `backendDOMNodeId` 的节点，产出：

```
12345 → role=textbox name=商品名称 required=true
```

### 融合策略（主进程侧）

```typescript
const axMap = settings.axTree !== false
  ? await fetchAxSemantics(t.cdp).catch(() => new Map())
  : new Map()
res.candidates.forEach((c) => {
  const ax = findAxByRect(axMap, c.rect)   // rect 就近匹配，容差 8px
  if (ax) c.extra += ` ax=${ax}`
})
```

### 为什么是并联

| | 自研 extractor | AX Tree |
|---|---|---|
| iframe 内元素 | ✅ 穿透（优势）| ❌ 拿不到 |
| Shadow DOM | 部分 | ✅ |
| 自定义控件 role | 手搓映射，覆盖有限 | ✅ 引擎计算 |
| 中文语义 name | 需自己拼 | ✅ 浏览器算好 |

**不动 extractor 主体，只在 extra 叠加一个信号源。**

## 5.2 S6 本地小模型语义初筛

```typescript
/** 语义初筛：从候选里挑出与任务最相关的 Top-K。本地模型，0 token。 */
async prescreen(candidates: string[], task: string, topK = 12): Promise<number[] | null>
```

调用点：`executor.extract()` 重排之后、`formatForPrompt()` 之前：

```typescript
if (settings.prescreen !== false && fastllm?.isReady() && res.candidates.length > 20) {
  const picked = await fastllm.prescreen(
    res.candidates.map((c) => `${c.role} ${c.text} ${c.extra}`), task, 12
  ).catch(() => null)
  if (picked?.length) res = keepOnly(res, [...picked, ...top3Semantic])
}
```

**收益**：主模型输入从 80 条降到 ~15 条，token 下降约 40%。
**兜底**：强制保留语义分 Top-3，防小模型筛掉目标。

---

# 第 6 章 记忆进化 S5

> 让 AI 自己把踩过的坑记下来。这是"工具"→"助手"的分界。

## 6.1 三类经验

| 类型 | 内容 | 触发时机 |
|---|---|---|
| `field_map` 站点字段映射 | 域名 + 意图词 → 实际字段名 + 元素指纹 | 语义校验通过且非首次 |
| `lesson` 失败教训 | 域名 + 失败现象 → 正确处理方式 | 人工介入后用户给了正确做法 |
| `path` 成功路径 | 域名 + 任务类型 → 节点链摘要 | 任务成功完成 |

## 6.2 数据结构（扩展 `knowledge.ts`）

```typescript
export interface ExperienceEntry {
  id: number
  domain: string                                  // 空=全局
  kind: 'field_map' | 'lesson' | 'path'
  key: string                                     // 匹配键
  value: string                                   // 值
  score: number                                   // 置信度：命中成功++ / 命中失败--
  fingerprint?: string                            // field_map 专用，验证映射是否仍有效
  createdAt: number
  updatedAt: number
  enabled: boolean
}
```

## 6.3 自动写入时机

```typescript
// A. 模型犹豫过但最后对了 —— 宝贵经验
if (sim >= 0.45 && initialIndex !== semanticTop1) {
  experience.upsert({ domain: host, kind: 'field_map',
    key: wantWord, value: actualFieldName, fingerprint: buildFingerprint(el) })
}

// B. 用户纠正后该步成功
if (step.userGuidance && nextStepSuccess) {
  experience.upsert({ domain: host, kind: 'lesson',
    key: lastFailureKind, value: guidance.text.slice(0, 400) })
}

// C. 任务成功完成
experience.upsert({ domain: host, kind: 'path', key: taskType, value: planSummary })
```

## 6.4 注入提示词

复用已有 `kbTips` 通道，`matchKB(url)` → `matchKB(url) + matchExperience(url, taskText)`：

```
# 历史经验（此前任务自动积累，优先级高于你的判断）
- [field_map] 商品名称 → 实际字段「名称」(已验证 3 次)
- [lesson] 该站点填表前需先点击「编辑」按钮才出现输入框
```

## 6.5 置信度与失效

- 命中且任务成功 → `score++`
- 命中但后续失败 → `score--`，`score <= -2` 自动 `enabled = false`
- 页面改版导致指纹失效 → 同上
- 上限 200 条，按 `score` 与 `updatedAt` 淘汰

---

# 第 7 章 度量体系 S0

> **没有度量就没有优化。必须先做，否则后续阶段无法验证收益。**

## 7.1 新建 `src/main/telemetry.ts`

```typescript
export interface TraceEvent {
  ts: number
  taskId: string
  step: number
  type: 'task_start' | 'task_end' | 'extract' | 'llm_call'
      | 'action' | 'verify' | 'failure' | 'human' | 'friction'
  data: Record<string, unknown>
}
```

落盘 `userData/traces/{yyyyMMdd}/{taskId}.jsonl`（一行一事件，追加写）。

## 7.2 接入点（`agent/runner.ts` 主循环）

```typescript
this.telemetry.start(task)

this.telemetry.log('extract', stepN, {
  candidates: extract.candidates.length,
  totalFound: extract.totalFound,
  truncated: extract.totalFound > extract.candidates.length   // 关键指标！
})

this.telemetry.log('action', stepN, { name: a.name, ok: !a.error, error: a.error?.slice(0, 80) })
this.telemetry.log('friction', stepN, frictionResult)          // 第 8 章风控探测
this.telemetry.flush('success')
```

## 7.3 核心指标

| 指标 | 用途 | M1 目标 | M3 目标 |
|---|---|---|---|
| 任务成功率 | 成功 / 总数 | 基线 +15% | 基线 +30% |
| 字段名不一致场景成功率 | 专项测试集 | ≥95% | ≥98% |
| 静默写错率 | 语义校验发现的错填 / 总填入 | 0 | 0 |
| 平均步数 | stepsPerTask | 不增加 | 下降 20% |
| 单任务 token | llmCalls 累计 | 增幅 ≤15% | 下降 20% |
| 人工介入率 | human 事件 / 任务 | 下降 30% | 下降 50% |
| 风控触发率 | friction 事件 / 任务 | 建立基线 | 下降 |
| 二次执行增益 | 同站点同类任务第二次步数降幅 | — | ≥30% |

## 7.4 回归测试集

从 trace 挑 20 个真实任务（成功 10 / 失败 10）固化，每个大版本跑一遍。
`selftest.ts` 已有框架，扩展 `--regress` 参数。

---

# 第 8 章 反风控与拟人化

## 8.0 先纠正一个直觉

> **"加入无意义操作混淆"这个想法，在现代风控下大概率帮倒忙。**

现代风控模型不只看"像不像人"，更看**行为序列有没有目标性**。真人有明确路径：进页面 → 找字段 → 填 → 提交，动作高度连贯。插入随机 hover / 随机滚动会破坏这种连贯性；若噪声插在不该出现的位置（如填表途中突然滚到页脚），比不伪装还可疑。

**正确思路是反过来的：把有意义的操作本身做真。**

| 维度 | 机械特征（当前） | 拟人化做法 |
|---|---|---|
| 输入 | `Input.insertText` 一次性灌入整串 | 按字符间隔逐个敲，中段偶发停顿 |
| 鼠标 | `mousePressed` 直达坐标 | 贝塞尔曲线轨迹，带加速度 |
| 滚动 | 固定步长直线 | 加速-减速-惯性回弹 |
| 节奏 | 固定 sleep 间隔 | 操作间加入"阅读"停顿（与内容长度相关）|

## 8.1 A 层：指纹一致性（低成本高收益）

### A1 UA 修正（最高优先级）

`src/main/index.ts:99`：

```typescript
// 用真实 Chromium 版本构造 UA，保证与浏览器内部版本自洽
const chromeVer = process.versions.chrome            // 例："134.0.6998.35"
const uaMajor = chromeVer.split('.')[0]
const REAL_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${uaMajor}.0.0.0 Safari/537.36`

win.webContents.setUserAgent(REAL_UA)
// 页签的 webContents 同样需要设置（TabManager 创建时）
```

> 关键：**不要硬编码版本号**。用 `process.versions.chrome` 动态生成，
> 保证 UA 与实际渲染引擎版本一致——版本不匹配是比 Electron 标识更明显的破绽。

### A2 `navigator.webdriver` 处理

Electron 默认通常不为 true，但 CDP 附加后部分站点仍会探测。通过 `Page.addScriptToEvaluateOnNewDocument` 在每个页面加载前执行：

```typescript
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  `
})
```

### A3 一致性原则（**比伪装程度更重要**）

| 常见错误 | 后果 |
|---|---|
| UA 改成 Mac，但 `navigator.platform` 仍为 `Win32` | 值间矛盾，比不伪装更可疑 |
| 改了 UA 没改 `sec-ch-ua` 系列请求头 | 同上 |
| 时区/语言与 IP 归属地矛盾 | 高风险信号 |
| 屏幕分辨率与窗口尺寸不自洽 | 中等风险 |

**结论：只做"去掉 Electron 标识"这一件事，其余保持系统真实值。** 过度伪装会制造矛盾，反而暴露。

### A4 明确不做的事

| ❌ 不做 | 原因 |
|---|---|
| Canvas / WebGL / AudioContext 指纹随机化 | 会制造**唯一性**，唯一指纹比常见指纹更可疑 |
| 大规模修改 navigator 属性 | 值间矛盾风险高 |
| 伪造硬件信息（CPU 核数、内存、显卡）| 同上，且收益不明 |

## 8.2 B 层：行为拟真

### B1 打字拟真（改造 `cdp.ts` 的 `insertText`）

```typescript
/**
 * 拟人化键入：按字符间隔逐个输入，偶发思考停顿。
 * 长文本（>50 字）自动降级为整段 insertText（避免过慢）。
 */
async typeHuman(cdp: Cdp, text: string, opts?: { fast?: boolean }): Promise<void> {
  if (opts?.fast || text.length > 50) return cdp.insertText(text)
  for (let i = 0; i < text.length; i++) {
    await cdp.insertText(text[i])
    // 基础间隔 60-140ms，每 8-15 字符一次思考停顿 300-700ms
    const pause = (i > 0 && i % (8 + Math.floor(Math.random() * 8)) === 0)
      ? rand(300, 700)
      : rand(60, 140)
    await sleep(pause)
  }
}
```

> 注意：输入框已聚焦时才能逐字符输入；中文需确认 `Input.insertText` 对单字符的行为正常。

### B2 鼠标轨迹（改造 `mouseClick`）

```typescript
/** 贝塞尔曲线移动：起点 → 控制点（带随机偏移）→ 终点 */
async moveHuman(cdp: Cdp, from: {x:number;y:number}, to: {x:number;y:number}): Promise<void> {
  const steps = 12 + Math.floor(Math.random() * 8)
  const cx = (from.x + to.x) / 2 + rand(-60, 60)
  const cy = (from.y + to.y) / 2 + rand(-60, 60)
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = (1-t)*(1-t)*from.x + 2*(1-t)*t*cx + t*t*to.x
    const y = (1-t)*(1-t)*from.y + 2*(1-t)*t*cy + t*t*to.y
    await cdp.mouseMove(Math.round(x), Math.round(y))
    // 缓动：起步慢、中段快、末端慢
    const ease = Math.sin(Math.PI * t) * 0.6 + 0.4
    await sleep(rand(4, 16) / ease)
  }
}
```

### B3 滚动拟真

滚动带加速-减速-惯性回弹，而非固定步长：

```typescript
/** 拟人滚动：缓入缓出 + 末端轻微回弹 */
async scrollHuman(cdp: Cdp, dy: number): Promise<void> {
  const steps = 10 + Math.floor(Math.random() * 6)
  for (let i = 0; i < steps; i++) {
    const t = (i + 1) / steps
    const eased = 1 - Math.pow(1 - t, 3)          // easeOutCubic
    const delta = Math.round(dy * eased / steps * (1 + rand(-0.2, 0.2)))
    await cdp.mouseWheel(delta)
    await sleep(rand(16, 48))
  }
  await sleep(rand(200, 500))                      // 滚完停顿"看一眼"
}
```

### B4 节奏

- 操作间隔：基础 300-800ms 随机（已有 `humanDelay`，`speed: slow` 时 800-1600ms）
- **阅读停顿**：`read_content` 之后按内容长度追加 400-1500ms（真人读完才动）
- 页面跳转后：600-1200ms settle（已有 `waitSettle`）

### B5 不建议做的"混淆"

| ❌ 做法 | 为什么反效果 |
|---|---|
| 随机 hover 无关元素 | 破坏行为序列连贯性 |
| 填表途中随机滚动 | 位置不合逻辑，比不滚动更可疑 |
| 随机点击空白处 | 高风险信号 |
| 无目的切换页签 | 同上 |

## 8.3 C 层：会话与登录态（**价值最高**）

> **核心论点：对自有账号的业务自动化，保持真实登录态的价值远高于任何指纹伪装。**

### C1 持久化会话

```typescript
// Electron 使用持久化 session，Cookie/ localStorage 跨启动保留
const ses = session.fromPartition('persist:easybow')
```

这样用户首次手动登录后，后续自动化运行都在**已登录状态**下执行——
不需要程序化登录（程序化登录本身就是最强的机器人信号之一）。

### C2 登录态复用（已有能力，强化）

`settings.testLoginReuse` 与 `agent/loginState.ts` 已实现登录态探测与复用。
建议扩展为**所有任务默认启用**（不仅测试模式）：

```typescript
// 任务开始前探测：已登录则跳过登录类步骤
const loginState = await probeLoginState(tab)
if (loginState.loggedIn) skipLoginSteps()
```

### C3 为什么这最有效

风控系统的核心判据通常是：**这个会话是不是一个真实用户的延续**。

| 场景 | 风控判读 |
|---|---|
| 新会话 + 程序化填表登录 + 立即批量操作 | 高度可疑 |
| 已有 30 天历史的会话 + 真人在场登录过 + 正常节奏操作 | 基本放行 |

**结论**：C 层做对了，A/B 层的价值就大幅下降。优先级应高于指纹伪装。

## 8.4 D 层：探测与优雅降级

### D1 扩展已有的摩擦检测

`extractor.ts` 的 `DETECT_FRICTION_FN` 已有基础探测（滑块、验证码、登录提示）。扩展：

```typescript
/** 风控信号分级 */
interface FrictionSignal {
  level: 'none' | 'warn' | 'block'
  kind: 'captcha' | 'slider' | 'sms' | 'login_required' | 'rate_limit' | 'forbidden'
  hint: string
}
```

`level === 'block'` 时：

```typescript
// 不硬闯：暂停 + 交还人工
this.setState({
  state: 'paused',
  statusText: `检测到风控挑战（${kind}），已暂停。请人工处理后点击继续。`
})
this.telemetry.log('friction', stepN, signal)
```

### D2 指数退避

连续触发 `warn` 级信号时逐步放慢：

```typescript
const backoff = Math.min(baseDelay * Math.pow(2, warnCount), 30000)
```

### D3 明确不做硬闯

- ❌ 不自动尝试破解验证码/滑块
- ❌ 不尝试绕过登录墙
- ❌ 不在被限流后高频重试
- ✅ 正确做法：识别 → 暂停 → 提示人工 → 用户处理后继续

这与 `prompts.ts` 现有规则 5 一致（"遇到登录/验证码不要尝试自动破解，输出 wait 等待人工"），是**正确的设计，应保留并强化**。

## 8.5 E 层：架构性限制的诚实说明

**CDP 附加痕迹无法消除。** EasyBow 靠 `debugger.attach('1.3')` 驱动浏览器（`cdp.ts:45`），这一点决定了：

- 追求"完全检测不到"是不现实的目标
- 正确目标是"**不被误判 + 触发风控时能优雅降级**"
- 因此 C 层（真实会话）与 D 层（优雅降级）比 A 层（指纹伪装）更值得投入

---

# 第 9 章 实施路线图

## 9.1 阶段总览

| 阶段 | 名称 | 所属章 | 改动文件 | 工时 |
|---|---|---|---|---|
| **S0** | 度量地基 | 第 7 章 | 新建 `telemetry.ts`，改 `runner.ts` | 2h |
| **S1** | 语义对齐 | 第 3 章 | 新建 `semantic.ts`；改 `extractor.ts` `executor.ts` `runner.ts` | 4h |
| **S2** | 失败归因 | 第 4 章 | 新建 `diagnose.ts`；改 `runner.ts` | 4h |
| **S3** | AX Tree 并联 | 第 5 章 | 新建 `axtree.ts`；改 `cdp.ts` `extractor.ts` | 3h |
| **S4** | 多候选 | 第 4 章 | 改 `prompts.ts` `runner.ts` `types.ts` | 3h |
| **S5** | 经验沉淀 | 第 6 章 | 新建 `experience.ts`；改 `knowledge.ts` `runner.ts` | 4h |
| **S6** | 本地初筛 | 第 5 章 | 改 `fastllm.ts` `executor.ts` | 3h |
| **R1** | UA 与指纹一致性 | 第 8 章 | 改 `index.ts` `cdp.ts` | 1h |
| **R2** | 行为拟真 | 第 8 章 | 改 `cdp.ts` `executor.ts` | 3h |
| **R3** | 会话持久化与风控降级 | 第 8 章 | 改 `index.ts` `loginState.ts` `runner.ts` | 3h |
| | | | **合计** | **约 30h** |

## 9.2 推荐顺序

```
R1（1h，UA 修复，收益/成本比最高，立即做）
  ↓
S0（埋点，零风险，建立基线）
  ↓ 观察 3 天
S1（语义对齐，解决最痛的断链 + 静默错误）
  ↓ 观察 1 周
R3（会话持久化，第 8 章价值最高项）
  ↓
S2（失败归因）
  ↓ 观察 1 周
S5（经验沉淀，形成闭环 B+C）
  ↓ M2 达成
R2 → S4 → S3 → S6（增益项，逐个上）
```

## 9.3 里程碑

| 里程碑 | 包含 | 可观测效果 |
|---|---|---|
| **M0 不暴露** | R1 | UA 不再含 Electron 标识 |
| **M1 不断链** | S0+S1+S2 | 字段名不一致场景成功率 ≥95%，静默写错 = 0 |
| **M2 会自愈** | +S5+R3 | 二次执行步数下降 30%+，风控触发率下降 |
| **M3 更聪明** | +R2+S4+S3+S6 | 复杂任务成功率提升，token 不增反降 |

---

# 第 10 章 风险总表与回滚

## 10.1 全局开关（`shared/types.ts` `Settings`）

```typescript
telemetry?: boolean        // S0
semanticRecall?: boolean   // S1 语义重排
semanticVerify?: boolean   // S1 填后语义校验
boostedExtract?: boolean   // S1 扩展提取
diagnose?: boolean         // S2 失败分类
axTree?: boolean           // S3
multiCandidate?: boolean   // S4
autoExperience?: boolean   // S5
prescreen?: boolean        // S6
humanLike?: boolean        // R2 行为拟真（可关闭回归瞬时操作）
persistSession?: boolean   // R3 持久化会话
```

全部默认 `true`，出问题逐层关闭。

## 10.2 风险总表

| 阶段 | 主要风险 | 影响 | 缓解 | 回滚 |
|---|---|---|---|---|
| S0 | 写盘失败 | 任务中断 | try/catch 静默吞掉 | 关 `telemetry` |
| S1 | 编号漂移 | 动作错位 | 重排在 `snapshots.set` 前；**`resolveIndex` 不传 task** | 关 `semanticRecall` |
| S1 | token 上升 10-15% | 成本 | 受 `maxElements` 约束 | 调回 `extra.slice(0,90)` |
| S1 | 语义校验误报 | 本可成功被判失败 | 阈值 0.45；不清空已填值 | 关 `semanticVerify` |
| S2 | 误分类 | 错误自愈 | 失败返回 null 不介入 | 关 `diagnose` |
| S2 | `page_changed` 误判 | SPA 正常跳转被当异常 | 排除 goto/click 后场景 | 收紧判定 |
| S3 | AX 超时 | 首步变慢 | `send` 已有 20s 超时，失败降级 | 关 `axTree` |
| S4 | 滥用 clarify | 频繁暂停 | 次数上限 3 次 | 关 `multiCandidate` |
| S5 | 错误经验固化 | 持续犯错 | 置信度 + 指纹校验 + UI 可删 | 关 `autoExperience` |
| S6 | 初筛掉目标 | 任务失败 | 强制保留语义 Top-3 | 关 `prescreen` |
| R1 | UA 版本与引擎不符 | 更可疑 | 用 `process.versions.chrome` 动态生成 | 恢复默认 UA |
| R2 | 拟真拖慢速度 | 任务耗时上升 | 长文本自动降级为整段输入 | 关 `humanLike` |
| R3 | 持久化会话串号 | 账号混淆 | 按 partition 隔离 | 关 `persistSession` |

## 10.3 特别注意事项

> ⚠️ **`resolveIndex` 不要传 task**
>
> `executor.ts:261` 在 DOM 变动时会调 `this.extract(t)` 重提取再按 text 定位。
> 若此处传入 task，会导致重排后 `fresh.candidates[index]` 与原 `cand` 对不上。
> **保持原样调用**（不传 task）。

## 10.4 上线节奏

**每阶段独立上线、独立回滚，不捆绑。** 每阶段上线后观察 3 天 - 1 周，
用 S0 的 trace 数据对比前后指标再决定下一步。

---

# 附录 A 失败分类学速查

| 类型 | 典型表现 | 当前是否被识别 | S2 后策略 |
|---|---|---|---|
| `locate` | "元素已失效""不可见""找不到" | ✅ 已识别 | 重提取 → 升级人工 |
| `semantic` | 值填对了但填错字段 | ❌ **静默** | 语义校验 → 换候选 |
| `page_changed` | 出现弹窗 / 意外跳转 | ❌ 靠模型悟 | 重提取 + 告知 |
| `data_missing` | `read_content` 空 / 图片抓不到 | ❌ 靠模型悟 | 换动作重试 |
| `verify_fail` | 复核未通过 | ✅ 已有 | 注入分类标签 |
| `loop` | 同一动作连错 ≥3 | ❌ 无检测 | 升级人工 |
| `exhausted` | 步数耗尽 | ⚠️ 识别但无诊断 | 结构化诊断输出 |
| `friction` | 验证码 / 滑块 / 限流 | ✅ 部分识别 | 暂停 + 人工（不硬闯）|

---

# 附录 B 语义词表扩展指南

## B.1 为什么词表要持续维护

S1 的准确率主要取决于 `SYNONYM_GROUPS` 覆盖度。这是**唯一需要业务知识注入**的部分，
也是长期收益最高的投入。

## B.2 词表构建方法

**方法 1：日志挖掘（推荐）**

在语义校验失败分支埋点：

```typescript
console.log('[semantic-miss]', JSON.stringify({ want, actual, url: extract.url }))
```

积累 50-100 条后按 `want ≈ actual` 分组，每组即一条新的同义词。

**方法 2：从页面反推**

对高频操作的 3-5 个核心页面，各导出一次全量字段名（label/name/id/placeholder），
人工比对哪些是同一业务含义的不同叫法。

## B.3 书写规范

```typescript
// ✅ 好：同组内确实等价或强近义
['商品', '产品', 'sku', '货品', '宝贝', '物品', '商品信息'],

// ❌ 不好：含义有偏差，会导致误召
['商品', '商品详情', '商品列表'],  // "商品详情"是页面不是字段
```

- 组内词**字数差异**最好 ≤3，否则 Dice 失效，靠 `expandSynonyms` 兜底
- 跨行业词单独成组（如 `成本价/采购价/进货价`）
- **不要把单字放进组**（如 `['价','价格']`），单字区分度太低会大面积误召回

## B.4 规模建议

| 阶段 | 组数 | 覆盖 |
|---|---|---|
| 初始 | 16 组（内置）| 通用电商/表单字段 |
| 第一轮补充 | +15 组 | 核心 ERP 业务字段 |
| 持续维护 | 按需 | 每次线上断链后补充 |

---

**文档结束。**

**建议起手**：`R1`（1h，UA 修复）+ `S0`（2h，埋点）+ `S1`（4h，语义对齐），
约 7 小时覆盖"暴露身份""无法度量""断链""静默填错"四个最痛的点，且风险可控。
