/**
 * expect 断言的页面侧求值函数（注入执行，主文档 + 同源 iframe + open shadow DOM 穿透）。
 * executor 负责轮询与结果判定，这里只做单次求值。
 * W5 补漏：innerText/querySelector 均不含 shadow DOM 内容——组件库表单的回显/取值
 * 必须递归 open shadowRoot 才可见（与 extractor 的穿透口径对齐）。
 */

/** 页面是否出现指定文字（返回命中片段便于报告定位） */
export const EXPECT_TEXT_FN = String(function expectText(needle: string) {
  if (!needle) return { found: false, snippet: '' }
  const n = needle.replace(/\s+/g, ' ').trim()
  function norm(s: string | null | undefined): string {
    return s ? s.replace(/\s+/g, ' ') : ''
  }
  // shadow DOM 补充扫描：收集 open shadowRoot 的文本（上限 60 个 host，防大页面过重）
  function shadowText(root: Document | ShadowRoot): string {
    let out = ''
    let visited = 0
    const walk = (r: Document | ShadowRoot) => {
      let all: NodeList
      try {
        all = r.querySelectorAll('*')
      } catch {
        return
      }
      for (const el of Array.from(all)) {
        const sr = (el as any).shadowRoot
        if (!sr) continue
        if (++visited > 60) return
        out += ' ' + norm(sr.textContent || '')
        walk(sr)
      }
    }
    walk(root)
    return out
  }
  function scan(doc: Document): { found: boolean; snippet: string } {
    const text = norm(doc.body ? doc.body.innerText : '') + ' ' + shadowText(doc)
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

/** 选择器求值：存在性 / 取值 / 取文本（querySelectorAll 全文档计数；浅层未命中时递归 open shadowRoot） */
export const EXPECT_SEL_FN = String(function expectSel(selector: string, mode: 'exists' | 'value' | 'text') {
  if (!selector) return { ok: false, err: 'no-selector' }
  let nodes: NodeList
  try {
    nodes = document.querySelectorAll(selector)
  } catch {
    return { ok: false, err: 'invalid-selector' }
  }
  // W5 shadow 穿透：浅层没命中时递归 open shadowRoot（querySelector 不跨 shadow 边界）
  let shadowHits = 0
  const deepQuery = (root: Document | ShadowRoot): Element | null => {
    let hit: Element | null = null
    try {
      hit = root.querySelector(selector)
    } catch {
      return null
    }
    if (hit) return hit
    let all: NodeList
    try {
      all = root.querySelectorAll('*')
    } catch {
      return null
    }
    for (const el of Array.from(all)) {
      const sr = (el as any).shadowRoot
      if (!sr) continue
      if (++shadowHits > 100) return null
      const found = deepQuery(sr)
      if (found) return found
    }
    return null
  }
  if (mode === 'exists') {
    if (nodes.length > 0) return { ok: true, count: nodes.length }
    const deep = deepQuery(document)
    return { ok: true, count: deep ? 1 : 0 }
  }
  let el = nodes[0] as any
  if (!el) {
    el = deepQuery(document) as any
    if (!el) return { ok: true, count: 0 }
  }
  if (mode === 'value') {
    const v = el.value != null ? String(el.value) : el.getAttribute('value') || ''
    return { ok: true, count: Math.max(nodes.length, 1), v }
  }
  const t = String(el.innerText != null ? el.innerText : el.textContent || '').replace(/\s+/g, ' ').trim()
  return { ok: true, count: Math.max(nodes.length, 1), v: t.slice(0, 120) }
})

/**
 * 提交后软断言求值：检查常见表单校验错误选择器中是否有「可见且非空文案」的元素
 * （display/visibility/尺寸三重过滤，避免隐藏的预置错误节点误报）。
 */
export const SOFT_ERR_FN = String(function softErr() {
  const SELS = [
    '.error-msg', '[role="alert"]', '.ant-form-item-explain-error', '.el-form-item__error',
    '.field-error', '.invalid-feedback', '.form-error', '.help-error'
  ]
  for (const s of SELS) {
    let nodes: NodeList
    try {
      nodes = document.querySelectorAll(s)
    } catch {
      continue
    }
    for (const el of Array.from(nodes)) {
      const e = el as HTMLElement
      const st = getComputedStyle(e)
      const r = e.getBoundingClientRect()
      if (st.display === 'none' || st.visibility === 'hidden' || r.width <= 0 || r.height <= 0) continue
      const t = (e.innerText || '').trim().slice(0, 60)
      if (t) return { hit: true, sel: s, text: t }
    }
  }
  return { hit: false }
})
