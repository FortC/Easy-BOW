import OpenAI from 'openai'
import type { Settings } from '@shared/types'

/** W3 结构化输出支持档位：json_schema > json_object > none（none=纯文本，与旧版行为一致） */
export type StructuredSupport = 'json_schema' | 'json_object' | 'none'

/**
 * 宽松 step 输出 schema：顶层 {thought, actions, node_done}，actions 元素为开放对象。
 * 仅作格式引导、不 strict、绝不用 oneOf（部分中转不认 oneOf 会直接报错）；所有字段可空。
 */
export const STEP_SCHEMA = {
  type: 'object',
  properties: {
    thought: { type: ['string', 'null'] },
    actions: {
      type: ['array', 'null'],
      items: { type: 'object', additionalProperties: true }
    },
    node_done: { type: ['boolean', 'null'] }
  },
  additionalProperties: true
}

/** OpenAI response_format 构造；'none' 返回 undefined（请求体不带该字段，与纯文本逐字节一致） */
export function responseFormatFor(mode: StructuredSupport): any {
  if (mode === 'json_schema')
    return { type: 'json_schema', json_schema: { name: 'step_output', schema: STEP_SCHEMA } }
  if (mode === 'json_object') return { type: 'json_object' }
  return undefined
}

const PROBE_TIMEOUT_MS = 30000

// 结构化能力缓存（会话内粘滞）：key = `${baseURL}|${model}`
const supportCache = new Map<string, StructuredSupport>()
// Anthropic tool_use 可用性（兼容性报错后置 false，后续不再带 tools）
const toolUseCache = new Map<string, boolean>()
// 并发探测去重：同一 baseURL|model 只发一次预检
const inflight = new Map<string, Promise<StructuredSupport>>()

function keyOf(s: Settings): string {
  return `${s.baseURL || ''}|${s.model || ''}`
}

/**
 * 1-token 预检探测结构化支持档位（绝不拿真实任务请求探测）：
 * 先试宽松 json_schema，失败降级 json_object，再失败 = none。结果按 baseURL|model 缓存，命中即返回不发请求。
 */
export async function probeStructuredSupport(settings: Settings): Promise<StructuredSupport> {
  const key = keyOf(settings)
  const cached = supportCache.get(key)
  if (cached) return cached
  const running = inflight.get(key)
  if (running) return running
  const p = (async (): Promise<StructuredSupport> => {
    const client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || undefined,
      timeout: PROBE_TIMEOUT_MS,
      maxRetries: 0
    })
    const probe = async (fmt: any): Promise<boolean> => {
      try {
        const req: any = {
          model: settings.model,
          // 极短 prompt；json_object 档位要求消息里出现 "json"，故用 'reply json'
          messages: [{ role: 'user', content: 'reply json' }],
          max_tokens: 1
        }
        if (fmt) req.response_format = fmt
        await client.chat.completions.create(req)
        return true
      } catch {
        return false
      }
    }
    let result: StructuredSupport = 'none'
    if (await probe(responseFormatFor('json_schema'))) result = 'json_schema'
    else if (await probe(responseFormatFor('json_object'))) result = 'json_object'
    console.log(`[llm] structured probe ${key} → ${result}`)
    supportCache.set(key, result)
    return result
  })()
  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
  }
}

/** 清空结构化缓存（自测用）：下次探测重新发起 */
export function clearStructuredCache(): void {
  supportCache.clear()
  toolUseCache.clear()
  inflight.clear()
}

/** 运行时降级一档（json_schema→json_object→none），返回降级后的档位 */
export function downgradeStructured(settings: Settings): StructuredSupport {
  const key = keyOf(settings)
  const cur = supportCache.get(key) ?? 'json_schema'
  const next: StructuredSupport = cur === 'json_schema' ? 'json_object' : 'none'
  supportCache.set(key, next)
  return next
}

/** 直接置 none（结构化重试仍失败后，本会话不再尝试结构化） */
export function forceStructuredNone(settings: Settings): void {
  supportCache.set(keyOf(settings), 'none')
}

/** Anthropic tool_use 是否可用（默认可用；兼容性报错后置为不可用） */
export function isToolUseAvailable(settings: Settings): boolean {
  return toolUseCache.get(keyOf(settings)) ?? true
}

/** 标记该 baseURL|model 的 tool_use 不可用，后续请求不再带 tools */
export function markToolUseUnavailable(settings: Settings): void {
  toolUseCache.set(keyOf(settings), false)
}

const BAD_PHRASE =
  /(not[_ ]?support|unsupport|not[_ ]?allow|unknown|unrecogni|invalid|unexpected|illegal|bad[_ ]?request|error|failed|不支持|无法识别|未知|不识别|不接受|参数|非法)/i

function errStatus(e: any): number {
  return typeof e?.status === 'number'
    ? e.status
    : typeof e?.response?.status === 'number'
      ? e.response.status
      : NaN
}

/** 判定 response_format 不支持/参数错误（OpenAI 结构化运行时降级的触发条件） */
export function isResponseFormatError(e: any): boolean {
  if (!e) return false
  const msg = String(e?.message || e || '')
  const mentionsFmt = /response_format|json_schema|json_object/i.test(msg)
  return mentionsFmt && (BAD_PHRASE.test(msg) || [400, 404, 415, 422].includes(errStatus(e)))
}

/** 判定 tool_use/中转兼容性错误（Anthropic 结构化降回纯文本的触发条件） */
export function isToolUseCompatError(e: any): boolean {
  if (!e) return false
  const msg = String(e?.message || e || '')
  const mentionsTool = /\btools?\b|tool_choice|tool_use/i.test(msg)
  return mentionsTool && (BAD_PHRASE.test(msg) || [400, 404, 415, 422].includes(errStatus(e)))
}
