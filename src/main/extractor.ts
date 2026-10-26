/**
 * DOM 元素提取器 —— browser-use 核心技术的 TS 实现。
 * 注入页面执行：遍历可交互元素（递归穿透同源 iframe 与 open shadowRoot），做可见性检查与
 * 视口优先排序，输出精简编号列表。模型只看这个列表，不看 HTML。
 */
import { scoreCandidate } from './semantic'

export interface Candidate {
  /** iframe 链上每一层的索引路径（从 documentElement 起；-1 哨兵语义同 path） */
  framePaths: number[][]
  /** v4.4 跨域 frame 标识（frameAccess 的 frame 树位置，如 "0.2.1"）：带此字段的候选
   *  定位/赋值必须回该 frame 上下文执行（contentDocument 链走不通）；缺省=同源链定位 */
  frameKey?: string
  /** 本文档内从 documentElement 到元素的 children 索引路径；
   *  -1 哨兵 = 进入当前元素的 shadowRoot（如 [2,-1,0,5] = documentElement.children[2].shadowRoot.children[0].children[5]） */
  path: number[]
  tag: string
  role: string
  text: string
  /** v4.5 全称：与 text 不同且更长时才有值（JS 截断场景= title 属性；SVG <text> = textContent）。
   *  模型可引用任一种说法，匹配侧两侧都能命中——见 textmatch.ts 的省略号前缀匹配 */
  fullText?: string
  /** v4.5 截断来源：js（脚本 slice 模拟省略）/ css（CSS 省略号，innerText 本就是全量）/ svg */
  truncatedBy?: 'css' | 'js' | 'svg'
  /** v4.5 元素指纹：跨步骤稳定（不含 children 索引路径），用于跨步定位与同名消歧。
   *  模型可输出 {"name":"click","fp":"a3f2"} 直接引用，不受每步重排导致的编号漂移影响 */
  fp?: string
  extra: string
  /** 视口绝对坐标（iframe 内元素已逐层累加祖先 iframe 偏移，与顶层截图对齐；shadow 内元素坐标本身是视口坐标，不偏移） */
  rect: { x: number; y: number; w: number; h: number }
  inViewport: boolean
  /** T5 容器锚点：最近稳定容器里的消歧短文本（≤24 字，不含元素自身文本）；无合适容器时省略该字段 */
  anchor?: string
  /** W4 语义状态（disabled/已勾选/已展开 等）：进元素列表行内——模型可据此避免点死按钮；
   *  来源＝DOM/AX 实时判定（快照时点值，执行前 executor 会实时复核） */
  state?: string
}

export interface ExtractResult {
  snapshotId?: string
  title: string
  url: string
  scrollY: number
  scrollHeight: number
  viewportW: number
  viewportH: number
  candidates: Candidate[]
  totalFound: number
  imgCount: number
  /** W5 一期「探测 + 告知」：跨域 iframe（contentDocument 不可读）的 src 列表，
   *  formatCandidates 尾部注明「其中元素暂不可见，可尝试视觉模式」 */
  blockedFrames?: string[]
  /** canvas 编辑器检测：正文由 canvas 渲染（WPS/金山文档/腾讯文档等）——DOM 提取对正文全盲。
   *  命中时 formatCodes 尾部注入专用指南（paste_rich 写入 + click_xy 光标），runner 放行坐标点击 */
  canvasEditor?: boolean
  /** S1 语义重排产物：与任务语义相关的 Top 命中项（formatCandidates 末尾渲染成提示段） */
  semanticHints?: SemanticHint[]
}

/** S1 语义命中提示（index 为重排后的最终编号） */
export interface SemanticHint {
  index: number
  text: string
  via: string[]
  score: number
}

/** 在页面上下文中运行（自包含，序列化注入）；shadow=false 时关闭 shadow DOM 穿透（W5 开关回滚用）。
 *  cap=TEXT_CAP：文案长度上限，与 RESOLVE_FN 共用同一常量（消除历史上的 80/40 不对称） */
export const EXTRACT_FN = String(function extract(maxElements: number, shadow?: boolean, cap?: number, query?: string) {
  const SEL =
    'a[href], button, input, select, textarea, summary, [role], [contenteditable="true"], [onclick], img[onclick], label[for], [tabindex]:not([tabindex="-1"])'
  const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])
  const CAP = cap || 80
  /** 尾部省略号/展开控件文案——判定「这份文案是被截断的」 */
  const ELL = /(?:[…\.]{2,}|。{3,}|【?\s*(?:更多|查看更多|全文|展开)\s*】?|>+)\s*$/

  const out: any[] = []
  let total = 0
  const blocked: string[] = []

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

  /**
   * v4.5 全称回收：从 title / data-* / 内层 span[title] 里找比可见文案更长的「真名」。
   * 返回 null 表示没有更长的全称（多数元素如此，零开销）。
   *
   * 背景（务必先读，否则容易把已修好的地方改坏）：
   * CSS `text-overflow: ellipsis` **不影响** `innerText`——它返回完整文本，省略号纯属渲染层效果。
   * 所以「CSS 省略号导致只拿到前几个字」在本项目不是问题；真正丢全称的是 **JS 截断**
   * （s.slice(0,10)+'…'，DOM 里就只剩半截）与 **SVG <text>**（innerText 在部分浏览器为 undefined），
   * 这两种情况全称只能从属性或 textContent 取。本函数针对的正是这两种。
   */
  function recoverFull(el: Element, visible: string): string {
    if (!visible) return ''
    // 先扫属性（getAttribute 极廉价），全部没命中才做一次 querySelector('[title]')——
    // 提取是每步都跑的全页遍历，内层查询放在兜底位而不是第一位
    const attrs: (string | null)[] = [
      el.getAttribute('title'),
      el.getAttribute('data-original'),
      el.getAttribute('data-full'),
      el.getAttribute('data-fulltext'),
      el.getAttribute('data-text'),
      el.getAttribute('data-name')
    ]
    for (const c of attrs) {
      const v = normText(c)
      if (v && v.length > visible.length) return v
    }
    try {
      const inner = el.querySelector('[title]')
      const v = inner ? normText(inner.getAttribute('title')) : ''
      if (v && v.length > visible.length) return v
    } catch {}
    return ''
  }

  /** 元素是否被 CSS 截断（内容比盒子宽 / 声明了 ellipsis / line-clamp）——只作提示标记 */
  function cssTruncated(el: Element): boolean {
    try {
      const h = el as HTMLElement
      const cs = getComputedStyle(h)
      if (cs.textOverflow === 'ellipsis') return true
      if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') return true
      if (h.clientWidth > 0 && h.scrollWidth > h.clientWidth + 2) return true
    } catch {}
    return false
  }

  function textOf(
    el: Element,
    role: string
  ): { text: string; fullText: string; truncatedBy: '' | 'css' | 'js' | 'svg'; extra: string } {
    let text = ''
    let extra = ''
    let fullText = ''
    let truncatedBy: '' | 'css' | 'js' | 'svg' = ''
    const t = el.tagName
    if (t === 'INPUT' || t === 'TEXTAREA') {
      const ph = normText(el.getAttribute('placeholder'))
      const val = normText((el as any).value)
      if (t === 'TEXTAREA') text = val.slice(0, CAP)
      else if ((el.getAttribute('type') || 'text') === 'password') text = val ? '(已输入密码)' : ''
      else text = val.slice(0, CAP)
      if (ph) extra += `placeholder=${ph.slice(0, CAP)}`
      // 关联 label
      let lab = ''
      let labFull = ''
      const id = el.getAttribute('id')
      if (id) {
        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (l) {
          lab = normText((l as HTMLElement).innerText)
          labFull = recoverFull(l, lab)
        }
      }
      if (!lab) {
        const p = el.closest('label')
        if (p) {
          lab = normText(p.innerText)
          labFull = recoverFull(p, lab)
        }
      }
      if (lab) {
        extra += (extra ? ' ' : '') + `label=${lab.slice(0, CAP)}`
        // v4.5：字段名被 JS 截断时，把 title 里的全称带出来（「收货人姓名…」→ 全称「收货人姓名（必填）」）
        if (labFull) {
          extra += `~全称:${labFull.slice(0, CAP)}`
          if (!fullText) {
            fullText = labFull
            truncatedBy = ELL.test(lab) ? 'js' : 'css'
          }
        }
      }
      const ck = el.getAttribute('type')
      if (ck === 'checkbox' || ck === 'radio') text = (el as any).checked ? '已勾选' : '未勾选'
    } else if (t === 'SELECT') {
      const sel = el as HTMLSelectElement
      const opt = sel.selectedOptions[0]
      text = normText(opt && opt.textContent).slice(0, CAP)
      extra = `${sel.options.length}个选项`
    } else if (t === 'IMG') {
      text = normText(el.getAttribute('alt'))
      extra = `图片${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`
    } else {
      // v4.5：innerText → textContent 兜底（SVG <text> 的 innerText 在部分浏览器为 undefined）
      let raw: string = ''
      try {
        raw = normText((el as HTMLElement).innerText)
      } catch {}
      if (!raw) {
        raw = normText(el.textContent)
        // SVG 命名空间下才认定为 svg 来源（HTML 元素 innerText 为空多半是真无文案）
        if (raw && el.namespaceURI && el.namespaceURI.indexOf('svg') !== -1) truncatedBy = 'svg'
      }
      text = raw.slice(0, CAP)
      // 全称回收：JS 截断（尾部真带省略号）优先级最高，其次 CSS 截断。
      // 顺序有意为之：先试 recoverFull（只读属性，零布局开销），拿不到全称时**才**调
      // cssTruncated（一次 getComputedStyle）。绝大多数元素到不了第二步——
      // 提取是每步都跑的全页遍历，每个元素多一次 getComputedStyle 在密集页上是实打实的成本。
      if (text) {
        const jsEll = ELL.test(raw)
        const full = recoverFull(el, raw)
        if (full) {
          fullText = full
          truncatedBy = jsEll ? 'js' : 'css'
        } else if (jsEll) {
          truncatedBy = 'js'
        } else if (cssTruncated(el)) {
          truncatedBy = 'css'
        }
      }
    }
    if (!text) {
      text = normText(el.getAttribute('aria-label')).slice(0, CAP)
      if (!text) text = normText(el.getAttribute('title')).slice(0, CAP)
    }
    if (t === 'A' && role === 'link') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript')) {
        const trimmed = href.length > 60 ? href.slice(0, 60) + '…' : href
        if (!text || text.length < 4) extra += (extra ? ' ' : '') + `href=${trimmed}`
      }
    }
    // S1 语义锚点①：属性锚点 name/id/autocomplete（表单字段的英文语义线索）
    const attrs = attrsOf(el)
    if (attrs) extra += (extra ? ' ' : '') + attrs
    // S1 语义锚点②：邻近文本（表格布局里 label 常在相邻 td、flex 表单里在前一个兄弟——
    // 老式 ERP 与现代表单里字段名的唯一线索）
    if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') {
      const adj = adjacentOf(el)
      if (adj.text) extra += (extra ? ' ' : '') + `adj=${adj.text}`
      // 邻近 label 被 JS 截断时，全称同样要落到候选自身的 fullText 上（不只是 extra 里）
      if (adj.full && !fullText) {
        fullText = adj.full
        truncatedBy = 'js'
      }
    }
    return { text: text.slice(0, CAP), fullText: fullText.slice(0, CAP), truncatedBy, extra: extra.slice(0, 200) }
  }

  /** 属性锚点：name / id / autocomplete（截断控噪声；id 与 name 相同不重复） */
  function attrsOf(el: Element): string {
    const bits: string[] = []
    const nm = normText(el.getAttribute('name'))
    const id = normText(el.getAttribute('id'))
    const ac = normText(el.getAttribute('autocomplete'))
    if (nm) bits.push(`name=${nm.slice(0, 24)}`)
    if (id && id !== nm) bits.push(`id=${id.slice(0, 24)}`)
    if (ac) bits.push(`ac=${ac.slice(0, 24)}`)
    return bits.join(' ')
  }

  /**
   * 邻近文本：表格布局里 label 在相邻 td（原仅存在于 testcase/fields.ts，主 extractor 缺失，
   * 导致聚水潭等老式 ERP 的字段在提示词里是空白元素）。
   * 优先取左侧单元格（label 通常在输入框左边，同行多字段时行文本会混淆语义）。
   */
  /**
   * 邻近文本：表格布局里 label 在相邻 td；flex 表单里 label 在前一个兄弟节点。
   * 返回 { text, full }：full 是从 title 回收的全称（JS 截断场景的字段名真身），
   * 调用方据此填充候选的 fullText/truncatedBy——此前全称只进了 extra 的拼接串，
   * 候选自身没有全称字段，模型按 adj= 里的全称去引用时匹配面反而更窄。
   */
  function adjacentOf(el: Element): { text: string; full: string } {
    const none = { text: '', full: '' }
    const from = (node: Element, raw: string): { text: string; full: string } => {
      const t = normText(raw)
      if (!t) return none
      const full = recoverFull(node, t)
      return { text: (full || t).slice(0, 40), full: full ? full.slice(0, 40) : '' }
    }
    try {
      const cell = el.closest('td,th')
      if (cell) {
        const prevCell = cell.previousElementSibling
        // 长度门槛从 12 放宽到 40：中文字段名（「详细的收货地址（门牌号必填）」）
        // 本来就超过 12 字，旧的 12 字门槛会把整张表单的字段名全部丢掉
        if (prevCell && !prevCell.querySelector('input,select,textarea')) {
          const t = normText(prevCell.textContent)
          if (t && t.length <= 40) return from(prevCell, t)
        }
        if (cell.parentElement) {
          const t = normText((cell.parentElement as HTMLElement).innerText)
          if (t) return { text: t.slice(0, 80), full: '' }
        }
      }
      const wrap = el.closest('.form-item,.form-group,.field,.ant-form-item,.el-form-item')
      if (wrap) return { text: normText((wrap as HTMLElement).innerText).slice(0, 80), full: '' }
      const prev = el.previousElementSibling
      if (prev && !/^(INPUT|SELECT|TEXTAREA)$/.test(prev.tagName)) {
        const t = normText((prev as HTMLElement).innerText)
        if (t && t.length <= 40) return from(prev, t)
      }
    } catch {}
    return none
  }

  /**
   * T5 容器锚点：从 el 向上找最近的稳定容器（tr/li/role=row·listitem/fieldset/卡片类），
   * 取与元素自身无关的首个非空短文本（≤24 字）——同名按钮靠行内订单号等上下文消歧。
   * 只取文本不取输入值；找不到合适容器返回 ''（调用方省略 anchor 字段，不落空串）。
   */
  function anchorOf(el: Element): string {
    const elText = normText((el as HTMLElement).innerText || el.textContent || '')
    // 合格文本：短（≤24）、去空白折叠后不含元素自身文本（单字标签防误杀只做等值剔除）
    const good = (t: string): boolean =>
      !!t && t.length <= 24 && t !== elText && (elText.length < 2 || t.indexOf(elText) === -1)
    // 来源剔除：候选块在元素子树内、或反过来包住元素（块级文本会混入自身文案）
    const tangled = (src: Element): boolean => src === el || el.contains(src) || src.contains(el)
    // 行容器：单元格短文本，非输入格与首/尾格优先（同行订单号是同名按钮的关键消歧信息）
    const rowText = (row: Element): string => {
      const cells = Array.from(row.children).filter(
        (c) =>
          /^(TD|TH)$/.test(c.tagName) ||
          /^(cell|gridcell|rowheader|columnheader)$/.test(c.getAttribute('role') || '')
      )
      const list = cells.length ? cells : Array.from(row.children)
      const rank = (c: Element): number =>
        (c.querySelector('input,select,textarea') ? 2 : 0) + (c === list[0] || c === list[list.length - 1] ? 0 : 1)
      const ranked = list.slice().sort((a, b) => rank(a) - rank(b)) // 稳定排序：同级保持左→右
      for (const c of ranked) {
        if (tangled(c)) continue
        const t = normText(c.textContent)
        if (good(t)) return t
      }
      return ''
    }
    // 卡片/列表类容器：首个标题性短文本（h1-h6/strong/标题 div）
    const headText = (box: Element): string => {
      const hs = box.querySelectorAll(
        'h1,h2,h3,h4,h5,h6,strong,[class*="title" i],[class*="heading" i],[class*="header" i]'
      )
      for (const h of Array.from(hs).slice(0, 12)) {
        if (tangled(h)) continue
        const t = normText(h.textContent)
        if (good(t)) return t
      }
      return ''
    }
    // 文本节点级首个短文本（li 等无标题结构的容器）；控件自身/兄弟控件的文案不算容器锚
    const firstText = (box: Element): string => {
      let w: TreeWalker
      try {
        w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
      } catch {
        return ''
      }
      let n: Node | null = w.nextNode()
      let seen = 0
      while (n && seen < 40) {
        seen++
        const p: Element | null = (n as any).parentElement
        const skip =
          !p ||
          el.contains(p) ||
          /^(SCRIPT|STYLE|OPTION|BUTTON|SELECT|TEXTAREA|SUMMARY)$/.test(p.tagName) ||
          !!p.closest('script,style,button,select,textarea,summary')
        if (!skip) {
          const t = normText(n.textContent)
          if (good(t)) return t
        }
        n = w.nextNode()
      }
      return ''
    }
    let cur: Element | null = parentOf(el)
    while (cur) {
      const tag = cur.tagName
      const role = (cur.getAttribute('role') || '').toLowerCase()
      const cls = typeof cur.className === 'string' ? cur.className : ''
      let t = ''
      if (tag === 'TR' || role === 'row') t = rowText(cur)
      else if (tag === 'FIELDSET') {
        const lg = cur.querySelector('legend')
        if (lg && !tangled(lg)) {
          const lt = normText(lg.textContent)
          if (good(lt)) t = lt
        }
      } else if (tag === 'LI' || role === 'listitem') t = headText(cur) || firstText(cur)
      else if (/card|item/i.test(cls)) t = headText(cur)
      if (t) return t
      cur = parentOf(cur)
    }
    return ''
  }

  /** 父元素（parentElement 不跨 shadow 边界：shadowRoot 直接子级经 getRootNode().host 向上） */
  function parentOf(el: Element): Element | null {
    const p = el.parentElement
    if (p) return p
    let root: any = null
    try {
      root = (el as any).getRootNode ? (el as any).getRootNode() : null
    } catch {}
    return root && root.host && root.host.nodeType === 1 ? root.host : null
  }

  /** el 在 root 元素子级中的序号（与 RESOLVE_FN 的 el.children[i] 对应） */
  function childIndexOf(root: any, el: Element): number {
    let idx = 0
    for (const c of Array.from(root.children)) {
      if (c === el) break
      idx++
    }
    return idx
  }

  /** 本文档内 children 索引路径；shadowRoot 直接子级处插入 -1 哨兵（进入 host 的 shadowRoot） */
  function indexPath(el: Element): number[] {
    const path: number[] = []
    let cur: Element | null = el
    while (cur && cur !== document.documentElement) {
      const parent: Element | null = cur.parentElement
      if (parent) {
        path.push(childIndexOf(parent, cur))
        cur = parent
        continue
      }
      // parentElement 为 null 可能是 shadowRoot 直接子级：先推 shadowRoot 内索引、
      // 再推 -1 哨兵，然后从 host 继续向上（getRootNode() 判定）
      let root: any = null
      try {
        root = (cur as any).getRootNode ? (cur as any).getRootNode() : null
      } catch {}
      if (!root || !root.host || root.host.nodeType !== 1) break
      path.push(childIndexOf(root, cur))
      path.push(-1)
      cur = root.host
    }
    return path.reverse()
  }

  /**
   * v4.5 结构签名：向上取 4 层的 **tag 名序列**（不含 children 索引）。
   * 用 tag 而非索引是关键——索引会随每步重排/虚拟滚动全变，tag 序列不会。
   */
  function structuralTags(el: Element): string {
    const parts: string[] = []
    let cur: Element | null = el
    for (let i = 0; i < 4 && cur && cur.tagName; i++) {
      parts.unshift(cur.tagName)
      cur = parentOf(cur)
    }
    return parts.join('/')
  }

  /**
   * v4.5 元素指纹（fp）：跨步骤稳定的元素身份。
   * 构成 = role | tag | 文案(fullText 优先) | anchor | name/placeholder/id | 结构 tag 序列
   * - 不含 children 索引路径 → 重排、虚拟滚动、分页后仍稳定
   * - 含 anchor → 表格里几十个同名「删除」按钮得到互不相同的 fp，天然消歧
   * - 含 name/placeholder/id → **空值输入框之间不再撞指纹**：一张表单里五个都没填值的
   *   input 的 role/tag/文案/结构完全相同，早期版本会算出同一个 fp，指纹反而帮了倒忙。
   *   这三个属性是表单里最稳定的语义线索，正是区分它们的关键。
   * 取 4 位十六进制：足够区分同页元素，又不撑大提示词
   */
  function fingerprintOf(el: Element, role: string, text: string, anchor: string): string {
    const s = [
      role,
      el.tagName,
      (text || '').slice(0, 40),
      (anchor || '').slice(0, 24),
      (el.getAttribute('name') || '').slice(0, 24),
      (el.getAttribute('placeholder') || '').slice(0, 24),
      (el.getAttribute('id') || '').slice(0, 24),
      structuralTags(el)
    ].join('|')
    let h = 0
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
    return (h >>> 0).toString(16).padStart(8, '0').slice(-4)
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

  /** 扫描根（文档或 shadowRoot）的可交互元素（querySelectorAll 不穿透 shadow 边界） */
  function scanRoot(root: Document | ShadowRoot, framePaths: number[][], offX: number, offY: number): void {
    let list: Element[]
    try {
      list = Array.from(root.querySelectorAll(SEL))
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
      // W4：禁用元素不再静默过滤——带 (disabled) 状态入列，模型看得见才能绕开/等它恢复；
      // 执行层仍有实时禁用复核兜底（点了会明确报错）。排名适度降权（可交互优先）
      const dis = (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'
      const v = visible(el, offX, offY)
      if (!v.ok) continue
      // 视口下方太远的元素不进列表（可滚动后再提取），按顶层绝对坐标判断；
      // S1 放宽 4→8 屏：大表单页目标常在第 5-8 屏，太窄会导致"必须滚动"往返浪费步数
      if (v.rect.top + offY > window.innerHeight * 8) continue
      const role = roleOf(el)
      const { text, fullText, truncatedBy, extra } = textOf(el, role)
      let score = 0
      if (v.inVp) score += 100
      if (/input|select|可编辑/.test(role)) score += 20
      else if (role === 'button') score += 15
      else if (role === 'link') score += 10
      else score += 5
      score += Math.min(text.length, 40) / 4
      if (v.occluded) score -= 60
      if (dis) score -= 20
      const anchor = anchorOf(el)
      if (query && !(text + ' ' + (fullText || '') + ' ' + extra + ' ' + (anchor || '')).toLowerCase().includes(query.toLowerCase())) continue
      total++
      const item: any = {
        framePaths,
        path: indexPath(el),
        tag: el.tagName,
        role,
        text,
        extra,
        // v4.5 元素指纹：跨步骤稳定（不含 children 索引路径），供模型跨步引用与同名消歧
        fp: fingerprintOf(el, role, fullText || text, anchor),
        rect: {
          x: Math.round(v.rect.left + offX),
          y: Math.round(v.rect.top + offY),
          w: Math.round(v.rect.width),
          h: Math.round(v.rect.height)
        },
        inViewport: v.inVp,
        _score: score
      }
      // v4.5 全称与截断来源：JS 截断 / SVG 场景下把全称单独带出来（模型引用任一种说法都能匹配上）
      if (fullText && fullText !== text) item.fullText = fullText
      if (truncatedBy) item.truncatedBy = truncatedBy
      // T5 容器锚点：有锚容器才带字段（不落空串）；不进提示词，只供重定位链消歧用
      if (anchor) item.anchor = anchor
      // W4 state 行内：禁用态从 DOM 实时判定（AX 树的 checked/expanded 由 annotateWithAx 补写）
      if (dis) item.state = 'disabled'
      out.push(item)
    }
  }

  function collect(doc: Document, framePaths: number[][], fdepth: number, offX: number, offY: number): void {
    scanRoot(doc, framePaths, offX, offY)
    // T6 shadow DOM 穿透（复用 EXTRACT_IMAGES_FN 的 shadow 栈递归模式）：
    // querySelectorAll 看不见 shadowRoot 内元素；shadow 内元素的 getBoundingClientRect
    // 已是视口坐标，不累加偏移；shadow 深度 ≤3（v4.4 与 iframe 预算解耦，各自独立），
    // host 栈去重防环。shadowDom=false（W5 回滚开关）时整体跳过
    if (shadow !== false) {
      try {
        const stack: { root: Document | ShadowRoot; d: number; hosts: Element[] }[] = [
          { root: doc, d: 0, hosts: [] }
        ]
        let visited = 0
        while (stack.length && visited < 60) {
          const top = stack.pop()!
          let els: Element[] = []
          try {
            els = Array.from(top.root.querySelectorAll('*'))
          } catch {
            continue
          }
          for (const el of els) {
            const sr = (el as any).shadowRoot
            if (!sr || top.hosts.indexOf(el) !== -1) continue
            visited++
            if (top.d >= 3) continue // shadow 深度到顶：只收不下沉
            scanRoot(sr, framePaths, offX, offY)
            stack.push({ root: sr, d: top.d + 1, hosts: top.hosts.concat(el) })
          }
        }
      } catch {}
    }
    // 递归穿透同源 iframe（聚水潭等老式布局必需）：v4.4 深度预算 3→5 且与 shadow 解耦——
    // 老式 ERP 的报表/编辑器常嵌到 3~4 层，越界整棵子树静默丢失
    if (fdepth < 5) {
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
        if (!cd || !cd.body) {
          // W5 一期「探测 + 告知」（OOPIF/跨域）：contentDocument 不可读 = 跨域挡住，
          // 记录 src 供元素列表尾部注明（v4.4 起 frameAccess 层会兜底读取跨域 frame）
          const src = f.getAttribute('src') || ''
          if (src && blocked.length < 5) blocked.push(src.slice(0, 100))
          continue
        }
        // iframe 内元素的坐标逐层累加，换算为顶层视口绝对坐标（与截图对齐）
        const fr = f.getBoundingClientRect()
        collect(cd, [...framePaths, indexPath(f)], fdepth + 1, offX + fr.left, offY + fr.top)
      }
    }
  }

  collect(document, [], 0, 0, 0)
  // canvas 编辑器检测（改进 WPS 写入任务根因 1）：大尺寸 canvas 覆盖视口 ≥25% 视为 canvas 文档编辑器——
  // 正文与光标不在 DOM 里（提取恒只见工具栏），需要专用写入通道（paste_rich）与坐标点击
  let canvasArea = 0
  try {
    for (const cv of Array.from(document.querySelectorAll('canvas'))) {
      const r = cv.getBoundingClientRect()
      if (r.width > 100 && r.height > 100) canvasArea += r.width * r.height
    }
  } catch {}
  const canvasEditor = canvasArea >= window.innerWidth * window.innerHeight * 0.25
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
    imgCount: document.images ? document.images.length : 0,
    blockedFrames: blocked,
    canvasEditor
  }
})

/** 根据提取结果生成给模型的精简文本行；withCoords 时为视口内元素追加截图归一化坐标 @x,y（0~1000）。
 *  keepIdx（S6 本地初筛）：仅渲染这些原始编号的元素（编号保持不变——快照与动作按原始编号解析），
 *  缺省 = 渲染前 limit 个（与历史行为逐字节一致）。
 *  v4.6 C4 gridMode（纯文本模式的粗网格坐标粒度）：edges=仅列表首尾各 8 行保留（页头导航/底部
 *  翻页这类高频空间指代不丢，中间表单区省掉 ~70% 网格开销）；all=每行（v4.5 行为）；off=不输出。
 *  v4.6 C3 detail：full=全字段（v4.5 行为）；summary=裁掉 全称/截断标记/行锚/extra（fp/state/网格/
 *  滚动标记保留）——语义命中行与视口前 8 行仍保留全字段兜底（截断文案匹配与密集页行定位不退化）。
 *  detail/gridMode 缺省时输出与 v4.5 逐字节一致。 */
export function formatCandidates(
  res: ExtractResult,
  withCoords = false,
  keepIdx?: number[],
  gridMode: 'edges' | 'all' | 'off' = 'all',
  detail: 'full' | 'summary' = 'full'
): string {
  if (!res.candidates.length) return '（页面上没有发现可交互元素）'
  const vw = res.viewportW || 0
  const vh = res.viewportH || 0
  const keep = keepIdx ? new Set(keepIdx) : null
  const lines: string[] = []
  /** 同文本 → 编号（密集页同名按钮歧义警示用） */
  const byText = new Map<string, number[]>()
  // C3：summary 档的「全字段保留集」——语义命中行 + 视口内前 8 行（密集页/视觉兜底由 runner 判定走 full）
  const richIdx = new Set<number>()
  if (detail === 'summary') {
    for (const h of res.semanticHints || []) if (typeof h.index === 'number') richIdx.add(h.index)
    let vp = 0
    for (let i = 0; i < res.candidates.length && vp < 8; i++) {
      if (res.candidates[i].inViewport) {
        richIdx.add(i)
        vp++
      }
    }
  }
  // C4：edges 模式下的总渲染行数（keep 时=keep 大小，否则=候选总数）
  const totalEmit = keep ? Math.min(keep.size, res.candidates.length) : res.candidates.length
  let emitted = 0
  res.candidates.forEach((c, i) => {
    if (keep && !keep.has(i)) return
    if (emitted >= (keep ? Math.max(keep.size, 0) : res.candidates.length)) return
    emitted++
    const parts = [`[${i}] <${c.role}>`]
    if (c.text) parts.push(`"${c.text}"`)
    const rich = detail !== 'summary' || richIdx.has(i)
    // v4.5 全称 + 截断标记：模型从截图上抄到的可能是「收货人姓名…」，DOM 全称可能是
    // 「收货人姓名（必填）」——两种说法系统都能匹配上，这里把全称显式给出，让模型不必猜
    if (rich && c.fullText && c.fullText !== c.text) parts.push(`~全称:"${c.fullText}"`)
    if (rich && c.truncatedBy)
      parts.push(`(${c.truncatedBy === 'js' ? '文案被截断' : c.truncatedBy === 'svg' ? 'SVG渲染' : 'CSS截断'})`)
    // v4.4 行身份上下文：容器锚点（表格行单号/列表标题等）进提示词——
    // 密集页几十个同名「编辑/删除」按钮，模型要能用「哪一行」精确指定（expect_text 核验依据）
    if (rich && c.anchor) parts.push(`(行:${c.anchor})`)
    // v4.5 元素指纹：跨步骤稳定编号（页面重排后编号会变，fp 不变）——模型可写 {"name":"click","fp":"xxxx"}
    if (c.fp) parts.push(`#${c.fp}`)
    if (rich && c.extra) parts.push(`(${c.extra})`)
    // W4 state 行内（如 `(disabled)`）：模型可据此避免点死按钮/识别展开态（编号与文案格式不变，纯后缀）
    if (c.state) parts.push(`(${c.state})`)
    if (withCoords && c.inViewport && vw > 0 && vh > 0) {
      const nx = Math.round(((c.rect.x + c.rect.w / 2) / vw) * 1000)
      const ny = Math.round(((c.rect.y + c.rect.h / 2) / vh) * 1000)
      parts.push(`@${Math.max(0, Math.min(1000, nx))},${Math.max(0, Math.min(1000, ny))}`)
    } else if (gridMode !== 'off' && c.inViewport && vw > 0 && vh > 0) {
      // v4/A4：纯文本模式补粗粒度位置（8×6 网格，行列从 0 起）——「顶部菜单/底部下一页/中部表单」
      // 这类空间指代可落地；v4.6 C4：edges 模式仅保留列表首尾各 8 行（页头导航/底部翻页），中间省 token
      const edgeOk =
        gridMode === 'all' || emitted <= 8 || emitted > Math.max(0, totalEmit - 8) || richIdx.has(i)
      if (edgeOk) {
        const gx = Math.max(0, Math.min(7, Math.floor(((c.rect.x + c.rect.w / 2) / vw) * 8)))
        const gy = Math.max(0, Math.min(5, Math.floor(((c.rect.y + c.rect.h / 2) / vh) * 6)))
        parts.push(`(格${gx},${gy})`)
      }
    }
    if (!c.inViewport) parts.push('(需滚动到)')
    if (c.text) {
      const key = c.text.replace(/\s+/g, ' ').trim()
      const arr = byText.get(key) || []
      arr.push(i)
      byText.set(key, arr)
    }
    lines.push(parts.join(' '))
  })
  // v4.4 同名歧义警示：≥2 个同文本候选（密集页行操作场景）——提示用行标识区分 + expect_text 核验
  const dups = [...byText.entries()].filter(([, idx]) => idx.length >= 2).slice(0, 4)
  if (dups.length) {
    const dupLines = dups
      .map(([txt, idx]) => `  "${txt.slice(0, 16)}" ×${idx.length}：[${idx.slice(0, 6).join('][')}]`)
      .join('\n')
    lines.push(
      `⚠ 同名元素（密集页注意：点错行是重大失误）：\n${dupLines}\n  这些元素仅靠行标识区分：click 时必须带 "expect_text"，内容=目标的 (行:…) 标识 + 按钮文字（如 "SO20261012-001 删除"），系统会核验不符不点`
    )
  }
  // W5 一期「探测 + 告知」：跨域 iframe 内元素不可见——明确告知模型与用户，别盲目找
  if (res.blockedFrames?.length) {
    lines.push(
      `⚠ 检测到 ${res.blockedFrames.length} 个跨域 iframe（${res.blockedFrames.slice(0, 3).join('、')}${res.blockedFrames.length > 3 ? '…' : ''}），其中元素暂不可见；如需操作其中内容请开启视觉模式（截图看图定位）或人工处理`
    )
  }
  // canvas 文档编辑器指南（WPS 写入任务根因修复）：正文/光标不在元素列表，给出唯一可行的写入与定位通道
  if (res.canvasEditor) {
    lines.push(
      'ℹ 本页正文为 canvas 渲染的文档编辑器（WPS/金山文档/腾讯文档等）：上面的元素列表只有工具栏等页面控件，文档正文与光标【不在列表里，也永远搜不到】。正确做法：\n' +
        '  - 写入正文：用 {"name":"paste_rich","text":"Markdown内容"}（在当前光标处粘贴，无需 index，支持标题/列表/加粗）或 {"name":"paste_image","url":"…"}（嵌入图片，无需 index）\n' +
        '  - 移动光标/点击正文：用 {"name":"click_xy","x":…,"y":…}（本页允许坐标点击，x/y 为视口归一化 0~1000，点正文区域约 x:300~700,y:200~600）\n' +
        '  - 禁止对正文使用 type/点击工具栏按钮找正文；粘贴前若不确定光标位置，先 click_xy 点正文再粘贴'
    )
  }
  // S1 语义匹配提示段：rerankByTask 命中项及理由（缺省不渲染——输出与历史逐字节一致）
  if (res.semanticHints?.length) {
    const hintLines = res.semanticHints
      .slice(0, 6)
      .map(
        (h) =>
          `  [${h.index}] ${(h.text || '').slice(0, 24)} — ${h.via.slice(0, 2).join('/') || '相关'} (相似度 ${Math.round(h.score * 100)}%)`
      )
    lines.push(
      `\n# 语义匹配提示（下列元素与任务描述语义相关，已排在前面，优先从中选择）\n${hintLines.join('\n')}\n注意：以上提示基于字面与同义词推断，仅供参考；仍需结合 role 与实际语义确认。`
    )
  }
  return lines.join('\n')
}

/**
 * v4.6 A3/B3 页面指纹：URL+标题+滚动位+候选要素的 FNV-1a（8 位 hex）。
 * 用途：① extract 埋点（观测稳定性度量）② B3 页面未变时省略元素列表（免观测降级）。
 * 确定性纯函数：同输入同哈希；候选顺序变化会改变哈希（刻意保守——顺序变了说明页面可能重排）。
 */
export function pageHashOf(e: {
  url?: string
  title?: string
  scrollY?: number
  scrollHeight?: number
  candidates: Array<{ role?: string; text?: string; extra?: string; state?: string }>
}): string {
  let h = 0x811c9dc5
  const s =
    `${e.url || ''}|${e.title || ''}|${Number(e.scrollY) || 0}/${Number(e.scrollHeight) || 0}|` +
    (e.candidates || []).map((c) => `${c.role || ''}|${c.text || ''}|${c.extra || ''}|${c.state || ''}`).join('\n')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * S1 语义重排：语义分 ≥0.5 的 Top-N（topBoost 个，v4/A6 修订——此前全部 ≥0.5 都提前，
 * 常见词如「订单/确定」会把一堆无关元素提到前面挤掉视口内主操作）显著提前，其余保持原序。
 * 必须在 executor 快照落盘前调用（编号即最终编号）；填充 semanticHints（Top-6 命中项及理由）。
 */
export function rerankByTask(res: ExtractResult, task: string, topBoost = 8): ExtractResult {
  if (!task || !res.candidates.length) return res
  const scored = res.candidates.map((c) => ({
    c,
    sem: scoreCandidate({ text: c.text, extra: c.extra, role: c.role, tag: c.tag, anchor: c.anchor }, task).score
  }))
  const boostedAll: typeof scored = []
  const rest: typeof scored = []
  for (const s of scored) (s.sem >= 0.5 ? boostedAll : rest).push(s)
  if (!boostedAll.length) return res
  boostedAll.sort((a, b) => b.sem - a.sem)
  // A6：只提前 topBoost 个（默认 8），其余高分项回到原位——重排是「提示」不是「洗牌」
  const boostedSet = new Set(boostedAll.slice(0, Math.max(1, topBoost)).map((s) => s.c))
  const boosted = boostedAll.slice(0, Math.max(1, topBoost))
  const restAll = [...scored.filter((s) => !boostedSet.has(s.c))]
  const merged = [...boosted, ...restAll]
  const out: ExtractResult = { ...res, candidates: merged.map((s) => s.c) }
  const hints: SemanticHint[] = []
  merged.forEach((s, i) => {
    if (s.sem >= 0.5 && hints.length < 6) {
      hints.push({ index: i, text: s.c.text || s.c.extra.slice(0, 24), via: matchedViaOf(s.c, task), score: s.sem })
    }
  })
  out.semanticHints = hints
  return out
}

function matchedViaOf(c: Candidate, task: string): string[] {
  return scoreCandidate({ text: c.text, extra: c.extra, role: c.role, tag: c.tag, anchor: c.anchor }, task).matchedVia
}

/** 在页面上下文中按 framePaths+path 定位元素，返回页面绝对坐标（供 CDP 点击）。
 *  v4.2：额外回传元素可见文本（innerText/aria-label/value）——上层用于「path 命中但
 *  解析到了错误兄弟元素」的文本校验（SPA 重渲染后 children 序号仍有效但指向变了）。
 *  v4.5：文案截断上限改为与 EXTRACT_FN 共用 TEXT_CAP（此前快照 80 / 回读 40 的不对称
 *  会让同一元素在两条链路上长度不同，配合来源差异误判失败并触发全页重提取）；
 *  同时回传 title 全称，供上层做截断感知的文本比较。 */
export const RESOLVE_FN = String(function resolve(
  framePaths: number[][],
  path: number[],
  expectTag?: string,
  /** v4.4 命中校验：解析后在元素自身坐标空间做 elementFromPoint 身份核验——
   *  中心点被遮挡时改试矩形内缩点（返回可命中点坐标）；全部被遮挡返回 occluded:true。
   *  身份比较（元素同一/互相包含/shadow 宿主链）不依赖 tag/text，图标按钮/自定义元素都稳。 */
  verify?: boolean,
  cap?: number
) {
  function walk(doc: Document, p: number[]): Element | null {
    let el: any = doc.documentElement
    for (const i of p) {
      if (i === -1) {
        // -1 哨兵：进入当前元素的 shadowRoot（不存在视为定位失败）
        el = el.shadowRoot
        if (!el) return null
        continue
      }
      const next = el.children[i]
      if (!next) return null
      el = next
    }
    return el as Element
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
    // behavior:'instant' 强制瞬时滚动（无视页面 CSS scroll-behavior:smooth）——
    // 读 rect 不会拿到动画中途坐标，也无需任何 rAF/定时器等待（页面隐藏/窗口被遮挡时
    // Chromium 会深度节流 rAF 与定时器，此前的等待会让每个 evaluate 挂满 CDP 20s 超时）
    ;(el as any).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
  } catch {}
  const r = el.getBoundingClientRect()
  const tag = el.tagName
  // v4.4 命中校验（与解析同坐标空间、同文档，元素身份比对）：
  // 中心 → 矩形内缩点逐个试，第一个能命中目标（或其子/宿主）的点就是点击点
  let px = r.left + r.width / 2
  let py = r.top + r.height / 2
  if (verify) {
    const rel = (hit: Element | null): boolean => {
      if (!hit) return false
      if (hit === el || el.contains(hit) || hit.contains(el)) return true
      // shadow 边界：elementFromPoint 命中会被重定向到宿主——沿宿主链认亲
      let cur: any = el
      for (let i = 0; i < 6; i++) {
        let root: any = null
        try {
          root = cur.getRootNode ? cur.getRootNode() : null
        } catch {}
        const host = root && root.host
        if (!host) break
        if (host === hit || host.contains(hit) || hit.contains(host)) return true
        cur = host
      }
      return false
    }
    const pts: Array<[number, number]> = [
      [px, py],
      [r.left + r.width * 0.25, r.top + r.height * 0.25],
      [r.left + r.width * 0.75, r.top + r.height * 0.25],
      [r.left + r.width * 0.25, r.top + r.height * 0.75],
      [r.left + r.width * 0.75, r.top + r.height * 0.75],
      [r.left + r.width * 0.5, r.top + r.height * 0.2],
      [r.left + r.width * 0.5, r.top + r.height * 0.8]
    ]
    let hitPoint: [number, number] | null = null
    for (const [lx, ly] of pts) {
      if (lx < 0 || ly < 0 || lx > window.innerWidth || ly > window.innerHeight) continue
      let hit: Element | null = null
      try {
        hit = doc.elementFromPoint(lx, ly)
      } catch {}
      if (rel(hit)) {
        hitPoint = [lx, ly]
        break
      }
    }
    if (!hitPoint) {
      return { found: true, occluded: true, tag, w: Math.round(r.width), h: Math.round(r.height) }
    }
    px = hitPoint[0]
    py = hitPoint[1]
  }
  let x = px
  let y = py
  // 逐层加上祖先 iframe 的偏移，换算为顶层页面坐标
  for (let i = chain.length - 1; i >= 0; i--) {
    const ir = chain[i].iframe.getBoundingClientRect()
    x += ir.left
    y += ir.top
  }
  const editable =
    tag === 'INPUT' || tag === 'TEXTAREA' || el.getAttribute('contenteditable') === 'true'
  const value =
    tag === 'INPUT' || tag === 'TEXTAREA' ? String((el as any).value || '') : ''
  // 执行前实时属性复核：重读 disabled / checked（aria 兜底，供执行侧拦截禁用态/复核勾选态）
  const any = el as any
  const disabled = any.disabled === true || el.getAttribute('aria-disabled') === 'true'
  const ariaChecked = el.getAttribute('aria-checked')
  let checked: boolean | undefined
  if (any.checked !== undefined && any.checked !== null) checked = any.checked === true
  else if (ariaChecked !== null) checked = ariaChecked === 'true'
  // v4.2 文本回传：供上层校验「path 解析到的元素」与快照候选是否同一个。
  // v4.5：截断上限与 EXTRACT_FN 共用；并额外回收 title 全称（JS 截断场景的文案真身）
  const CAP = cap || 80
  const txt = String(
    (el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || ''
  )
    .replace(/\s+/g, ' ')
    .trim()
  let full = ''
  try {
    const cands = [
      el.getAttribute('title'),
      el.getAttribute('data-original'),
      el.getAttribute('data-full'),
      el.getAttribute('data-fulltext'),
      el.getAttribute('data-text'),
      el.getAttribute('data-name')
    ]
    const inner = el.querySelector('[title]')
    if (inner) cands.push(inner.getAttribute('title'))
    for (const c of cands) {
      const v = String(c || '').replace(/\s+/g, ' ').trim()
      if (v && v.length > txt.length) {
        full = v
        break
      }
    }
  } catch {}
  return {
    found: true,
    x: Math.round(x * 100) / 100,
    y: Math.round(y * 100) / 100,
    tag,
    editable,
    value: value.slice(0, 100),
    w: Math.round(r.width),
    h: Math.round(r.height),
    disabled,
    checked,
    text: txt.slice(0, CAP),
    ...(full && full !== txt ? { fullText: full.slice(0, CAP) } : {})
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
  // v4.4 跨 iframe 全穿透（同源嵌套）：正文与表格逐层递归收集——聚水潭等嵌套布局的数据
  // 常在二层及更深的 iframe 里，此前「顶层正文 + 一层表格」是数据抓取的直接盲区。
  const parts: string[] = []
  const tables: string[] = []
  const visited: Document[] = []
  function gather(doc: Document, depth: number): void {
    if (depth > 5 || visited.indexOf(doc) !== -1) return
    visited.push(doc)
    let body = ''
    try {
      body = (doc.body?.innerText || '').replace(/\n{3,}/g, '\n\n').trim()
    } catch {}
    if (body) parts.push(depth === 0 ? body : `[iframe${depth > 1 ? '·嵌套' + depth + '层' : ''}区域]\n${body}`)
    tables.push(...tablesIn(doc))
    let iframes: Element[] = []
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
      // 跨域 frame 本层不可读（B 期 frameAccess 兜底），同源嵌套逐层下沉
      if (!cd || !cd.body) continue
      gather(cd, depth + 1)
    }
  }
  gather(document, 0)
  let text = parts.join('\n\n')
  if (tables.length) text += (text ? '\n\n' : '') + '# 页面表格\n' + tables.join('\n\n')
  if (text.length > maxChars) {
    const head = Math.floor(maxChars * 0.65)
    text = text.slice(0, head) + '\n…(中间省略)…\n' + text.slice(text.length - Math.floor(maxChars * 0.35))
  }
  let imgs = 0
  try {
    imgs = document.images.length
  } catch {}
  return { title: document.title, url: location.href, text, bodyLen: text.length, imgs }
})

/** 验证码 / 登录摩擦检测 */
/**
 * 抓取页面图片资源（主图/详情图等），三个来源合并：
 * ① DOM 扫描：img（含懒加载属性与 srcset）+ CSS 背景图 + video 封面 + shadow DOM/iframe 穿透
 * ② 网络资源嗅探（仿「图片助手」插件）：Performance Resource Timing 里页面加载过的全部图片资源——
 *    覆盖 XHR 动态加载/预加载/CSS 图等 DOM 里没有对应 <img> 的场景；新 URL 用 new Image() 实测像素尺寸
 * ③ 源码级兜底：前两者零命中时直接扫页面源码文本里的图片 URL
 * 变体归并（alicdn 多档缩略同图）后按尺寸排序，过滤小图标；主图/详情图的对应关系交给 AI 判断
 */
export const EXTRACT_IMAGES_FN = String(async function extractImages(limit: number) {
  const seen = new Set<string>()
  const items: { url: string; w: number; h: number; alt: string; kind: string }[] = []
  const IMG_EXT = /\.(?:jpe?g|png|webp|gif|bmp|avif)(?:[?#_][^\s"'()<>]{0,120})?$/i
  function push(url: string, w: number, h: number, alt: string, kind: string) {
    url = String(url || '').trim()
    // alicdn 等 CDN 的 webp 变体（xxx.jpg_.webp）：优先给原图格式链接，少一层解码/下载变数
    url = url.replace(/(\.(?:jpe?g|png))_\.?webp($|\?)/i, '$1$2')
    if (!url || url === 'about:blank') return
    if (seen.has(url)) return
    if (w > 0 && h > 0 && w < 24 && h < 24) return // 埋点/小图标
    if (w > 0 && h > 0 && w < 40 && h < 40 && /\.svg(\?|$)/i.test(url)) return // 小 svg 图标
    seen.add(url)
    items.push({ url: url.slice(0, 400), w: Math.round(w), h: Math.round(h), alt: (alt || '').slice(0, 40), kind })
  }
  // 变体归并键：同一张图的多档缩略（xxx_800x800.jpg / xxx_430x430q90.jpg / xxx.jpg_.webp）视为一张
  function variantKey(u: string): string {
    return u
      .replace(/_(?:\d{2,4}x\d{2,4}[a-z0-9]*|\.?webp)?(?=\.(?:jpe?g|png)(?:[?#_]|$))/i, '')
      .replace(/[?#].*$/, '')
  }
  // 懒加载属性变体（各家站点命名不一）
  const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazyload', 'data-echo', 'data-url']
  function collectImgs(root: Document | ShadowRoot) {
    let imgs: Element[] = []
    try {
      imgs = Array.from(root.querySelectorAll('img'))
    } catch {
      return
    }
    for (const el of imgs) {
      const r = el.getBoundingClientRect()
      const im = el as HTMLImageElement
      let best: string = im.currentSrc || im.src || ''
      if (!best || /^data:image\/.*(gif|1x1)/i.test(best)) {
        for (const attr of LAZY_ATTRS) {
          const v = el.getAttribute(attr)
          if (v) { best = v; break }
        }
      }
      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset') || ''
      if (srcset) {
        const parts = srcset.split(',').map(function (s) { return s.trim().split(/\s+/)[0] }).filter(Boolean)
        if (parts.length) best = parts[parts.length - 1] // 最后一档通常最大
      }
      push(best, r.width || im.naturalWidth || 0, r.height || im.naturalHeight || 0, el.getAttribute('alt') || el.getAttribute('title') || '', 'img')
    }
    // video 封面
    let vids: Element[] = []
    try {
      vids = Array.from(root.querySelectorAll('video[poster]'))
    } catch {}
    for (const el of vids) {
      const r = el.getBoundingClientRect()
      push(el.getAttribute('poster') || '', r.width, r.height, el.getAttribute('title') || '', 'poster')
    }
  }
  function scanBg(root: Document | ShadowRoot) {
    let all: Element[] = []
    try {
      all = Array.from(root.querySelectorAll('*'))
    } catch { return }
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
  function scan(doc: Document) {
    collectImgs(doc)
    scanBg(doc)
    // shadow DOM 穿透（淘宝/天猫等大量 web component，img 常挂在 shadow root 里，querySelectorAll 看不见）
    try {
      const stack: (Document | ShadowRoot)[] = [doc]
      let visited = 0
      while (stack.length && visited < 60) {
        const d = stack.pop()!
        let els: Element[] = []
        try {
          els = Array.from(d.querySelectorAll('*'))
        } catch { continue }
        for (const el of els) {
          const sr = (el as any).shadowRoot
          if (sr) {
            visited++
            collectImgs(sr)
            scanBg(sr)
            stack.push(sr)
          }
        }
      }
    } catch {}
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

  // —— 源2：网络资源嗅探（仿「图片助手」插件）——
  // Performance Resource Timing 记录了页面加载过的全部资源（含 XHR 动态加载/预加载/CSS 图），
  // DOM 里未必有对应 <img>；这里把其中图片类的 URL 收齐，DOM 没见过的用 new Image() 实测尺寸
  try {
    const perfUrls: string[] = []
    function perfOf(p: any) {
      if (!p || !p.getEntriesByType) return
      let es: any[] = []
      try {
        es = p.getEntriesByType('resource')
      } catch {
        return
      }
      for (const e of es) {
        const u = String(e && e.name ? e.name : '')
        if (!u || seen.has(u)) continue
        if (/^(?:data|blob):/i.test(u)) continue
        const init = String((e as any).initiatorType || '')
        const isImgInit = init === 'img' || init === 'image'
        // img 发起的必然是图；其余来源要求扩展名像图片（fetch/XHR 拉的 JSON 不入列）
        if (isImgInit || ((init === 'css' || init === 'link' || init === 'other' || init === '') && IMG_EXT.test(u))) {
          perfUrls.push(u)
        }
      }
    }
    perfOf(performance)
    for (const f of frames) {
      try {
        perfOf(f.contentWindow && f.contentWindow.performance)
      } catch {}
    }
    const uniq = Array.from(new Set(perfUrls)).slice(0, 40)
    if (uniq.length) {
      // 尺寸探测预算：最多 24 张 / 总 5s / 单张 3s；预算耗尽的 URL 不探测直接入列（尺寸未知）
      const deadline = Date.now() + 5000
      let probed = 0
      for (const u of uniq) {
        if (probed >= 24 || Date.now() > deadline) {
          push(u, 0, 0, '', 'net')
          continue
        }
        probed++
        const sz = await new Promise<{ w: number; h: number }>(function (res) {
          const im = new Image()
          let settled = false
          const done = function (w: number, h: number) {
            if (settled) return
            settled = true
            res({ w: w, h: h })
          }
          const timer = setTimeout(function () {
            done(0, 0)
          }, 3000)
          im.onload = function () {
            clearTimeout(timer)
            done(im.naturalWidth || 0, im.naturalHeight || 0)
          }
          im.onerror = function () {
            clearTimeout(timer)
            done(0, 0)
          }
          im.src = u
        })
        push(u, sz.w, sz.h, '', 'net')
      }
    }
  } catch {}

  // 源码级兜底：DOM 与网络嗅探一个图片都没抓到时，直接在页面源码文本里扫图片 URL
  // （覆盖：图片 URL 藏在 script/模板字符串/自定义属性里，或 shadow DOM 未开放等场景）
  if (!items.length) {
    try {
      const html = document.documentElement.outerHTML
      const re = /https?:\/\/[^\s"'()<>]{8,400}\.(?:jpe?g|png|webp|gif)(?:[?_][^\s"'()<>]{0,80})?/gi
      const hits = html.match(re) || []
      const uniq = Array.from(new Set(hits))
      for (const u of uniq.slice(0, limit)) push(u, 1, 1, '', 'src')
    } catch {}
  }

  // 变体归并：同一 variantKey 只保留尺寸最大的一张（主图 800x800 盖掉 60x60 缩略）
  const best = new Map<string, { url: string; w: number; h: number; alt: string; kind: string }>()
  for (const it of items) {
    const k = variantKey(it.url)
    const cur = best.get(k)
    if (!cur || it.w * it.h > cur.w * cur.h) best.set(k, it)
  }
  const merged = Array.from(best.values())
  merged.sort(function (a, b) {
    return b.w * b.h - a.w * a.h
  })
  const list = merged.slice(0, limit)
  if (!list.length) return '页面上没有抓到图片资源（可尝试先 scroll 到图片区域再抓取）'
  const KIND_LABEL: Record<string, string> = { bg: '背景图', poster: '视频封面', src: '源码', net: '网络嗅探' }
  return (
    `共发现 ${merged.length} 张图片（DOM+网络嗅探合并去重，按尺寸从大到小，小图标已过滤）。\n` +
      `判断对应关系：通常最大方形图=商品主图，h 远大于 w 的长图/imgextra·detail 域名/连续编号=详情图与规格图；网络嗅探项是页面加载过的真实资源。\n` +
      list
        .map(function (it, i) {
          const sz = (it.w || 0) + 'x' + (it.h || 0)
          return `[${i + 1}] ${sz === '0x0' ? '未知尺寸' : sz} ${KIND_LABEL[it.kind] || 'img'}${it.alt ? ' alt=' + it.alt : ''}\n${it.url}`
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
  let warnHit = false
  try {
    const t = (document.body?.innerText || '').slice(0, 3000)
    textHit = /拖动滑块|按住滑块|拖动到最右|滑动验证|请完成.{0,6}(验证|拼图)|安全验证|图形验证码/.test(t)
    loginHint = /亲，请登录|扫码登录|请先登录|登录后.{0,8}(查看|操作)/.test(t)
    // R3-D warn 级：限流/访问受限（未到硬拦截程度，退避放慢而非暂停）
    warnHit = /操作过于频繁|访问过于频繁|请求过多|稍后再试|尝试的次数过多|访问受限|禁止访问|访问被拒绝|太多请求/.test(t)
  } catch {}
  return { urlHit, hitSel, textHit, loginHint, warnHit, url }
})
