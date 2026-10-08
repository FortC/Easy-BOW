/**
 * 测试用例 MD 解析器（纯 TS，无 LLM、无浏览器依赖——自测覆盖）。
 *
 * 用例 MD 规范（converter 产出的就是这份规范，人工编辑同样支持）：
 *
 *   # TESTCASE: 用例名
 *
 *   ## 测试数据
 *   | 变量 | 值 |
 *   |---|---|
 *   | username | test01 |
 *
 *   ## 步骤
 *   ### 步骤 1: 打开登录页
 *   - 操作: 访问 {{base_url}}/login
 *
 *   ### 步骤 2: 填写并提交
 *   - 操作: 在「用户名」输入 {{username}}，点击「登录」
 *   - 预期: [文字] 页面出现「欢迎回来」
 *   - 预期: [URL] 包含 /dashboard
 *   - 预期: [选择器 .error-msg] 不存在
 *   - 弹窗: 确认        （可选：该步骤遇 JS 弹窗时自动确认/取消，缺省=确认）
 *
 *   ## 清理
 *   ### 步骤 1: 退出登录
 *   - 操作: ...
 *
 * 预期行类型标记：[文字]→text_visible、[URL]→url_contains、[标题]→title_contains、
 * [选择器 X] 存在/不存在→selector_exists、[选择器 X] 值=Y→selector_value、
 * [选择器 X] 文本=Y→selector_text；无标记的自然语言预期 → kind:'ai'（由模型翻译成 expect）。
 */
import type { TestCase, TestStep, TestAssertion, ExpectKind } from '@shared/types'

export interface ParseResult {
  ok: boolean
  error?: string
  tc?: TestCase
}

/** 解析「预期」行为结构化断言 */
export function parseAssertionLine(raw: string): TestAssertion {
  const line = raw.trim()
  // [选择器 X] 存在 / 不存在 / 值 = Y / 文本 = Y
  const selM = line.match(/^\[选择器\s+([^\]]+)\]\s*(.*)$/)
  if (selM) {
    const selector = selM[1].trim()
    const rest = selM[2].trim()
    if (/^不存在/.test(rest)) return { raw: line, kind: 'selector_exists', selector, negate: true }
    if (/^存在/.test(rest)) return { raw: line, kind: 'selector_exists', selector }
    const valM = rest.match(/^值\s*=\s*(.*)$/)
    if (valM) return { raw: line, kind: 'selector_value', selector, value: valM[1].trim() }
    const txtM = rest.match(/^文本\s*=\s*(.*)$/)
    if (txtM) return { raw: line, kind: 'selector_text', selector, value: txtM[1].trim() }
    // 只给了选择器没给判断 → 默认存在性
    return { raw: line, kind: 'selector_exists', selector }
  }
  // [文字] / [URL] / [标题]（支持「不包含/不出现」取反）
  const tagM = line.match(/^\[(文字|URL|标题|url|url包含|标题包含)\]\s*(.*)$/)
  if (tagM) {
    const tag = tagM[1]
    const rest = tagM[2].trim()
    const neg = /^(不包含|不出现|不含)/.test(rest)
    const value = rest.replace(/^(不包含|不出现|不含|包含|出现|含有)/, '').trim()
    const kind: ExpectKind = tag === 'URL' || tag.toLowerCase() === 'url包含' ? 'url_contains' : tag === '标题' || tag === '标题包含' ? 'title_contains' : 'text_visible'
    return { raw: line, kind, value, negate: neg || undefined }
  }
  // 无类型标记 → 交给模型翻译
  return { raw: line, kind: 'ai' }
}

/** 解析测试数据表（| k | v | 行；跳过表头与分隔行） */
function parseVars(lines: string[], startIdx: number): { vars: Record<string, string>; end: number } {
  const vars: Record<string, string> = {}
  let i = startIdx
  let sawSep = false
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) break
    if (l.startsWith('###')) break
    if (!l.startsWith('|')) break
    const cells = l.split('|').map((c) => c.trim()).filter((c, idx, arr) => !(idx === 0 && c === '') && !(idx === arr.length - 1 && c === ''))
    if (cells.every((c) => /^-+$/.test(c))) {
      sawSep = true
      continue
    }
    if (!sawSep && (cells[0] === '变量' || cells[0] === '键')) continue // 表头
    if (cells.length >= 2) {
      const k = cells[0]
      if (k && !k.startsWith('-')) vars[k] = cells[1]
    }
  }
  return { vars, end: i }
}

/**
 * 解析步骤区块（## 步骤 或 ## 清理）内的 ### 步骤 N: 标题 小节。
 * cleanup=true 时标题加「清理:」前缀（与常规步骤区分，报告里可读）。
 */
function parseSteps(lines: string[], startIdx: number, cleanup: boolean): { steps: TestStep[]; end: number } {
  const steps: TestStep[] = []
  let i = startIdx
  let cur: TestStep | null = null
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l) continue
    if (/^##\s/.test(l)) break // 下一个二级区块
    const m = l.match(/^###\s*(?:步骤\s*\d+\s*[:：]\s*)?(.+)$/)
    if (m) {
      if (cur) steps.push(cur)
      cur = { title: (cleanup ? '清理: ' : '') + m[1].trim(), action: '', assertions: [] }
      continue
    }
    if (!cur) continue
    const actM = l.match(/^[-*]\s*(?:操作|动作)\s*[:：]\s*(.+)$/)
    if (actM) {
      cur.action = actM[1].trim()
      continue
    }
    const expM = l.match(/^[-*]\s*(?:预期|期望|断言)\s*[:：]\s*(.+)$/)
    if (expM) {
      cur.assertions.push(parseAssertionLine(expM[1]))
      continue
    }
    const dlgM = l.match(/^[-*]\s*弹窗\s*[:：]\s*(确认|接受|accept|取消|拒绝|dismiss)\s*$/i)
    if (dlgM) {
      const v = dlgM[1].toLowerCase()
      cur.dialog = v === '取消' || v === '拒绝' || v === 'dismiss' ? 'dismiss' : 'accept'
      continue
    }
  }
  if (cur) steps.push(cur)
  return { steps, end: i }
}

/** 解析完整测试用例 MD */
export function parseTestCase(md: string): ParseResult {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  // 用例名：# TESTCASE: xxx（兼容任意一级标题）
  let name = ''
  for (const l of lines) {
    const m = l.match(/^#\s+(?:TESTCASE\s*[:：]\s*)?(.+)$/i)
    if (m && !/^TESTCASE$/i.test(m[1].trim())) {
      name = m[1].trim()
      break
    }
    if (m && /^TESTCASE$/i.test(m[1].trim())) continue // 只有 "# TESTCASE" 没名字，继续找
    if (name) break
  }
  if (!name) return { ok: false, error: '缺少用例名（第一行应为「# TESTCASE: 用例名」）' }

  let vars: Record<string, string> = {}
  const steps: TestStep[] = []
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i].trim()
    if (/^##\s*测试数据/.test(l)) {
      const r = parseVars(lines, i + 1)
      vars = r.vars
      i = r.end - 1
    } else if (/^##\s*步骤/.test(l)) {
      const r = parseSteps(lines, i + 1, false)
      steps.push(...r.steps)
      i = r.end - 1
    } else if (/^##\s*清理/.test(l)) {
      const r = parseSteps(lines, i + 1, true)
      steps.push(...r.steps)
      i = r.end - 1
    }
  }

  const main = steps.filter((s) => !s.title.startsWith('清理:'))
  if (!main.length) return { ok: false, error: '没有解析到任何步骤（需要「## 步骤」区块，内含「### 步骤 N: 标题」小节）' }
  for (let k = 0; k < steps.length; k++) {
    if (!steps[k].action) return { ok: false, error: `步骤「${steps[k].title}」缺少「- 操作: …」描述` }
  }
  return { ok: true, tc: { name, vars, steps } }
}

/** 概要（UI 校验预览用） */
export function summarize(tc: TestCase): { steps: number; assertions: number; vars: string[] } {
  return {
    steps: tc.steps.length,
    assertions: tc.steps.reduce((n, s) => n + s.assertions.length, 0),
    vars: Object.keys(tc.vars)
  }
}
