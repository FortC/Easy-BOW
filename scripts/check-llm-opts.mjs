// 模型请求构造回归检查（离线、不花 token）：验证 chat() 请求形状能通过 SDK 选项校验。
// 背景：4.3.1 给请求选项显式传 timeout: undefined，Anthropic SDK 校验直接抛
// 「timeout must be an integer」，所有模型调用（含测试连接）全挂。此脚本用假凭据 +
// 不可达地址跑真实 SDK，只看错误是否停在选项校验层（报 Connection/网络错误即为通过）。
import Anthropic from '@anthropic-ai/sdk'

const client = new Anthropic({ apiKey: 'sk-dummy', baseURL: 'http://127.0.0.1:1', timeout: 90000, maxRetries: 0 })
const baseReq = {
  model: 'check-model',
  system: [{ type: 'text', text: 't', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 16,
  temperature: 0.2
}

async function passesOptsValidation(reqOpts) {
  try {
    await client.messages.create(baseReq, reqOpts)
    return false // 不可达地址不该成功
  } catch (e) {
    return !String(e?.message || e).includes('timeout must be an integer')
  }
}

const r1 = await passesOptsValidation({}) // 普通调用：不带 timeout 字段
const r2 = await passesOptsValidation({ timeout: 180000 }) // plain 调用
const r3 = !(await passesOptsValidation({ timeout: undefined })) // 反例必须抛校验错误
console.log(`普通调用（不带 timeout 字段）: ${r1 ? '✓' : '✗'}`)
console.log(`plain 调用（timeout=180000）: ${r2 ? '✓' : '✗'}`)
console.log(`反例（timeout 显式 undefined 抛校验错误）: ${r3 ? '✓' : '✗'}`)
process.exit(r1 && r2 && r3 ? 0 : 1)
