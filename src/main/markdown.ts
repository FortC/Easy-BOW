/**
 * 极简 Markdown → HTML / 纯文本 转换（零依赖）。
 * 供 paste_rich 动作把模型输出的 Markdown 变成带样式的富文本粘进在线文档：
 * 文档平台收到 text/html 剪贴板内容后会渲染出标题/列表/加粗等真实样式。
 *
 * 支持子集：标题 #~######、粗体、斜体、行内代码、fenced 代码块、
 * 无序/有序列表、引用、分割线、链接、简单表格。
 */

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 行内格式：`code`、**粗体**、*斜体*、[文字](链接) */
function inlineMd(s: string): string {
  let out = esc(s)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  return out
}

export function mdToHtml(md: string): string {
  const lines = (md || '').replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  let quote: string[] = []
  let table: string[][] | null = null
  let code: string[] | null = null

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(' '))}</p>`)
      para = []
    }
  }
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inlineMd(quote.join(' '))}</blockquote>`)
      quote = []
    }
  }
  const flushTable = () => {
    if (table && table.length) {
      const [head, ...rows] = table
      const th = head.map((c) => `<th>${inlineMd(c)}</th>`).join('')
      const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<table><tr>${th}</tr>${trs}</table>`)
    }
    table = null
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
    flushTable()
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
        code = null
      } else {
        code.push(raw)
      }
      continue
    }
    if (/^```/.test(line)) {
      flushAll()
      code = []
      continue
    }
    // 表格行：| a | b |
    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim())
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue // 表头分隔行
      if (!table) {
        flushAll()
        table = []
      }
      table.push(cells)
      continue
    }
    if (table) flushTable()
    if (!line) {
      flushAll()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flushAll()
      const lv = h[1].length
      out.push(`<h${lv}>${inlineMd(h[2].trim())}</h${lv}>`)
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flushAll()
      out.push('<hr>')
      continue
    }
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      flushPara()
      flushList()
      quote.push(q[1])
      continue
    }
    if (quote.length) flushQuote()
    const ul = /^[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      flushPara()
      if (list !== 'ul') {
        flushList()
        out.push('<ul>')
        list = 'ul'
      }
      out.push(`<li>${inlineMd(ul[1])}</li>`)
      continue
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ol) {
      flushPara()
      if (list !== 'ol') {
        flushList()
        out.push('<ol>')
        list = 'ol'
      }
      out.push(`<li>${inlineMd(ol[1])}</li>`)
      continue
    }
    if (list) flushList()
    para.push(line)
  }
  if (code !== null && code.length) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
  flushAll()
  return out.join('\n')
}

/** Markdown → 纯文本（text/plain 兜底：粘贴目标不支持 HTML 时用） */
export function mdToPlain(md: string): string {
  return (md || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      const line = raw.trim()
      if (/^```/.test(line)) return ''
      const h = /^#{1,6}\s+(.*)$/.exec(line)
      if (h) return h[1]
      const ul = /^[-*+]\s+(.*)$/.exec(line)
      if (ul) return '• ' + ul[1]
      const ol = /^(\d+)[.)]\s+(.*)$/.exec(line)
      if (ol) return ol[1] + '. ' + ol[2]
      const q = /^>\s?(.*)$/.exec(line)
      if (q) return q[1]
      return line
    })
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
