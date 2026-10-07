/**
 * DOM 元素提取器 —— browser-use 核心技术的 TS 实现。
 * 注入页面执行：遍历可交互元素（递归穿透同源 iframe），做可见性检查与
 * 视口优先排序，输出精简编号列表。模型只看这个列表，不看 HTML。
 */

export interface Candidate {
  /** iframe 链上每一层的索引路径（从 documentElement 起） */
  framePaths: number[][]
  /** 本文档内从 documentElement 到元素的 children 索引路径 */
  path: number[]
  tag: string
  role: string
  text: string
  extra: string
  /** 视口绝对坐标（iframe 内元素已逐层累加祖先 iframe 偏移，与顶层截图对齐） */
  rect: { x: number; y: number; w: number; h: number }
  inViewport: boolean
}

export interface ExtractResult {
  title: string
  url: string
  scrollY: number
  scrollHeight: number
  viewportW: number
  viewportH: number
  candidates: Candidate[]
  totalFound: number
  imgCount: number
}

/** 在页面上下文中运行（自包含，序列化注入） */
export const EXTRACT_FN = String(function extract(maxElements: number) {
  const SEL =
    'a[href], button, input, select, textarea, summary, [role], [contenteditable="true"], [onclick], img[onclick], label[for], [tabindex]:not([tabindex="-1"])'
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])

  const out: any[] = []
  let total = 0

  function normText(s: unknown): string {
    if (!s) return ''
    return String(s).replace(/\s+/g, ' ').trim()
  }

  function roleOf(el: Element): string {
    const r = el.getAttribute('role')
    if (r) return r
    const t = el.tagName
    if (t === 'A') return 'link'
    if (t === 'BUTTON') return 'button'
    if (t === 'SELECT') return 'select'
    if (t === 'TEXTAREA') return 'textarea'
    if (t === 'SUMMARY') return '折叠项'
    if (t === 'LABEL') return 'label'
    if (t === 'IMG') return 'image'
    if (el.getAttribute('contenteditable') === 'true') return '可编辑'
    if (t === 'INPUT') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase()
      const map: Record<string, string> = {
        text: 'input文本',
        search: 'input搜索',
        password: 'input密码',
        url: 'input网址',
        email: 'input邮箱',
        tel: 'input电话',
        number: 'input数字',
        checkbox: '复选框',
        radio: '单选框',
        submit: 'button',
        button: 'button',
        reset: 'button',
        file: 'input文件',
        date: 'input日期',
        range: 'input滑杆'
      }
      return map[ty] || 'input' + ty
    }
    return t.toLowerCase()
  }

  function textOf(el: Element, role: string): { text: string; extra: string } {
    let text = ''
    let extra = ''
    const t = el.tagName
    if (t === 'INPUT' || t === 'TEXTAREA') {
      const ph = normText(el.getAttribute('placeholder'))
      const val = normText((el as any).value)
      if (t === 'TEXTAREA') text = val.slice(0, 80)
      else if ((el.getAttribute('type') || 'text') === 'password') text = val ? '(已输入密码)' : ''
      else text = val.slice(0, 40)
      if (ph) extra += `placeholder=${ph.slice(0, 30)}`
      // 关联 label
      let lab = ''
      const id = el.getAttribute('id')
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (l) lab = normText((l as HTMLElement).innerText)
      }
      if (!lab) {
        const p = el.closest('label')
        if (p) lab = normText(p.innerText)
      }
      if (lab) extra += (extra ? ' ' : '') + `label=${lab.slice(0, 30)}`
      const ck = el.getAttribute('type')
      if (ck === 'checkbox' || ck === 'radio') text = (el as any).checked ? '已勾选' : '未勾选'
    } else if (t === 'SELECT') {
      const sel = el as HTMLSelectElement
      const opt = sel.selectedOptions[0]
      text = normText(opt && opt.textContent).slice(0, 30)
      extra = `${sel.options.length}个选项`
    } else if (t === 'IMG') {
      text = normText(el.getAttribute('alt'))
      extra = `图片${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`
    } else {
      text = normText((el as HTMLElement).innerText).slice(0, 80)
    }
    if (!text) text = normText(el.getAttribute('aria-label')).slice(0, 50)
    if (!text) text = normText(el.getAttribute('title')).slice(0, 50)
    if (t === 'A' && role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript')) {
        const trimmed = href.length > 60 ? href.slice(0, 60) + '…' : href
        if (!text || text.length < 4) extra += (extra ? ' ' : '') + `href=${trimmed}`
      }
    }
    return { text: text.slice(0, 80), extra: extra.slice(0, 90) }
  }

  function indexPath(el: Element): number[] {
    const path: number[] = []
    let cur: Element | null = el
    while (cur && cur !== document.documentElement) {
      const parent: Element | null = cur.parentElement
      if (!parent) break
      let idx = 0
      for (const c of Array.from(parent.children)) {
        if (c === cur) break
        idx++
      }
      path.push(idx)
      cur = parent
    }
    return path.reverse()
  }

  function visible(el: Element, offX: number, offY: number): { rect: DOMRect; ok: boolean; inVp: boolean; occluded: boolean } {
    const rect = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const ok =
      cs.display !== 'none' &&
      cs.visibility !== 'hidden' &&
      parseFloat(cs.opacity || '1') > 0.05 &&
      rect.width >= 4 &&
      rect.height >= 4
    const vh = window.innerHeight
    // inVp 用顶层视口判断：iframe 内元素需加上祖先 iframe 的累计偏移
    const inVp = ok && rect.bottom + offY > 0 && rect.top + offY < vh
    let occluded = false
    if (inVp && rect.width * rect.height > 400) {
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const top = document.elementFromPoint(cx, cy)
      if (top && top !== el && !el.contains(top) && !top.contains(el)) {
        occluded = true
      }
    }
    return { rect, ok, inVp, occluded }
  }

  function collect(doc: Document, framePaths: number[][], depth: number, offX: number, offY: number): void {
    let list: Element[]
    try {
      list = Array.from(doc.querySelectorAll(SEL))
    } catch {
      return
    }
    for (const el of list) {
      // 祖先已是可交互元素则跳过内层（去重嵌套按钮）
      let p: Element | null = el.parentElement
      let nested = false
      while (p) {
        if (INTERACTIVE_TAGS.has(p.tagName) || p.getAttribute('role') || p.getAttribute('onclick')) {
          nested = true
          break
        }
        p = p.parentElement
      }
      if (nested) continue
      if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) continue
      const dis = (el as HTMLButtonElement).disabled
      if (dis) continue
      const v = visible(el, offX, offY)
      if (!v.ok) continue
      // 视口下方太远的元素不进列表（可滚动后再提取），按顶层绝对坐标判断
      if (v.rect.top + offY > window.innerHeight * 4) continue
      total++
      const role = roleOf(el)
      const { text, extra } = textOf(el, role)
      let score = 0
      if (v.inVp) score += 100
      if (/input|select|可编辑/.test(role)) score += 20
      else if (role === 'button') score += 15
      else if (role === 'link') score += 10
      else score += 5
      score += Math.min(text.length, 40) / 4
      if (v.occluded) score -= 60
      out.push({
        framePaths,
        path: indexPath(el),
        tag: el.tagName,
        role,
        text,
        extra,
        rect: {
          x: Math.round(v.rect.left + offX),
          y: Math.round(v.rect.top + offY),
          w: Math.round(v.rect.width),
          h: Math.round(v.rect.height)
        },
        inViewport: v.inVp,
        _score: score
      })
    }
    // 递归穿透同源 iframe（聚水潭等老式布局必需），最多两层
    if (depth < 2) {
      let iframes: Element[]
      try {
        iframes = Array.from(doc.querySelectorAll('iframe'))
      } catch {
        iframes = []
      }
      for (const f of iframes) {
        let cd: Document | null = null
        try {
          cd = (f as HTMLIFrameElement).contentDocument
        } catch {
          cd = null
        }
        if (!cd || !cd.body) continue
        // iframe 内元素的坐标逐层累加，换算为顶层视口绝对坐标（与截图对齐）
        const fr = f.getBoundingClientRect()
        collect(cd, [...framePaths, indexPath(f)], depth + 1, offX + fr.left, offY + fr.top)
      }
    }
  }

  collect(document, [], 0, 0, 0)
  out.sort((a: any, b: any) => b._score - a._score)
  const top = out.slice(0, maxElements).map(({ _score, ...rest }: any) => rest)
  return {
    title: document.title || '',
    url: location.href,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    candidates: top,
    totalFound: total,
    imgCount: document.images ? document.images.length : 0
  }
})

/** 根据提取结果生成给模型的精简文本行；withCoords 时为视口内元素追加截图归一化坐标 @x,y（0~1000） */
export function formatCandidates(res: ExtractResult, withCoords = false): string {
  if (!res.candidates.length) return '（页面上没有发现可交互元素）'
  const vw = res.viewportW || 0
  const vh = res.viewportH || 0
  const lines: string[] = []
  res.candidates.forEach((c, i) => {
    const parts = [`[${i}] <${c.role}>`]
    if (c.text) parts.push(`"${c.text}"`)
    if (c.extra) parts.push(`(${c.extra})`)
    if (withCoords && c.inViewport && vw > 0 && vh > 0) {
      const nx = Math.round(((c.rect.x + c.rect.w / 2) / vw) * 1000)
      const ny = Math.round(((c.rect.y + c.rect.h / 2) / vh) * 1000)
      parts.push(`@${Math.max(0, Math.min(1000, nx))},${Math.max(0, Math.min(1000, ny))}`)
    }
    if (!c.inViewport) parts.push('(需滚动到)')
    lines.push(parts.join(' '))
  })
  return lines.join('\n')
}

/** 在页面上下文中按 framePaths+path 定位元素，返回页面绝对坐标（供 CDP 点击） */
export const RESOLVE_FN = String(function resolve(framePaths: number[][], path: number[], expectTag?: string) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: Element = doc.documentElement
    for (const i of p) {
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el
  }
  let doc: Document = document
  const chain: { iframe: Element; doc: Document }[] = []
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return { found: false }
    let cd: Document | null = null
    try {
      cd = (f as HTMLIFrameElement).contentDocument
    } catch {
      return { found: false }
    }
    if (!cd) return { found: false }
    chain.push({ iframe: f, doc: cd })
    doc = cd
  }
  const el = walk(doc, path)
  if (!el) return { found: false }
  // 标签校验：children 序号路径在 SPA 重渲染/虚拟滚动后可能落到错误节点上，
  // 标签不符视为失效（上层会重提取并按文本重定位），杜绝"点错元素还报成功"
  if (expectTag && el.tagName !== expectTag) return { found: false }
  try {
    ;(el as any).scrollIntoView({ block: 'center', inline: 'nearest' })
  } catch {}
  const r = el.getBoundingClientRect()
  let x = r.left + r.width / 2
  let y = r.top + r.height / 2
  // 逐层加上祖先 iframe 的偏移，换算为顶层页面坐标
  for (let i = chain.length - 1; i >= 0; i--) {
    const ir = chain[i].iframe.getBoundingClientRect()
    x += ir.left
    y += ir.top
  }
  const tag = el.tagName
  const editable =
    tag === 'INPUT' || tag === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true'
  const value =
    tag === 'INPUT' || tag === 'TEXTAREA' ? String((el as any).value || '') : ''
  return {
    found: true,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    tag,
    editable,
    value: value.slice(0, 100),
    w: Math.round(r.width),
    h: Math.round(r.height)
  }
})

/** 读取页面正文（表格转 Markdown）—— read_content 动作 & OCR 降级判断用 */
export const READ_CONTENT_FN = String(function readContent(maxChars: number) {
  function md(table: Element): string {
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 50)
    const lines: string[] = []
    for (const tr of rows) {
      const cells = Array.from(tr.querySelectorAll('th,td')).map((td) =>
        (td.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      )
      if (cells.length) lines.push('| ' + cells.join(' | ') + ' |')
    }
    return lines.join('\n')
  }
  function tablesIn(doc: Document): string[] {
    const res: string[] = []
    let ts: Element[]
    try {
      ts = Array.from(doc.querySelectorAll('table'))
    } catch {
      return res
    }
    for (const t of ts) {
      if (t.querySelectorAll('tr').length < 2) continue
      const s = md(t)
      if (s) res.push(s)
    }
    return res
  }
  const tables = [...tablesIn(document)]
  let iframes: Element[]
  try {
    iframes = Array.from(document.querySelectorAll('iframe'))
  } catch {
    iframes = []
  }
  for (const f of iframes) {
    try {
      const cd = (f as HTMLIFrameElement).contentDocument
      if (cd && cd.body) tables.push(...tablesIn(cd))
    } catch {}
  }
  let body = ''
  try {
    body = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
  } catch {}
  let text = body
  if (tables.length) text += '\n\n# 页面表格\n' + tables.join('\n\n')
  if (text.length > maxChars) {
    const head = Math.floor(maxChars * 0.65)
    text = text.slice(0, head) + '\n…(中间省略)…\n' + text.slice(text.length - Math.floor(maxChars * 0.35))
  }
  let imgs = 0
  try {
    imgs = document.images.length
  } catch {}
  return { title: document.title, url: location.href, text, bodyLen: body.length, imgs }
})

/** 验证码 / 登录摩擦检测 */
/** 抓取页面图片资源（主图/详情图等）：img（含懒加载属性与 srcset）+ CSS 背景图，按尺寸排序，过滤小图标 */
export const EXTRACT_IMAGES_FN = String(function extractImages(limit: number) {
  const seen = new Set<string>()
  const items: { url: string; w: number; h: number; alt: string; kind: string }[] = []
  function push(url: string, w: number, h: number, alt: string, kind: string) {
    url = String(url || '').trim()
    if (!url || url === 'about:blank') return
    if (seen.has(url)) return
    if (w > 0 && h > 0 && w < 24 && h < 24) return // 埋点/小图标
    if (w > 0 && h > 0 && w < 40 && h < 40 && /\.svg(\?|$)/i.test(url)) return // 小 svg 图标
    seen.add(url)
    items.push({ url: url.slice(0, 400), w: Math.round(w), h: Math.round(h), alt: (alt || '').slice(0, 40), kind })
  }
  function scan(doc: Document) {
    let imgs: Element[] = []
    try {
      imgs = Array.from(doc.querySelectorAll('img'))
    } catch {
      return
    }
    for (const el of imgs) {
      const r = el.getBoundingClientRect()
      const im = el as HTMLImageElement
      let best: string = im.currentSrc || im.src || el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('data-lazy-src') || ''
      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset') || ''
      if (srcset) {
        const parts = srcset.split(',').map(function (s) { return s.trim().split(/\s+/)[0] }).filter(Boolean)
        if (parts.length) best = parts[parts.length - 1] // 最后一档通常最大
      }
      push(best, r.width || im.naturalWidth || 0, r.height || im.naturalHeight || 0, el.getAttribute('alt') || el.getAttribute('title') || '', 'img')
    }
    // CSS 背景图（电商详情图常用 div 背景铺图）
    let all: Element[] = []
    try {
      all = Array.from(doc.querySelectorAll('*'))
    } catch {}
    let n = 0
    for (const el of all) {
      if (n > 3000) break
      n++
      let bg = ''
      try {
        bg = getComputedStyle(el).backgroundImage
      } catch {
        continue
      }
      const m = bg && bg !== 'none' ? bg.match(/url\((['"]?)([^)]*?)\1\)/) : null
      if (!m) continue
      const r = el.getBoundingClientRect()
      push(m[2], r.width, r.height, el.getAttribute('title') || el.getAttribute('aria-label') || '', 'bg')
    }
  }
  scan(document)
  let frames: HTMLIFrameElement[] = []
  try {
    frames = Array.from(document.querySelectorAll('iframe'))
  } catch {}
  for (const f of frames) {
    try {
      if (f.contentDocument) scan(f.contentDocument)
    } catch {}
  }
  items.sort(function (a, b) { return b.w * b.h - a.w * a.h })
  const list = items.slice(0, limit)
  if (!list.length) return '页面上没有抓到图片资源（可尝试先 scroll 到图片区域再抓取）'
  return (
    `共发现 ${items.length} 张图片（按尺寸从大到小排列，小图标已过滤）：\n` +
    list
      .map(function (it, i) {
        return `[${i + 1}] ${it.w}x${it.h} ${it.kind === 'bg' ? '背景图' : 'img'}${it.alt ? ' alt=' + it.alt : ''}\n${it.url}`
      })
      .join('\n')
  )
})

export const DETECT_FRICTION_FN = String(function detectFriction() {
  const url = location.href
  let urlHit = false
  try {
    urlHit = /punish|captcha|verify_code|sec\.xiaohongshu\.com\/verification/i.test(url)
  } catch {}
  const sels = [
    '#nc_1_wrapper',
    '.nc_1_wrapper',
    '.nc-container',
    '.geetest_box',
    'iframe[src*="captcha"]',
    'iframe[src*="punish"]',
    '#baxia-dialog-content',
    '.baxia-dialog',
    '.JDJRV-slide',
    '#aliyunCaptcha-sliding-slider',
    '.verify-wrap',
    '#captcha_element',
    '[class*="slide-verify"]',
    '[class*="SliderVerify"]',
    '[id*="nc_1_n1z"]'
  ]
  function visible(el: Element): boolean {
    // 隐藏的预置容器（display:none）不算验证码，避免误判暂停
    try {
      const r = el.getBoundingClientRect()
      return el.getClientRects().length > 0 && r.width > 0 && r.height > 0
    } catch {
      return false
    }
  }
  const hitSel: string[] = []
  for (const s of sels) {
    try {
      const el = document.querySelector(s)
      if (el && visible(el)) hitSel.push(s)
    } catch {}
  }
  let textHit = false
  let loginHint = false
  try {
    const t = (document.body?.innerText || '').slice(0, 3000)
    textHit = /拖动滑块|按住滑块|拖动到最右|滑动验证|请完成.{0,6}(验证|拼图)|安全验证|图形验证码/.test(t)
    loginHint = /亲，请登录|扫码登录|请先登录|登录后.{0,8}(查看|操作)/.test(t)
  } catch {}
  return { urlHit, hitSel, textHit, loginHint, url }
})
