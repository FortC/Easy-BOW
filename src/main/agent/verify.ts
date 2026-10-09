import type { PlanNode, Settings } from '@shared/types'
import type { Cdp } from '../cdp'
import type { ExtractResult } from '../extractor'
import type { LlmProvider } from './llm'
import type { FastLlm } from '../fastllm'
import { EXPECT_SEL_FN, EXPECT_TEXT_FN } from '../testcase/assertions'
import { VERIFY_SYSTEM_PROMPT } from './plan'

/**
 * 节点复核器：判断「本节点预期是否已达成」，由便宜到贵逐层判定。
 * L0 确定性信号（页面文字/URL/选择器，0 token）
 * L1 本地快速决策模型（0 token）
 * L2 云端大模型终审（strict 模式 / L1 不确定时）
 */
export interface Verdict {
  passed: boolean
  /** 判定来源 */
  source: 'l0' | 'l1' | 'l2' | 'skip'
  reason: string
}

export async function verifyNode(opts: {
  node: PlanNode
  cdp: Cdp
  extract: ExtractResult
  settings: Pick<Settings, 'verifyMode'>
  provider: LlmProvider | null
  fastllm?: FastLlm
  /** 上一步动作结果摘要（模型复核的证据之一） */
  lastResults: string[]
  /** 任务记忆（save 存的数据是"抓取/搬运类节点"达成的直接证据） */
  memory: Record<string, string>
}): Promise<Verdict> {
  // —— L0：结构化预期的确定性校验 ——
  const c = opts.node.check
  if (c) {
    try {
      const negate = !!c.negate
      if (c.kind === 'url_contains') {
        const hit = (opts.extract.url || '').includes(c.value || '')
        return { passed: hit !== negate, source: 'l0', reason: `URL ${hit ? '包含' : '不包含'} "${c.value}"` }
      }
      if (c.kind === 'title_contains') {
        const hit = (opts.extract.title || '').includes(c.value || '')
        return { passed: hit !== negate, source: 'l0', reason: `标题${hit ? '包含' : '不包含'} "${c.value}"` }
      }
      if (c.kind === 'text_visible') {
        const r = await opts.cdp.evaluate<{ found: boolean; snippet: string }>(EXPECT_TEXT_FN, [c.value || ''])
        return {
          passed: r.found !== negate,
          source: 'l0',
          reason: `页面文字${r.found ? '出现' : '未出现'} "${c.value}"${r.snippet ? `（…${r.snippet.slice(0, 30)}…）` : ''}`
        }
      }
      if (c.kind === 'selector_exists') {
        const r = await opts.cdp.evaluate<{ ok: boolean; count: number }>(EXPECT_SEL_FN, [c.selector || '', 'exists'])
        const hit = (r.count || 0) > 0
        return { passed: hit !== negate, source: 'l0', reason: `${c.selector} ${hit ? `命中 ${r.count} 个` : '不存在'}` }
      }
      if (c.kind === 'selector_value' || c.kind === 'selector_text') {
        const mode = c.kind === 'selector_value' ? 'value' : 'text'
        const r = await opts.cdp.evaluate<{ ok: boolean; count: number; v?: string }>(EXPECT_SEL_FN, [
          c.selector || '',
          mode
        ])
        const hit = String(r.v ?? '').includes(c.value || '')
        return {
          passed: hit !== negate,
          source: 'l0',
          reason: `${c.selector} 的${mode === 'value' ? '取值' : '文本'}="${String(r.v ?? '').slice(0, 40)}"${hit ? '包含' : '不包含'} "${c.value}"`
        }
      }
    } catch {
      // L0 求值异常不判死：降级走模型复核
    }
  }

  // —— 模型复核的证据：页面可见文字（语义化预期按语义匹配页面实际字段）+ 任务记忆 ——
  const mode = opts.settings.verifyMode || 'fast'
  let l1Fail: { pass: boolean | null; reason?: string } | null = null
  let pageText = ''
  try {
    pageText =
      (await opts.cdp.evaluate<string>(PAGE_TEXT_FN, []))?.replace(/\s+/g, ' ').trim().slice(0, 1200) || ''
  } catch {}
  const judgePrompt = buildJudgePrompt(opts.node, opts.extract, opts.lastResults, opts.memory, pageText)

  // —— L1：本地快速决策模型（fast/strict 模式；0 token）——
  // 只把"通过"当定论；"未通过"是弱信号（0.5B 小模型看不到图、易误判），交给 L2 云端确认
  if (opts.fastllm?.isReady()) {
    try {
      const out = await opts.fastllm.decide(VERIFY_SYSTEM_PROMPT, judgePrompt, 24)
      const v = parseJudge(out)
      if (v.pass === true) return { passed: true, source: 'l1', reason: v.reason ? `本地复核通过（${v.reason}）` : '本地复核通过' }
      if (v.pass === false && !opts.provider) {
        return { passed: false, source: 'l1', reason: v.reason ? `本地复核未通过（${v.reason}）` : '本地复核未通过' }
      }
      l1Fail = v
    } catch {}
  }

  // —— L2：云端大模型终审 ——
  // 触发条件：strict 模式 / L1 未通过或不确定（fast 模式下 L1 的"未通过"需 L2 确认，防小模型误判阻塞任务）
  const needL2 = !!opts.provider && (mode === 'strict' || (l1Fail != null && l1Fail.pass !== true))
  if (needL2 && opts.provider) {
    // 云端复核失败先重试一次再降级：接口抖动一次就无条件放行 = 复核形同虚设（复核 P1-12）
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await opts.provider.chat(VERIFY_SYSTEM_PROMPT, [{ role: 'user', content: judgePrompt }])
        const v = parseJudge(out.text)
        if (v.pass === true) return { passed: true, source: 'l2', reason: v.reason ? `大模型复核通过（${v.reason}）` : '大模型复核通过' }
        if (v.pass === false)
          return { passed: false, source: 'l2', reason: v.reason ? `大模型复核未通过（${v.reason}）` : '大模型复核未通过' }
        return { passed: true, source: 'l2', reason: '大模型判为不确定，按通过处理' }
      } catch (e: any) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 800))
          continue
        }
        return { passed: true, source: 'skip', reason: `复核调用失败按通过处理: ${String(e?.message || e).slice(0, 60)}` }
      }
    }
  }

  // fast 模式且 L1 无法判定（本地模型不可用/输出不可解析）→ 不阻塞任务（宁可放行也不空转）
  if (l1Fail?.pass === false) return { passed: false, source: 'l1', reason: l1Fail.reason || '本地复核未通过' }
  return { passed: true, source: 'skip', reason: '无法自动判定，按通过处理' }
}

/** 页面可见文字摘要（复核证据：语义化字段按语义匹配页面实际叫法） */
const PAGE_TEXT_FN = String(function pageText() {
  return document.body ? document.body.innerText : ''
})

function buildJudgePrompt(
  node: PlanNode,
  extract: ExtractResult,
  lastResults: string[],
  memory: Record<string, string>,
  pageText: string
): string {
  const parts: string[] = []
  parts.push(`# 节点预期\n${node.expected}`)
  parts.push(`# 操作后页面状态\n标题: ${extract.title?.slice(0, 60) || ''}\nURL: ${(extract.url || '').slice(0, 100)}`)
  if (pageText) parts.push(`# 页面可见文字（摘要）\n${pageText}`)
  const memKeys = Object.entries(memory || {})
  if (memKeys.length) {
    parts.push(
      `# 任务记忆（本节点已保存的数据，抓取/搬运类节点达成的直接证据）\n` +
        memKeys.slice(0, 12).map(([k, v]) => `${k}=${v.length > 160 ? v.slice(0, 160) + `…(共${v.length}字)` : v}`).join('\n')
    )
  }
  if (lastResults.length) parts.push(`# 最近动作结果\n${lastResults.map((s) => s.slice(0, 400)).join('\n').slice(0, 1200)}`)
  parts.push(`# 判断\n预期是否已达成？（预期里的字段名与页面/记忆实际叫法可能不同，按语义对应判断）只输出 JSON：{"pass":true|false|"uncertain","reason":"20字内依据"}`)
  return parts.join('\n\n')
}

/** 解析复核模型输出：pass=true/false/uncertain + 可选 reason */
function parseJudge(text: string | null): { pass: boolean | null; reason?: string } {
  if (!text) return { pass: null }
  const t = text.replace(/```(?:json)?/gi, '')
  const m = /"pass"\s*:\s*(true|false|"uncertain")/i.exec(t)
  if (!m) return { pass: null }
  const v = m[1].toLowerCase()
  const rm = /"reason"\s*:\s*"([^"]{0,60})"/i.exec(t)
  const reason = rm ? rm[1] : undefined
  if (v === 'true') return { pass: true, reason }
  if (v === 'false') return { pass: false, reason }
  return { pass: null, reason }
}
