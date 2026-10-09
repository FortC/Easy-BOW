/**
 * 语义智能 S1 —— 纯函数模块（不依赖 Electron/CDP，可单测）。
 *
 * 解决两类断链：
 * ① 「商品名称 ≠ 名称」：任务描述与页面字段用词不一致导致模型选不中目标
 * ② 静默填错：值填对了、但填进了语义不匹配的字段（executor 填后校验用本模块打分）
 *
 * 打分三级（分数高→低）：
 * 1. 直接包含（任务词 ⊂ 字段文案 或 字段文案 ⊂ 任务词）→ 0.85 + min(0.1, len×0.02)
 * 2. 同义词等价（商品↔产品）→ 0.78
 * 3. Dice 二元组模糊（抗字面差异）→ dice × 0.7
 * 覆盖度折扣：命中片段只覆盖字段文案一部分时按比例打折
 * （「名称」命中「名称编码」只算一半——名称编码是另一个字段，这正是验收用例 6 的判定依据）
 */

export interface SemanticCandidate {
  text: string
  extra: string
  role: string
  tag: string
}

/** 业务同义词组：组内任意词视为等价（附录 B：组内词须确实等价，禁止放单字） */
export const SYNONYM_GROUPS: string[][] = [
  ['商品', '产品', 'sku', '货品', '宝贝', '物品'],
  ['名称', '名字', '标题', '品名', '商品名', '产品名称'],
  ['价格', '单价', '金额', '总额', '费用', '售价'],
  ['数量', '个数', '件数', 'qty'],
  ['收货人', '联系人', '买家', '收件人', '客户姓名'],
  ['地址', '收货地址', '详细地址', '所在地区'],
  ['电话', '手机', '联系电话', '手机号', '联系方式'],
  ['邮箱', '邮件', '电子邮箱', 'email'],
  ['编号', '编码', 'code', '序列号'],
  ['图片', '主图', '照片', 'image', 'pic'],
  ['详情', '描述', '介绍', '说明', 'detail'],
  ['备注', 'note', 'remark'],
  ['类目', '分类', '类别', 'category', '类型'],
  ['店铺', '店铺名', 'store', 'shop'],
  ['时间', '日期', 'date', '创建时间'],
  ['状态', 'state', 'status'],
  ['用户名', '账号', '用户', 'user', '登录名'],
  ['密码', '口令', 'password'],
  ['搜索', '查找', '检索', '搜索框', '关键词'],
  ['库存', '存货', 'stock']
]

/** 归一化：全角→半角、去空格、去标点、小写 */
export function normalize(s: string): string {
  if (!s) return ''
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s　]/g, '')
    .replace(/[：:，,。.、；;！!？?（）()【】[\]{}"'`~*#\\/|·…—\-<>@#$%^&+=]/g, '')
    .toLowerCase()
    .trim()
}

/** 同义词展开：输入词 → 所在组全部词（含自身）；不在任何组则仅返回自身（归一化后） */
export function expandSynonyms(word: string): Set<string> {
  const w = normalize(word)
  const out = new Set<string>(w ? [w] : [])
  for (const g of SYNONYM_GROUPS) {
    const gn = g.map(normalize)
    if (w && gn.includes(w)) gn.forEach((x) => x && out.add(x))
  }
  return out
}

/** Dice 二元组字符相似度（0~1；空串返回 0） */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0
  const grams = (s: string) => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2)
      m.set(g, (m.get(g) || 0) + 1)
    }
    return m
  }
  const ma = grams(a)
  const mb = grams(b)
  let inter = 0
  let total = 0
  for (const [g, n] of ma) {
    total += n
    const n2 = mb.get(g)
    if (n2) inter += Math.min(n, n2)
  }
  for (const [, n] of mb) total += n
  return total ? (2 * inter) / total : 0
}

/* ———————————————— 关键词抽取 ———————————————— */

const FILL_VERB_RE = /(?:填写|填入|输入|填上|填好|设置|录入|修改|填)/

/** 中文连续段切分：整段（≤6 字保留整段）+ 2/3 字滑动窗口（供同义词与模糊匹配兜底） */
function cjkTokens(run: string): string[] {
  const out: string[] = []
  if (run.length <= 6) out.push(run)
  if (run.length >= 2) {
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2))
    for (let i = 0; i + 3 <= run.length && run.length >= 3; i++) out.push(run.slice(i, i + 3))
  }
  return [...new Set(out)]
}

/** 抽取任务里的关键词：中文连续段（去动词头）+ 英文单词 */
export function extractKeywords(task: string): string[] {
  if (!task) return []
  const out: string[] = []
  // 中文连续段
  for (const m of task.matchAll(/[\u4e00-\u9fa5]{2,12}/g)) {
    let run = m[0]
    // 去掉开头的动词（填入/输入/设置…），保留宾语
    const vm = run.match(FILL_VERB_RE)
    if (vm && vm.index != null && vm.index < 2) run = run.slice(vm.index + vm[0].length)
    if (run.length >= 2) out.push(...cjkTokens(run))
  }
  // 英文单词
  for (const m of task.matchAll(/[a-zA-Z][a-zA-Z0-9_]{1,15}/g)) out.push(m[0].toLowerCase())
  return [...new Set(out)].slice(0, 40)
}

/** 从任务里抽取「填写字段意图」短语（如「填入商品名称」→「商品名称」），供填后校验定位目标字段 */
export function extractFillFields(task: string): string[] {
  if (!task) return []
  const phrases: string[] = []
  for (const m of task.matchAll(
    /(?:填写|填入|输入|填上|填好|设置|录入|修改)(?:到|进|入|在|把|给)?(?:「|『|“|"| )?([^，。,；;、！!？?\n"”』」]{2,16})/g
  )) {
    let ph = m[1].trim()
    // 去掉开头的动词残部与方位词
    ph = ph.replace(/^(?:到|进|入|在|把|给|的|了)+/, '')
    if (ph.length < 2) continue
    phrases.push(ph)
  }
  return phrases.slice(0, 8)
}

/** 主目标字段（提示词/报错文案用）：第一个填写意图短语，无则取最长的中文段 */
export function extractTargetField(task: string): string {
  const fills = extractFillFields(task)
  if (fills.length) return fills[0].slice(0, 12)
  const runs = task.match(/[\u4e00-\u9fa5]{2,8}/g) || []
  return (runs.sort((a, b) => b.length - a.length)[0] || '').slice(0, 12)
}

/* ———————————————— 打分 ———————————————— */

/**
 * 单关键词 × 单字段文案的匹配分（0~1）。
 * cover：命中片段占字段文案长度的比例——「名称」命中「名称编码」打对折，
 * 防止把值填进语义已变的兄弟字段（名称编码 ≠ 名称）。
 * noShortContain：2 字短词不做裸包含判定（「名称」⊂「名称编码」这类命中区分度太低），
 * 仅用于填后校验；排序召回仍允许（宁多排不漏排）。
 */
function tokenScore(w: string, field: string, noShortContain = false): { score: number; via: string } {
  if (!w || !field) return { score: 0, via: '' }
  let base = 0
  let span = 0
  let via = ''
  const shortContain = noShortContain && w.length <= 2
  if (field.includes(w) && !shortContain) {
    base = 0.85 + Math.min(0.1, w.length * 0.02)
    span = w.length
    via = '直接'
  } else if (w.includes(field) && field.length >= 2) {
    base = 0.85 + Math.min(0.1, field.length * 0.02)
    span = field.length
    via = '直接'
  }
  if (!base) {
    for (const syn of expandSynonyms(w)) {
      if (syn === w || !syn) continue
      if (field.includes(syn)) {
        base = 0.78
        span = syn.length
        via = `同义:${w}≈${syn}`
        break
      }
      if (syn.includes(field) && field.length >= 2) {
        base = 0.78
        span = field.length
        via = `同义:${w}≈${syn}`
        break
      }
    }
  }
  if (!base) {
    const d = dice(w, field)
    if (d > 0.2) {
      base = d * 0.7
      span = Math.min(w.length, field.length)
      via = `模糊:${w}(${d.toFixed(2)})`
    }
  }
  if (!base) return { score: 0, via: '' }
  const cover = span / Math.max(span, field.length)
  return { score: base * cover, via }
}

/** 候选的语义字段块：text + extra 按空格与 = 拆块（placeholder=x / label=y 的值独立成块） */
function fieldChunks(cand: SemanticCandidate): string[] {
  const chunks: string[] = []
  const t = normalize(cand.text)
  if (t) chunks.push(t)
  for (const part of String(cand.extra || '').split(/\s+/)) {
    const n = normalize(part)
    if (n && n.length >= 2) chunks.push(n)
    // 「label=商品名称」的值独立成块（键名前缀会稀释 cover）
    const eq = part.indexOf('=')
    if (eq >= 0) {
      const v = normalize(part.slice(eq + 1))
      if (v && v.length >= 2 && v !== n) chunks.push(v)
    }
  }
  return chunks
}

/**
 * 综合语义打分 0~1：任务关键词 × 候选字段块的最大匹配分。
 * 目标为输入类元素时 +0.05（表单任务里输入框通常是目标）。
 */
export function scoreCandidate(cand: SemanticCandidate, task: string): { score: number; matchedVia: string[] } {
  const kws = extractKeywords(task)
  if (!kws.length) return { score: 0, matchedVia: [] }
  const chunks = fieldChunks(cand)
  if (!chunks.length) return { score: 0, matchedVia: [] }
  let best = 0
  const via: string[] = []
  for (const kw of kws) {
    for (const chunk of chunks) {
      const r = tokenScore(kw, chunk)
      if (r.score > best) {
        best = r.score
        via.length = 0
        via.push(r.via || '直接')
      } else if (r.score === best && r.via && via.length < 2 && !via.includes(r.via)) {
        via.push(r.via)
      }
      if (best >= 0.95) break
    }
    if (best >= 0.95) break
  }
  let score = Math.min(1, best)
  if (/input|select|可编辑|textarea|textbox/.test(String(cand.role || ''))) score = Math.min(1, score + 0.05)
  return { score, matchedVia: via }
}

/**
 * 填后语义校验：把「实际字段的文案块」与「任务里的填写意图」比对。
 * - 任一意图短语得分 ≥ 0.45 → 通过（多字段任务里本动作可能对应其中任意一个字段）
 * - 全部 < 0.45 → 疑似填错字段（ok=false），供 executor 显式报错自愈
 * - 任务里没有填写意图 → 跳过（ok=true，不校验）
 */
export function verifyFieldMatch(
  labelParts: string[],
  task: string
): { ok: boolean; score: number; want: string } {
  const fills = extractFillFields(task)
  const want = extractTargetField(task)
  if (!fills.length) return { ok: true, score: 1, want }
  const chunks = labelParts.map(normalize).filter((s) => s && s.length >= 2)
  if (!chunks.length) return { ok: true, score: 1, want }
  let best = 0
  for (const ph of fills) {
    for (const kw of cjkTokens(ph)) {
      for (const chunk of chunks) {
        // 2 字短词不做裸包含（区分度低：「名称」⊂「名称编码」不算命中），同义词/模糊仍可用
        const r = tokenScore(kw, chunk, true)
        if (r.score > best) best = r.score
      }
    }
  }
  return { ok: best >= 0.45, score: best, want }
}
