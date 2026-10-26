import type { AgentAction } from '../../shared/types'
import { EXPECT_TEXT_FN, EXPECT_SEL_FN } from './assertions'

export interface AssertionPage {
  url(): string
  title(): string
  evaluate<T>(fn: string, args: unknown[]): Promise<T>
  response(url: string, since?: number, method?: string): Promise<{ status: number; url: string; body?: string } | null>
}

/** 求值错误不参与逻辑取反；未观察到请求/响应体不等于负向断言成立。 */
export async function evaluateAssertion(
  action: AgentAction,
  page: AssertionPage,
  memory: Record<string, string>,
  signal: AbortSignal,
  wait: (ms: number) => Promise<void>
): Promise<void> {
  const expand = (s = '') => s.replace(/\{\{([^}]+)\}\}/g, (_m, k) => {
    const value = memory[String(k).trim()]
    if (value == null) throw new Error(`未定义测试变量: ${k}`)
    return value
  })
  let actual = ''
  let status: 'passed' | 'failed' | 'error' = 'error'
  const timeout = Math.max(0, Math.min(30000, action.timeoutMs ?? 3000))
  const deadline = Date.now() + timeout
  do {
    if (signal.aborted) throw signal.reason || new Error('断言已取消')
    try {
      const value = expand(String(action.value ?? action.text ?? ''))
      let matched = false
      if (action.kind === 'url_contains' || action.kind === 'title_contains') {
        if (!value) throw new Error('URL/标题断言的期望值不能为空')
        actual = action.kind === 'url_contains' ? page.url() : page.title()
        matched = actual.includes(value)
      } else if (action.kind === 'text_visible') {
        if (!value) throw new Error('文字断言的期望值不能为空')
        const r = await page.evaluate<{ found: boolean; snippet: string }>(EXPECT_TEXT_FN, [value])
        if (!r || typeof r.found !== 'boolean') throw new Error('页面文字求值失败')
        matched = r.found
        actual = r.snippet || '页面可见文字中未找到'
      } else if (['selector_exists', 'selector_value', 'selector_text'].includes(action.kind || '')) {
        const mode = action.kind === 'selector_exists' ? 'exists' : action.kind === 'selector_value' ? 'value' : 'text'
        const r = await page.evaluate<{ ok: boolean; count?: number; v?: string; err?: string }>(EXPECT_SEL_FN, [expand(action.selector), mode])
        if (!r?.ok) throw new Error(r?.err || '选择器求值失败')
        // 值/文字的取反也要求目标存在，不能因定位失败就判通过。
        if (mode !== 'exists' && !r.count) throw new Error('选择器未匹配到元素')
        actual = mode === 'exists' ? `匹配 ${r.count || 0} 个元素` : r.v ?? ''
        matched = mode === 'exists' ? (r.count || 0) > 0 : actual.trim() === value.trim()
      } else if (action.kind === 'api_status' || action.kind === 'api_body') {
        const url = expand(action.urlPart)
        if (!url) throw new Error('缺少接口 URL')
        const r = await page.response(url, action.networkSince, action.method)
        if (!r) throw new Error(`当前步骤未捕获已完成接口: ${url}`)
        if (action.kind === 'api_body' && r.body == null) throw new Error('响应体不可用')
        actual = action.kind === 'api_status' ? `HTTP ${r.status} (${r.url})` : r.body!
        matched = action.kind === 'api_status' ? String(r.status) === value : r.body!.includes(value)
      } else {
        throw new Error(`无法确定性执行断言类型: ${action.kind || '未指定'}，请补充结构化预期`)
      }
      status = (action.negate ? !matched : matched) ? 'passed' : 'failed'
    } catch (e: any) {
      actual = String(e?.message || e)
      status = 'error'
    }
    if (signal.aborted) throw signal.reason || new Error('断言已取消')
    if (status === 'passed' || Date.now() >= deadline) break
    await wait(Math.min(250, Math.max(0, deadline - Date.now())))
  } while (true)
  action.assertionStatus = status
  action.actual = actual.slice(0, 1000)
  action.error = status === 'passed' ? undefined : `${status === 'error' ? '断言求值错误' : '断言失败'}: [${action.kind}] 实际=${actual.slice(0, 200)}`
  action.result = action.error || `断言通过: [${action.kind}] ${action.negate ? '不' : ''}${action.value ?? action.selector ?? ''}`
}
