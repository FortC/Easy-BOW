import type { PlanNode, PlanNodeCheck, PlanNodeTarget } from '@shared/types'
import { normalizeText, stripEllipsis, textMatch } from '../textmatch'

/**
 * 节点链计划器：任务开始时把任务分解为「意图 + 预期」的节点链（链式节点执行）。
 * 计划失败/解析不了不阻塞任务：退化为无节点链执行（与旧行为一致）。
 *
 * v4.5 关键改动：**接地规划**。规划不再只看任务文本——规划前先把当前页面的真实元素
 * 摘要喂进来（buildPlan 由 runner 在首次 extract 之后调用），并由 PlanValidator 做
 * 四类确定性校验。历史问题是节点链在第一次提取页面之前就生成，模型写 expected 靠的是
 * 先验知识而非观察，导致 expected 与页面实际叫法脱节、复核必然 uncertain。
 */

const CHECK_KINDS = [
  'text_visible',
  'url_contains',
  'title_contains',
  'selector_exists',
  'selector_value',
  'selector_text'
] as const

const TARGET_KINDS = ['field', 'button', 'link', 'text', 'row_action', 'tab'] as const

export const PLAN_SYSTEM_PROMPT = `你是浏览器自动化任务的规划器。把用户任务分解为 2~6 个顺序执行的「节点」，每个节点 = 一次可验证的小目标。
只输出纯 JSON，禁止 markdown 代码块、禁止多余文字：
{"nodes":[{"intent":"节点意图（10字内）","expected":"本节点完成时页面/数据应达到的可观察结果（一句话）","target":{...},"check":{...},"risk":"read|write","precheck":{...}}]}

# target（接地锚）：本节点要操作的对象。**必须基于下方页面元素清单里真实存在的元素**填写，不要凭空想象字段名。
{"kind":"field|button|link|text|row_action|tab","label":"元素文案或字段名","near":"邻近定位词（可选）"}

# check（确定性校验）：**每个节点都必须给**，没有 check 的节点无法被自动复核、只能靠大模型猜。
- {"kind":"text_visible","value":"页面上应出现的文字"}
- {"kind":"url_contains","value":"URL 应包含的片段"}
- {"kind":"title_contains","value":"标题应包含的文字"}
- {"kind":"selector_exists","selector":".css 选择器"}
- {"kind":"selector_value","selector":"input 的选择器","value":"应包含的取值"}
- {"kind":"selector_text","selector":"元素选择器","value":"文本应包含的内容"}
预期是「不应出现」时加 "negate":true。

# risk：提交/保存/删除/支付/下单/审批/修改/填写 等会改变数据的节点填 "write"，其余填 "read"。

# precheck（进入本节点的前置门，可选）：比如「必须先已登录」「必须先出现结果列表」。

规则：
1. 节点按执行顺序排列；read/采集与后续填写/提交应分属不同节点
2. expected 必须可观察（页面出现什么/URL 变成什么/表单值是什么），不要写"操作成功"这类无法观察的描述
3. check.value 与 target.label 必须是页面上真实存在的文字（会被自动核验，写错会被打回重排）
4. 最后一个节点的 expected 应覆盖任务的最终交付结果
5. 页面元素清单里没有的对象，说明该页面还没到那一步——把该节点放到合适的更后面位置，或用 precheck 标注前置条件
6. 纯查询/单步任务可只给 1 个节点`

/** 把 check 对象收敛为合法 PlanNodeCheck（非法 kind 返回 undefined） */
function parseCheck(c: any): PlanNodeCheck | undefined {
  if (!c || typeof c !== 'object') return undefined
  if (!(CHECK_KINDS as readonly string[]).includes(String(c.kind))) return undefined
  const check: PlanNodeCheck = {
    kind: c.kind as PlanNodeCheck['kind'],
    value: c.value != null ? String(c.value).slice(0, 120) : undefined,
    selector: c.selector != null ? String(c.selector).slice(0, 120) : undefined,
    negate: c.negate === true ? true : undefined
  }
  if (check.value || check.selector || check.kind === 'selector_exists') return check
  return undefined
}

/** 把 target 对象收敛为合法 PlanNodeTarget */
function parseTarget(c: any): PlanNodeTarget | undefined {
  if (!c || typeof c !== 'object') return undefined
  const label = String(c.label || '').trim().slice(0, 60)
  if (!label) return undefined
  const kind = (TARGET_KINDS as readonly string[]).includes(String(c.kind)) ? c.kind : 'text'
  return { kind: kind as PlanNodeTarget['kind'], label, near: c.near != null ? String(c.near).slice(0, 40) : undefined }
}

/** 写操作节点判定（与 executor 的 SUBMITISH_RE 同源，避免两处口径不一致） */
const WRITE_NODE_RE = /提交|保存|删除|支付|下单|结算|发布|审批|审核|修改|更新|写入|填写|新增|编辑|submit|save|delete|pay/i

export function parsePlan(text: string): PlanNode[] | null {
  // 推理模型常把 <think>…</think> 思考写进 content：先剥完整思考块，
  // 再截掉未闭合的 <think> 尾巴（输出被截断只剩思考开头时其后没有 JSON，思考文本里的 { 会破坏切片范围）
  let t = text
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
  const unclosed = t.search(/<think[^>]*>/i)
  if (unclosed !== -1) t = t.slice(0, unclosed)
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const obj = JSON.parse(t.slice(start, end + 1))
    const raw = Array.isArray(obj?.nodes) ? obj.nodes : Array.isArray(obj) ? obj : null
    if (!raw) return null
    const nodes: PlanNode[] = []
    for (const n of raw.slice(0, 8)) {
      const intent = String(n?.intent || '').trim().slice(0, 40)
      const expected = String(n?.expected || '').trim().slice(0, 120)
      if (!intent && !expected) continue
      const node: PlanNode = { intent: intent || `节点${nodes.length + 1}`, expected }
      const check = parseCheck(n?.check)
      if (check) node.check = check
      const target = parseTarget(n?.target)
      if (target) node.target = target
      // risk 缺省时按文案判定（写操作节点漏标会失去 L2 强制复核，代价是错误提交）
      const risk = n?.risk === 'write' || n?.risk === 'read' ? n.risk : WRITE_NODE_RE.test(`${intent} ${expected}`) ? 'write' : 'read'
      node.risk = risk
      const pre = parseCheck(n?.precheck)
      if (pre) node.precheck = pre
      nodes.push(node)
    }
    return nodes.length ? nodes : null
  } catch {
    return null
  }
}

/* ———————————————— 页面摘要（接地规划输入） ———————————————— */

/** 页面元素摘要：喂给规划器，让它基于真实元素而不是先验知识写节点 */
export interface PlanPageSnapshot {
  title: string
  url: string
  /** 候选元素行（已按可交互性/视口/语义排序，取前 N） */
  lines: string[]
  /** 表单字段清单（label/placeholder/name） */
  fields: string[]
  /** 同名重复出现的元素（密集页歧义提示） */
  duplicates: string[]
}

/** 从提取结果构造页面摘要（纯函数，可单测） */
export function buildPlanSnapshot(res: {
  title: string
  url: string
  candidates: Array<{ role: string; text: string; extra?: string; anchor?: string; inViewport?: boolean }>
}): PlanPageSnapshot {
  const fields: string[] = []
  const lines: string[] = []
  const byText = new Map<string, number>()
  for (const c of res.candidates) {
    if (/input|select|可编辑|textarea|复选框|单选框/.test(c.role)) {
      const bits = [c.text, c.extra].filter(Boolean).join(' ').slice(0, 60)
      if (bits) fields.push(bits)
    }
    const line = [`<${c.role}>`, c.text ? `"${c.text}"` : '', c.anchor ? `(行:${c.anchor})` : '', c.extra ? `(${c.extra})` : '']
      .filter(Boolean)
      .join(' ')
      .slice(0, 100)
    if (line.replace(/<[^>]*>/g, '').trim()) lines.push(line)
    if (c.text) byText.set(c.text, (byText.get(c.text) || 0) + 1)
  }
  const duplicates = [...byText.entries()]
    .filter(([, n]) => n >= 2)
    .map(([txt, n]) => `"${txt.slice(0, 16)}"×${n}`)
    .slice(0, 8)
  return {
    title: (res.title || '').slice(0, 80),
    url: (res.url || '').slice(0, 120),
    lines: lines.slice(0, 40),
    fields: fields.slice(0, 20),
    duplicates
  }
}

/** 规划器的 user 消息：任务 + 当前页面真实状态（v4.5 接地规划的核心改动） */
export function buildPlanPrompt(task: string, snap?: PlanPageSnapshot): string {
  const parts: string[] = []
  parts.push(`# 任务\n${task.slice(0, 2000)}`)
  if (!snap) {
    parts.push(`# 当前页面\n（尚未获取页面快照，请基于任务领域常识规划；target/check 尽量给出，但不要编造页面上不存在的具体字段名）`)
    return parts.join('\n\n')
  }
  parts.push(`# 当前页面真实状态（规划必须基于它，不要凭空想象字段名或按钮）\n标题: ${snap.title}\nURL: ${snap.url}`)
  if (snap.fields.length) {
    parts.push(`## 页面上的表单字段（target.kind=field 时从这里选）\n${snap.fields.map((f, i) => `${i + 1}. ${f}`).join('\n')}`)
  }
  if (snap.lines.length) {
    parts.push(`## 页面上的可交互元素\n${snap.lines.map((l, i) => `[${i + 1}] ${l}`).join('\n')}`)
  }
  if (snap.duplicates.length) {
    parts.push(`## 同名重复元素（该文案在页面上多处出现，规划涉及它们时必须用 target.label+行标识区分）\n${snap.duplicates.join('  ')}`)
  }
  return parts.join('\n\n')
}

/** 节点进度区块（注入每步 user 消息；仅普通任务且存在计划时拼入） */
export function renderPlanBlock(nodes: PlanNode[], current: number): string {
  const parts: string[] = []
  parts.push(
    `# 节点进度（链式执行：当前节点的「预期」达成后，在输出 JSON 里加 "node_done":true 并附 "node_evidence":"你观察到的页面变化（50字内）"，系统会复核预期，复核通过才进入下一节点）`
  )
  nodes.forEach((n, i) => {
    const mark = i + 1 < current ? '✅' : i + 1 === current ? '▶当前' : '○'
    const risk = n.risk === 'write' ? ' ⚠写操作' : ''
    parts.push(`${mark} 节点${i + 1}「${n.intent}」预期: ${n.expected}${risk}`)
  })
  if (current <= nodes.length) {
    const n = nodes[current - 1]
    parts.push(`本步只需推进当前节点「${n.intent}」；不要跳到后面的节点。预期未达成时不要输出 node_done。`)
  }
  return parts.join('\n\n')
}

/* ———————————————— PlanValidator：规划后的确定性校验 ———————————————— */

export interface PlanIssue {
  /** 问题码 */
  code: 'no_check' | 'hallucinated_value' | 'missing_entity' | 'unreachable_target'
  nodeIndex: number
  message: string
  /** 是否可由规划器自行修复（否则只提示不阻断） */
  fixable: boolean
}

export interface PlanValidation {
  ok: boolean
  issues: PlanIssue[]
  /** 无 check 的节点下标（weak 节点：复核只能走 L2 且不确定不放行） */
  weakNodes: number[]
}

export interface ValidatePlanInput {
  nodes: PlanNode[]
  /** 当前页面快照（接地校验用；缺省时跳过 C2/C4 的页面侧判定） */
  snap?: PlanPageSnapshot
  task: string
}

/** 任务里的业务数据值（单号/商品名/数量/金额等）——C3 实体覆盖校验用 */
function taskEntities(task: string): string[] {
  const out = new Set<string>()
  // 订单号/单号类：字母数字混排且含数字，长度 6+
  for (const m of task.matchAll(/\b[A-Za-z]{1,6}[-]?\d{4,}[A-Za-z0-9-]*/g)) if (m[0].length >= 6) out.add(m[0])
  // 引号内的字面值
  for (const m of task.matchAll(/[「『"“]([^」』"”\n]{2,24})[」』"”]/g)) out.add(m[1].trim())
  return [...out].filter(Boolean).slice(0, 8)
}

/**
 * 规划校验器（纯函数、0 token、确定性）。
 *
 * C1 每个节点必须有 check —— 模型此前可以不给，导致该节点没有 L0 快速通道，
 *      只能靠大模型语义判，"复核"退化成"再看一眼"。
 * C2 check.value 幻觉检测 —— check 的取值在「页面文本 + 任务文本」里都找不到，
 *      说明规划器编了一个页面上不存在的词。这种节点 100% 复核失败，
 *      必须在规划阶段就打回，而不是执行到那一步再重规划。
 * C3 任务实体覆盖 —— 任务里点名的数据（单号/商品名/数量）没有被任何节点预期或 check 覆盖，
 *      说明漏了步骤。
 * C4 target 可达性 —— target.label 在当前页面元素/字段里找不到（语义得分 0），
 *      说明规划器在规划一个当前页面还没有的东西。
 *
 * 阈值刻意保守：任一项命中只要求规划器**修复一次**，仍不合格则降级为无节点链执行，
 * 不阻塞任务——校验器的目的是提升计划质量，不是制造新的失败模式。
 */
export function validatePlan(input: ValidatePlanInput): PlanValidation {
  const { nodes, snap, task } = input
  const issues: PlanIssue[] = []
  const weakNodes: number[] = []
  const pageBlob = snap ? [snap.title, snap.url, ...snap.fields, ...snap.lines].join('\n') : ''
  const taskBlob = task || ''
  const haystack = normalizeText(`${pageBlob}\n${taskBlob}`)
  // C4 用的可达词表：页面元素文案 + 字段线索，按文本段切分
  const reachWords = new Set<string>()
  if (snap) {
    for (const f of snap.fields) for (const w of normalizeText(f).split(/[\s()（）=:：,，、|]/)) if (w.length >= 2) reachWords.add(w)
    for (const l of snap.lines) for (const w of normalizeText(l.replace(/<[^>]*>/g, '')).split(/[\s()（）=:：,，、|]/)) if (w.length >= 2) reachWords.add(w)
  }
  const entities = taskEntities(task)

  nodes.forEach((n, i) => {
    // C1 check 必填
    if (!n.check) {
      weakNodes.push(i)
      issues.push({
        code: 'no_check',
        nodeIndex: i,
        message: `节点${i + 1}「${n.intent}」没有 check：该节点无法做确定性复核，只能靠大模型语义判断，误判风险高。请补一个 check（text_visible/url_contains/selector_* 任一）。`,
        fixable: true
      })
    } else if (n.check.value) {
      // C2 幻觉值检测：取值的有效片段在页面+任务里都找不到 → 臆造
      const v = normalizeText(n.check.value)
      // 中文长句按 2-4 字滑窗找任一片段命中即可（整句常常是自然语言描述，不宜要求字面全等）
      let hit = false
      if (v.length <= 4) hit = haystack.includes(v)
      else {
        for (let k = 0; k + 3 <= Math.min(v.length, 20); k += 1) {
          if (v.slice(k, k + 3) && haystack.includes(v.slice(k, k + 3))) {
            hit = true
            break
          }
        }
        // 中文按标点/空格切段再判（滑窗对英文更合适）
        if (!hit) {
          for (const seg of v.split(/[\s,，。、;；:：]+/).filter((s) => s.length >= 2)) {
            if (haystack.includes(seg)) {
              hit = true
              break
            }
          }
        }
      }
      if (!hit && v.length >= 2) {
        issues.push({
          code: 'hallucinated_value',
          nodeIndex: i,
          message: `节点${i + 1}「${n.intent}」的 check 取值 "${n.check.value}" 在当前页面和任务描述里都找不到，疑似臆造。请改用页面上真实存在的文字。`,
          fixable: true
        })
      }
    }
    // C4 target 可达性
    if (n.target && snap && reachWords.size) {
      const label = stripEllipsis(normalizeText(n.target.label))
      const near = stripEllipsis(normalizeText(n.target.near || ''))
      const reachable =
        [...reachWords].some((w) => textMatch(label, w).ok || textMatch(w, label).ok) ||
        (!!near && [...reachWords].some((w) => textMatch(near, w).ok || textMatch(w, near).ok))
      if (!reachable) {
        issues.push({
          code: 'unreachable_target',
          nodeIndex: i,
          message: `节点${i + 1}「${n.intent}」的目标 "${n.target.label}" 在当前页面上找不到。若它要到后续页面才出现，请加 precheck 标注前置条件，或把该节点放在更后面。`,
          fixable: true
        })
      }
    }
  })

  // C3 任务实体覆盖
  for (const ent of entities) {
    const norm = normalizeText(ent)
    if (norm.length < 3) continue
    const covered = nodes.some((n) => {
      const blob = normalizeText(`${n.intent} ${n.expected} ${n.check?.value || ''}`)
      return blob.includes(norm) || textMatch(norm, blob).ok
    })
    if (!covered) {
      issues.push({
        code: 'missing_entity',
        nodeIndex: -1,
        message: `任务里提到的关键数据 "${ent}" 在任何节点的预期/check 里都没出现，可能漏了处理它的步骤。`,
        fixable: true
      })
    }
  }

  return { ok: issues.length === 0, issues, weakNodes }
}

/** 校验问题回灌规划器的修复提示 */
export function renderPlanIssues(issues: PlanIssue[]): string {
  return (
    `# 上一次规划被系统校验打回（这些是确定性问题，不是主观意见）\n` +
    issues
      .slice(0, 8)
      .map((it, i) => `${i + 1}. ${it.message}`)
      .join('\n') +
    `\n请按上述问题重新输出完整的节点 JSON（不要只输出被质疑的那个节点）。`
  )
}

/** 复核判定的系统提示（L1 本地快速决策 / L2 云端大模型共用） */
export const VERIFY_SYSTEM_PROMPT = `你是浏览器操作结果的复核员。给你一个节点的「预期结果」、操作后的页面状态（含变更摘要与目标区域文字）、任务记忆与最近动作结果，请判断预期是否已达成。
只输出纯 JSON：{"pass":true} 或 {"pass":false} 或 {"pass":"uncertain"}，可带 "reason":"20字内依据"。
判断要点：
1. 只看可观察证据：变更摘要、目标区域文字、任务记忆里已保存的数据、动作结果
2. 预期里的字段名与页面/记忆实际叫法可能不同（如"商品名称"vs"宝贝标题"、"主图"vs 大尺寸图片链接）——按语义对应判断，不要求字面一致
3. 页面上被截断显示的文案（带省略号）就是完整文案的一部分，据此判断时不要因为"文字对不上"就判失败
4. 抓取/搬运类节点：任务记忆里已存对应数据（如图片链接）即视为达成
5. 预期含糊或证据不足时输出 uncertain，不要猜测`

/**
 * T9 动态重规划（W8，P0-5）：系统提示与 PLAN_SYSTEM_PROMPT 分离（后者逐字节稳定）。
 * 输出格式与 parsePlan 兼容；上下文继承由 buildReplanPrompt 拼装。
 */
export const REPLAN_SYSTEM_PROMPT = `你是浏览器自动化任务的重规划器。原计划在执行中受阻，需要基于「当前页面真实状态」重排剩余工作。
只输出纯 JSON，格式与原计划相同：
{"nodes":[{"intent":"节点意图（10字内）","expected":"可观察的完成标准（一句话）","target":{...},"check":{...可省略},"risk":"read|write"}]}

硬规则：
1. 以当前页面真实状态为准：已失效的已完成步骤必须重做——把需要重做的节点按执行顺序插回计划（可放在队首），
   不要假设「之前做过就一定还在」（登录态可能被踢、表单可能被清、页面可能被人工改动）
2. 上下文里的「已失败方式」是踩过的坑：新计划必须换思路，禁止安排同样的做法
3. 已确认仍然有效的已完成节点不要重复安排
4. 2~6 个节点；最后一个节点的 expected 覆盖任务最终交付结果
5. expected 必须可观察；**每个节点都要给 check**（能用确定性校验表达时），target 必须基于上下文里给出的真实页面元素
6. 下文「可沿用的锚」是上一版计划里已经生效的 target/check：重做这些节点时优先沿用，不要凭空重写`

/** T9 重规划上下文拼装（上下文继承，P0-5：防新计划重蹈覆辙） */
export function buildReplanPrompt(ctx: {
  task: string
  doneNodes: Array<{ intent: string; expected: string }>
  curNode?: { intent: string; expected: string; failReason: string }
  triedList: string[]
  snapshotSummary: string
  /** v4.5：上一版计划里已生效的 target/check，新计划沿用（防重规划时把接地锚弄丢） */
  anchors?: Array<{ intent: string; target?: PlanNodeTarget; check?: PlanNodeCheck }>
  /** v4.5：当前页面真实元素摘要（接地重规划） */
  pageSnapshot?: PlanPageSnapshot
  /** v4.6 B1：最近一次动作后的页面变化摘要（W10 delta）——让重规划器知道「刚才那下页面有什么反应」，
   *  而不是只知道「失败了」，避免新计划重蹈覆辙 */
  delta?: string
}): string {
  const parts: string[] = []
  parts.push(`# 原任务\n${ctx.task.slice(0, 1500)}`)
  if (ctx.pageSnapshot) {
    const s = ctx.pageSnapshot
    parts.push(
      `# 当前页面真实状态（target 必须基于它，不要凭空想象字段名）\n标题: ${s.title}\nURL: ${s.url}` +
        (s.fields.length ? `\n## 表单字段\n${s.fields.slice(0, 20).map((f, i) => `${i + 1}. ${f}`).join('\n')}` : '') +
        (s.lines.length ? `\n## 可交互元素\n${s.lines.slice(0, 40).map((l, i) => `[${i + 1}] ${l}`).join('\n')}` : '')
    )
  }
  if (ctx.doneNodes.length) {
    parts.push(
      `# 已完成节点（注意：以当前页面真实状态为准，已失效的必须重做，插回新计划）\n` +
        ctx.doneNodes.map((n, i) => `${i + 1}. 「${n.intent}」预期: ${n.expected}`).join('\n')
    )
  }
  if (ctx.curNode) {
    parts.push(
      `# 当前失败节点\n「${ctx.curNode.intent}」预期: ${ctx.curNode.expected}\n失败归因: ${ctx.curNode.failReason}`
    )
  }
  if (ctx.triedList.length) {
    parts.push(`# 已失败方式（禁止重复这些做法，必须换思路）\n${ctx.triedList.slice(0, 10).join('\n')}`)
  }
  if (ctx.anchors?.length) {
    parts.push(
      `# 可沿用的锚（上一版计划里已生效的目标与断言，重做相关节点时优先沿用）\n` +
        ctx.anchors
          .slice(0, 6)
          .map(
            (a) =>
              `- 「${a.intent}」target=${a.target ? `${a.target.kind}:${a.target.label}` : '无'} check=${a.check ? `${a.check.kind}:${a.check.value || a.check.selector || ''}` : '无'}`
          )
          .join('\n')
    )
  }
  // v4.6 B1：失败现场的动作后核验摘要（页面到底有没有反应、哪里变了）
  if (ctx.delta) {
    parts.push(`# 最近一次操作后的页面变化\n${ctx.delta.slice(0, 400)}`)
  }
  parts.push(`# 当前快照摘要\n${ctx.snapshotSummary.slice(0, 800)}`)
  parts.push(`# 输出\n按硬规则输出重排后的节点 JSON：`)
  return parts.join('\n\n')
}
