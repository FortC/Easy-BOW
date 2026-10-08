/**
 * expect 断言的页面侧求值函数（注入执行，主文档 + 同源 iframe 穿透）。
 * executor 负责轮询与结果判定，这里只做单次求值。
 */

/** 页面是否出现指定文字（返回命中片段便于报告定位） */
export const EXPECT_TEXT_FN = String(function expectText(needle: string) {
  if (!needle) return { found: false, snippet: '' }
  const n = needle.replace(/\s+/g, ' ').trim()
  function norm(s: string | null | undefined): string {
    return s ? s.replace(/\s+/g, ' ') : ''
  }
  function scan(doc: Document): { found: boolean; snippet: string } {
    const text = norm(doc.body ? doc.body.innerText : '')
    const at = text.indexOf(n)
    if (at >= 0) {
      const start = Math.max(0, at - 20)
      return { found: true, snippet: text.slice(start, at + n.length + 20) }
    }
    return { found: false, snippet: '' }
  }
  const top = scan(document)
  if (top.found) return top
  // 同源 iframe 穿透（一层层递归，深度限 3）
  const queue: Document[] = [document]
  let depth = 0
  while (queue.length && depth < 3) {
    const doc = queue.shift()!
    const frames = doc.querySelectorAll('iframe')
    for (const f of Array.from(frames)) {
      let inner: Document | null = null
      try {
        inner = (f as HTMLIFrameElement).contentDocument
      } catch {
        inner = null
      }
      if (!inner || !inner.body) continue
      const r = scan(inner)
      if (r.found) return r
      queue.push(inner)
    }
    depth++
  }
  return { found: false, snippet: '' }
})

/** 选择器求值：存在性 / 取值 / 取文本（querySelectorAll 全文档计数） */
export const EXPECT_SEL_FN = String(function expectSel(selector: string, mode: 'exists' | 'value' | 'text') {
  if (!selector) return { ok: false, err: 'no-selector' }
  let nodes: NodeList
  try {
    nodes = document.querySelectorAll(selector)
  } catch {
    return { ok: false, err: 'invalid-selector' }
  }
  if (mode === 'exists') return { ok: true, count: nodes.length }
  const el = nodes[0] as any
  if (!el) return { ok: true, count: 0 }
  if (mode === 'value') {
    const v = el.value != null ? String(el.value) : el.getAttribute('value') || ''
    return { ok: true, count: nodes.length, v }
  }
  const t = String(el.innerText != null ? el.innerText : el.textContent || '').replace(/\s+/g, ' ').trim()
  return { ok: true, count: nodes.length, v: t.slice(0, 120) }
})
