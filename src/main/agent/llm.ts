import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import type { Settings } from '@shared/types'

/** 消息内容块：文本 或 图片（dataURL），用于用户截图指路等多模态输入 */
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentPart[]
}

export interface LlmResult {
  text: string
  usage: { inputTokens: number; outputTokens: number }
}

export interface LlmProvider {
  chat(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult>
}

const TIMEOUT_MS = 90000

/** 1x1 PNG 测试图（llm:test 探测模型是否接受图片输入用） */
export const TINY_TEST_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** ContentPart[] → OpenAI content 格式（文本 + image_url dataURL）；导出供自测 */
export function toOpenAiContent(content: string | ContentPart[]): string | any[] {
  if (typeof content === 'string') return content
  return content.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: p.dataUrl } }
  )
}

/** OpenAI 兼容协议（OpenAI/DeepSeek/GLM/Kimi/OpenRouter/Ollama 等自定义 baseURL） */
export class OpenAIProvider implements LlmProvider {
  private client: OpenAI
  private model: string

  constructor(settings: Settings) {
    this.client = new OpenAI({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || undefined,
      timeout: TIMEOUT_MS,
      // 不让 SDK 静默重试：超时/网络错误直接抛给 Agent 循环，
      // 由模型在下一步看到错误自行决定重试（否则挂死请求会拖 2 倍超时时长）
      maxRetries: 0
    })
    this.model = settings.model
  }

  async chat(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult> {
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: 'system', content: system },
          ...messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content) }))
        ],
        temperature: 0.2,
        max_tokens: 2048
      },
      { signal }
    )
    const text = res.choices?.[0]?.message?.content || ''
    return {
      text: typeof text === 'string' ? text : JSON.stringify(text),
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0
      }
    }
  }
}

/** ContentPart[] → Anthropic content 格式（文本 + base64 image block）；导出供自测 */
export function toAnthropicContent(content: string | ContentPart[]): string | any[] {
  if (typeof content === 'string') return content
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    // dataUrl 形如 data:image/jpeg;base64,xxxx
    const m = /^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i.exec(p.dataUrl)
    if (!m) return { type: 'text', text: '(不支持的图片格式，已忽略)' }
    const mediaType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase()
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } }
  })
}

/** Anthropic 兼容协议（Anthropic 官方或兼容中转） */
export class AnthropicProvider implements LlmProvider {
  private client: Anthropic
  private model: string

  constructor(settings: Settings) {
    this.client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseURL || undefined,
      timeout: TIMEOUT_MS,
      maxRetries: 0
    })
    this.model = settings.model
  }

  async chat(system: string, messages: ChatMessage[], signal?: AbortSignal): Promise<LlmResult> {
    const res = await this.client.messages.create(
      {
        model: this.model,
        system,
        messages: messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) })),
        max_tokens: 2048,
        temperature: 0.2
      },
      { signal }
    )
    const text = (res.content || [])
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return {
      text,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 }
    }
  }
}

export function createProvider(settings: Settings): LlmProvider {
  if (!settings.apiKey) throw new Error('尚未配置 API Key，请先在「设置」中填写接口信息')
  if (!settings.model) throw new Error('尚未配置模型名称')
  return settings.provider === 'anthropic' ? new AnthropicProvider(settings) : new OpenAIProvider(settings)
}

/**
 * 判定「模型不支持图片输入」类错误（仅在消息里带了图片时调用）：
 * 纯文本模型遇到 image 块时，常见 HTTP 400/415/422，或错误文案明确提到图片/多模态不支持。
 * 命中则视觉模式降级为纯文本，避免每步都撞一次报错。
 */
export function isVisionUnsupportedError(e: any): boolean {
  if (!e) return false
  const status = typeof e.status === 'number' ? e.status : typeof e?.response?.status === 'number' ? e.response.status : NaN
  if ([400, 415, 422].includes(status)) return true
  const msg = String(e?.message || e || '')
  return /(不支持|无法处理|无法识别)[^\n]{0,20}(图片|图像|视觉|多模态)|(image|vision|multimodal|multi-modal)[^\n]{0,40}(not supported|unsupported)/i.test(
    msg
  )
}
