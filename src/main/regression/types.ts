/**
 * 回归 runner 共享类型（T1 骨架 + T11 fixture 用例）。
 */
import type { FailureTriage } from '../telemetry'

/** 末尾 expect 验收（对结果区 / URL / 文本断言） */
export interface CaseExpect {
  kind: 'text_visible' | 'url_contains' | 'selector_exists' | 'selector_text' | 'selector_value'
  /** 断言值（text_visible / *_contains 类） */
  value?: string
  /** CSS 选择器（selector_* 类） */
  selector?: string
  /** 取反断言 */
  negate?: boolean
}

/** 任务型用例 = 自然语言任务（AgentRunner 执行）+ 末尾 expect 验收 */
export interface RegressionCase {
  name: string
  /** 起始页 URL（可缺省：任务自带「打开某网站」） */
  startUrl?: string
  task: string
  expects: CaseExpect[]
  /** 单用例超时（毫秒），缺省 180s */
  timeoutMs?: number
}

/** cases.json 条目（多一个启用开关；enabled=false 的模板条目不执行） */
export interface ConfigCase extends RegressionCase {
  enabled?: boolean
}

export interface ExpectResult {
  desc: string
  ok: boolean
  actual?: string
}

export interface CaseResult {
  name: string
  source: 'fixture' | 'cases.json'
  status: 'passed' | 'failed' | 'skipped'
  /** 失败三分类（仅 failed；skipped 不分类） */
  triage?: FailureTriage
  /** 失败原因 / 跳过原因摘要 */
  reason?: string
  /** 模型步数 */
  steps: number
  durationMs: number
  /** 每步耗时（毫秒，P50/P90 数据源） */
  stepMs: number[]
  tokens: { input: number; output: number }
  expects: ExpectResult[]
}
