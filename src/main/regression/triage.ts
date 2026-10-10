/**
 * 失败三分类（横切约束 3）：
 * - agent：AI 执行问题，计入成功率分子/分母；
 * - infra：环境失败（验证码/登录页/网络错误命中），单列不计入成功率；
 * - product：产品 bug，单列（建议建 issue）。
 * 分类最小规则：URL 或页面文本命中特征串即归 infra / product，未命中归 agent。
 */
import type { FailureTriage } from '../telemetry'

/** infra 特征：登录页 / 验证码 / 安全验证 / 网络错误 / Chromium 错误码 */
const INFRA_RE = /登录|验证码|安全验证|网络错误|ERR_[A-Z]+|无法连接|连接被拒绝|网络超时/

/** product 特征：服务端 5xx / 提交失败 / 服务错误 / JS 运行时错误 */
const PRODUCT_RE = /HTTP\s*5\d{2}|提交失败|服务(器)?(错误|异常)|Internal Server Error|TypeError|ReferenceError/

export interface TriageResult {
  triage: FailureTriage
  note: string
}

/** 对失败用例分类：输入失败原因摘要 + 当前 URL + 页面文本 */
export function classifyFailure(reason: string, pageUrl: string, pageText: string): TriageResult {
  const blob = `${pageUrl}\n${pageText.slice(0, 1500)}\n${reason}`
  const infra = blob.match(INFRA_RE)
  if (infra) return { triage: 'infra', note: `命中环境特征「${infra[0]}」` }
  const product = blob.match(PRODUCT_RE)
  if (product) return { triage: 'product', note: `命中产品特征「${product[0]}」` }
  return { triage: 'agent', note: '未命中环境/产品特征，计为 AI 执行问题' }
}
