/**
 * 智能表单填充的字段层：DOM 深提取（FORM_FIELDS_FN）+ select/checkbox 设置（FORM_SET_FN）
 * + LLM 字段规划契约（planFormFill 的输入输出类型与本地校验）。
 *
 * 设计原则：LLM 只产出「字段→值」映射（含理由），实际填充全部走 executor 的确定性管线
 * （真实键入→回读验证→原生 setter 兜底），填充质量有硬校验兜底。
 */
import type { LlmProvider } from '../agent/llm'

/** 页面侧采集到的表单字段（FORM_FIELDS_FN 返回值元素） */
export interface FormField {
  /** iframe 链路径 + 文档内路径（与 extractor 的定位体系一致） */
  framePaths: number[][]
  path: number[]
  tag: string
  /** input type（text/password/tel/email/date/number/checkbox/radio/file…） */
  inputType: string
  name: string
  id: string
  placeholder: string
  /** 关联 label 文本 */
  label: string
  aria: string
  autoComplete: string
  required: boolean
  pattern: string
  min: string
  max: string
  maxLength: number
  /** 当前值 / checkbox 与 radio 的勾选态描述 */
  value: string
  checked: boolean
  /** 邻接文本（表格布局中标签在旁边 td/父级行里的情况） */
  adjacent: string
  /** select 的前 8 个选项 [{value,text}] */
  options: Array<{ value: string; text: string }>
  /** 语义提示汇总（给 LLM 看的一行摘要） */
  hint: string
}

/** LLM 规划出的填充项 */
export interface FormFillItem {
  /** FORM_FIELDS_FN 返回数组中的下标 */
  index: number
  value: string
  /** 填这个值的理由（时间线/报告审计用） */
  reason?: string
  /** checkbox/radio：true=勾选 / false=取消 */
  check?: boolean
}

/** 注入页面执行：深提取表单字段（主文档 + 同源 iframe，可见字段，上限 40 个） */
export const FORM_FIELDS_FN = String(function formFields() {
  const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image'])
  const out: any[] = []

  function norm(s: unknown): string {
    if (!s) return ''
    return String(s).replace(/\s+/g, ' ').trim()
  }

  function labelOf(el: Element): string {
    const id = el.getAttribute('id')
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (l) return norm((l as HTMLElement).innerText)
    }
    const p = el.closest('label')
    if (p) return norm((p as HTMLElement).innerText)
    return ''
  }

  /** 邻接文本：表格/表单布局里字段标签常在兄弟单元格或父级行（无 label 元素） */
  function adjacentOf(el: Element): string {
    const cell = el.closest('td,th')
    if (cell) {
      const row = cell.parentElement
      if (row) {
        const t = norm((row as HTMLElement).innerText)
        // 去掉字段自身值，只留周边文字
        return t.slice(0, 60)
      }
    }
    const wrap = el.closest('.form-item,.form-group,.field,.ant-form-item,.el-form-item')
    if (wrap) return norm((wrap as HTMLElement).innerText).slice(0, 60)
    // 兜底：前一个兄弟文本节点
    const prev = el.previousElementSibling
    if (prev) return norm((prev as HTMLElement).innerText).slice(0, 30)
    return ''
  }

  function optionsOf(sel: HTMLSelectElement) {
    return Array.from(sel.options)
      .slice(0, 8)
      .map((o) => ({ value: String(o.value), text: norm(o.textContent).slice(0, 24) }))
  }

  function pathOf(el: Element, doc: Document): number[] | null {
    const p: number[] = []
    let cur: Element | null = el
    while (cur && cur !== doc.documentElement) {
      const parent: Element | null = cur.parentElement
      if (!parent) return null
      p.unshift(Array.prototype.indexOf.call(parent.children, cur))
      cur = parent
    }
    if (!cur || cur !== doc.documentElement) return null
    return p
  }

  function collect(doc: Document, framePaths: number[][]) {
    const nodes = doc.querySelectorAll('input, select, textarea')
    for (const el of Array.from(nodes)) {
      if (out.length >= 40) return
      const tag = el.tagName
      const type = (el.getAttribute('type') || (tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : 'text')).toLowerCase()
      if (tag === 'INPUT' && SKIP_TYPES.has(type)) continue
      // 可见性：挂载在文档上且有尺寸
      let rect: DOMRect
      try {
        rect = el.getBoundingClientRect()
      } catch {
        continue
      }
      if (rect.width === 0 && rect.height === 0) continue
      const path = pathOf(el, doc)
      if (!path) continue
      const aria = norm(el.getAttribute('aria-label') || el.getAttribute('title'))
      const label = labelOf(el)
      const adjacent = adjacentOf(el)
      const name = norm(el.getAttribute('name'))
      const id = norm(el.getAttribute('id'))
      const placeholder = norm(el.getAttribute('placeholder'))
      const ac = norm(el.getAttribute('autocomplete'))
      const req = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true'
      const hintBits = [
        label && `label=${label.slice(0, 24)}`,
        placeholder && `placeholder=${placeholder.slice(0, 24)}`,
        name && `name=${name}`,
        id && `id=${id}`,
        aria && `aria=${aria.slice(0, 20)}`,
        ac && `autocomplete=${ac}`,
        adjacent && `邻近文本=${adjacent.slice(0, 30)}`,
        type !== 'text' && type !== 'textarea' && `type=${type}`,
        req && '必填'
      ].filter(Boolean)
      const any = el as any
      out.push({
        framePaths,
        path,
        tag,
        inputType: type,
        name,
        id,
        placeholder,
        label,
        aria,
        autoComplete: ac,
        required: req,
        pattern: norm(el.getAttribute('pattern')),
        min: norm(el.getAttribute('min')),
        max: norm(el.getAttribute('max')),
        maxLength: parseInt(el.getAttribute('maxlength') || '0', 10) || 0,
        value: tag === 'INPUT' && (type === 'checkbox' || type === 'radio')
          ? (any.checked ? '已勾选' : '未勾选')
          : String(any.value ?? '').slice(0, 40),
        checked: !!any.checked,
        adjacent,
        options: tag === 'SELECT' ? optionsOf(el as HTMLSelectElement) : [],
        hint: hintBits.join(' ')
      })
    }
    // 同源 iframe 递归（与 extractor 同一穿透策略）
    const frames = doc.querySelectorAll('iframe')
    for (let fi = 0; fi < frames.length && out.length < 40; fi++) {
      const f = frames[fi] as HTMLIFrameElement
      let inner: Document | null = null
      try {
        inner = f.contentDocument
      } catch {
        inner = null
      }
      if (!inner) continue
      const fp = pathOf(f, doc)
      if (!fp) continue
      collect(inner, [...framePaths, fp])
    }
  }

  collect(document, [])
  return out
})

/**
 * 注入页面执行：设置 select（按 value 或可见文本匹配）/ checkbox / radio。
 * 文本类字段不走这里（走 executor 的真实键入管线，带回读验证）。
 */
export const FORM_SET_FN = String(function formSet(
  framePaths: number[][],
  path: number[],
  mode: 'select' | 'check',
  value: string,
  check: boolean
) {
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
  for (const fp of framePaths) {
    const f = walk(doc, fp)
    if (!f || f.tagName !== 'IFRAME') return { ok: false, err: 'frame-not-found' }
    try {
      doc = (f as HTMLIFrameElement).contentDocument as Document
    } catch {
      return { ok: false, err: 'cross-origin' }
    }
    if (!doc) return { ok: false, err: 'no-doc' }
  }
  const el = walk(doc, path) as any
  if (!el) return { ok: false, err: 'element-not-found' }
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (mode === 'select' && el.tagName === 'SELECT') {
    const sel = el as HTMLSelectElement
    const hit = Array.from(sel.options).find(
      (o) => String(o.value) === value || o.textContent.trim() === value
    )
    if (!hit) return { ok: false, err: 'option-not-found', options: Array.from(sel.options).slice(0, 8).map((o) => String(o.value)) }
    sel.value = hit.value
    fire()
    return { ok: true, set: String(sel.value) }
  }
  if (mode === 'check' && el.tagName === 'INPUT') {
    const ty = (el.getAttribute('type') || '').toLowerCase()
    if (ty !== 'checkbox' && ty !== 'radio') return { ok: false, err: 'not-checkable' }
    if (el.checked !== check) el.click()
    return { ok: true, set: el.checked ? 'checked' : 'unchecked' }
  }
  return { ok: false, err: 'unsupported' }
})

/** 规划提示词：字段清单 + 变量/约束 → JSON 填充映射 */
export const FORM_FILL_SYSTEM = `你是网页表单智能填充规划器。输入是一个网页表单的字段清单（含 label/placeholder/name/autocomplete/邻接文本/类型/必填/选项等语义线索）与用户约束。你的任务是推断每个字段的业务含义，生成合规的测试填充值。

只输出纯 JSON 数组（禁止 markdown 围栏）：
[{"index":字段下标,"value":"要填的值","reason":"推断依据，20字内","check":仅checkbox/radio需要,true=勾选}]

取值规则：
1. 用户变量（{{变量}}={{值}}）优先级最高：字段语义匹配某变量时必须用变量值
2. 用户约束次之（如「用户名固定xx」「只填必填」）
3. 其余按语义生成：手机号→138开头11位；邮箱→test+当前时间戳数字@example.com；身份证→110101199001011234（18位格式合法）；日期→2026-01-15；数字→1或min/max区间内合法值；密码→Test@2026；下拉→从options里选第一个非「请选择」项的value；checkbox协议类→勾选
4. 唯一性字段（用户名/账号/工号等）加时间戳后缀防重复注册
5. 只填必填时跳过非必填字段（不出现在输出里）
6. 完全无法推断语义的字段：required 就填短文本"测试"，非必填就跳过，reason 写明"语义不明"
7. select 输出所选项的 value；checkbox/radio 用 check 布尔，value 留空`

/** LLM 规划调用：字段清单 → 填充映射（含本地契约校验） */
export async function planFormFill(
  provider: LlmProvider,
  fields: FormField[],
  ctx: { vars: Record<string, string>; constraints: string; onlyRequired: boolean }
): Promise<FormFillItem[]> {
  const varLines = Object.entries(ctx.vars)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  const fieldLines = fields
    .map((f, i) => `[${i}] ${f.tag}${f.inputType !== 'text' && f.inputType !== 'textarea' ? '(' + f.inputType + ')' : ''} ${f.hint}${f.options.length ? ` 选项:${f.options.map((o) => o.value || o.text).join('/')}` : ''}${f.pattern ? ` pattern=${f.pattern}` : ''}${f.min || f.max ? ` min=${f.min} max=${f.max}` : ''}`)
    .join('\n')
  const user = `# 字段清单\n${fieldLines}\n\n# 用户变量\n${varLines || '（无）'}\n\n# 用户约束\n${ctx.constraints || '（无）'}${ctx.onlyRequired ? '\n只填必填项' : ''}\n\n当前时间戳参考：${Date.now()}\n\n输出 JSON 数组：`
  const out = await provider.chat(FORM_FILL_SYSTEM, [{ role: 'user', content: user }])
  // 宽松解析：剥围栏、截取第一个 [ 到最后一个 ]
  let t = out.text.trim().replace(/```(?:json)?/gi, '')
  const s = t.indexOf('[')
  const e = t.lastIndexOf(']')
  if (s === -1 || e <= s) throw new Error('智能填充规划输出不是 JSON 数组')
  let arr: any[]
  try {
    arr = JSON.parse(t.slice(s, e + 1))
  } catch {
    throw new Error('智能填充规划 JSON 解析失败')
  }
  const items: FormFillItem[] = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue
    const idx = Number(it.index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= fields.length) continue
    items.push({
      index: idx,
      value: it.value != null ? String(it.value).slice(0, 500) : '',
      reason: it.reason != null ? String(it.reason).slice(0, 60) : '',
      check: typeof it.check === 'boolean' ? it.check : undefined
    })
  }
  if (!items.length) throw new Error('智能填充规划结果为空')
  return items.slice(0, 40)
}
