import type { PlanNode, PlanNodeCheck } from '@shared/types'

/**
 * 节点链计划器：任务开始时把任务分解为「意图 + 预期」的节点链（链式节点执行）。
 * 计划失败/解析不了不阻塞任务：退化为无节点链执行（与旧行为一致）。
 */

const CHECK_KINDS = [
  'text_visible',
  'url_contains',
  'title_contains',
  'selector_exists',
  'selector_value',
  'selector_text'
] as const

export const PLAN_SYSTEM_PROMPT = `你是浏览器自动化任务的规划器。把用户任务分解为 2~6 个顺序执行的「节点」，每个节点 = 一次可验证的小目标。
只输出纯 JSON，禁止 markdown 代码块、禁止多余文字：
{"nodes":[{"intent":"节点意图（10字内）","expected":"本节点完成时页面/数据应达到的可观察结果（一句话）","check":{...}}]}

关于 check（可选，能用确定性校验表达预期时才给，给不出就省略该字段）：
- {"kind":"text_visible","value":"页面上应出现的文字"}
- {"kind":"url_contains","value":"URL 应包含的片段"}
- {"kind":"title_contains","value":"标题应包含的文字"}
- {"kind":"selector_exists","selector":".css 选择器"}
- {"kind":"selector_value","selector":"input 的选择器","value":"应包含的取值"}
- {"kind":"selector_text","selector":"元素选择器","value":"文本应包含的内容"}
预期是「不应出现」时加 "negate":true。

规则：
1. 节点按执行顺序排列；read/采集与后续填写/提交应分属不同节点
2. expected 必须可观察（页面出现什么/URL 变成什么/表单值是什么），不要写"操作成功"这类无法观察的描述
3. 最后一个节点的 expected 应覆盖任务的最终交付结果
4. 纯查询/单步任务可只给 1 个节点`

export function parsePlan(text: string): PlanNode[] | null {
  let t = text.trim().replace(/```(?:json)?/gi, '')
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
      const c = n?.check
      if (c && typeof c === 'object' && (CHECK_KINDS as readonly string[]).includes(String(c.kind))) {
        const check: PlanNodeCheck = {
          kind: c.kind,
          value: c.value != null ? String(c.value).slice(0, 120) : undefined,
          selector: c.selector != null ? String(c.selector).slice(0, 120) : undefined,
          negate: c.negate === true ? true : undefined
        }
        if (check.value || check.selector || check.kind === 'selector_exists') node.check = check
      }
      nodes.push(node)
    }
    return nodes.length ? nodes : null
  } catch {
    return null
  }
}

/** 节点进度区块（注入每步 user 消息；仅普通任务且存在计划时拼入） */
export function renderPlanBlock(nodes: PlanNode[], current: number): string {
  const parts: string[] = []
  parts.push(
    `# 节点进度（链式执行：当前节点的「预期」达成后，在输出 JSON 里加 "node_done":true，系统会复核预期，复核通过才进入下一节点）`
  )
  nodes.forEach((n, i) => {
    const mark = i + 1 < current ? '✅' : i + 1 === current ? '▶当前' : '○'
    parts.push(`${mark} 节点${i + 1}「${n.intent}」预期: ${n.expected}`)
  })
  if (current <= nodes.length) {
    const n = nodes[current - 1]
    parts.push(`本步只需推进当前节点「${n.intent}」；不要跳到后面的节点。预期未达成时不要输出 node_done。`)
  }
  return parts.join('\n')
}

/** 复核判定的系统提示（L1 本地快速决策 / L2 云端大模型共用） */
export const VERIFY_SYSTEM_PROMPT = `你是浏览器操作结果的复核员。给你一个节点的「预期结果」、操作后的页面状态（含可见文字摘要）、任务记忆与最近动作结果，请判断预期是否已达成。
只输出纯 JSON：{"pass":true} 或 {"pass":false} 或 {"pass":"uncertain"}，可带 "reason":"20字内依据"。
判断要点：
1. 只看可观察证据：页面文字、URL、任务记忆里已保存的数据、动作结果
2. 预期里的字段名与页面/记忆实际叫法可能不同（如"商品名称"vs"宝贝标题"、"主图"vs 大尺寸图片链接）——按语义对应判断，不要求字面一致
3. 抓取/搬运类节点：任务记忆里已存对应数据（如图片链接）即视为达成
4. 预期含糊或证据不足时输出 uncertain，不要猜测`
