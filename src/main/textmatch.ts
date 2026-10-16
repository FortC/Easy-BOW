/**
 * 统一文本匹配器 v4.5 —— 页面文案在多处被比较，此前 7 处各写各的 includes，
 * 对「截断串 vs 全称」的处理互不一致（漏一处就是「能定位但 expect_text 拒绝」
 * 或「重提取后选错兄弟元素」）。本模块是唯一的比较真源。
 *
 * 关键事实（改代码前务必先读 extractor.ts 的同名注释）：
 * CSS `text-overflow: ellipsis` 不影响 `innerText` —— 它返回完整文本，
 * 省略号只是渲染层效果。所以「CSS 省略号导致只拿到前几个字」在本项目**不是问题**；
 * 真正的截断来自 JS（s.slice(0,10)+'…'）与 SVG <text>（innerText 可能 undefined），
 * 这两种情况下全称只能从 title / data-* / textContent 取。
 */

/** 元素文案长度上限的单一真源：EXTRACT_FN 与 RESOLVE_FN 共用，消除 80/40 不对称 */
export const TEXT_CAP = 80

/** 尾部省略号标记（匹配前剥离）：… / ... / 。。。 / 结尾的 >
 *  刻意**不**剥离「查看更多/展开」这类 UI 控件文案——那会把文案剥成空串，
 *  空串在匹配器里代表「无从比对→放行」，等于给歧义场景开了后门。 */
const TAIL_ELLIPSIS = /(?:…+|\.{2,}|。{3,}|>+)\s*$/

/** 零宽字符（U+200B/C/D、U+FEFF）：复制粘贴的文案常带，比对前必须去掉 */
const ZERO_WIDTH = /[‌‍﻿]/g

/** 全文↔半角、全角空格、零宽字符、折叠空白 —— 不去标点（标点对语义有影响，如「姓名（必填）」） */
export function normalizeText(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(ZERO_WIDTH, '')
    .replace(/[\s　 ]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 剥离尾部省略号标记；剥到空串时保留原值（空串在匹配器里代表「无从比对→放行」） */
export function stripEllipsis(s: string): string {
  let out = String(s || '')
  for (let i = 0; i < 3; i++) {
    const next = out.replace(TAIL_ELLIPSIS, '').trim()
    if (next === out || !next) break
    out = next
  }
  return out
}

/** 二元组 Dice 相似度（0~1）；与 semantic.ts 的实现一致，此处独立一份避免跨模块耦合 */
function dice(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = (s: string): Map<string, number> => {
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

export interface MatchResult {
  ok: boolean
  /** 0~1 相似度（供诊断与「填错字段」类软判定使用） */
  score: number
  /** 命中路径：子串 / 省略号前缀 / 分词 / 模糊 / 空 —— 直接进拒绝文案，让模型知道该改文案还是换元素 */
  via: string
  /** want 与 got 归一化后的值（诊断用） */
  normWant: string
  normGot: string
}

/**
 * want 与 got 是否指向同一段文案。
 *
 * 匹配阶梯：
 *  1. 空值放行（图标按钮无文案，无法校验 —— 与历史行为一致）
 *  2. 双向子串 —— 「删除」⊂「删除」/「批量删除」
 *  3. 省略号前缀 —— stripEllipsis(want) 是 got 的前缀（≥2 字）
 *     直接解决「模型从截图抄了带省略号的『收货人姓名…』，DOM 里是『收货人姓名（必填）』」
 *  4. 分词全命中 —— 按 /[\s,，、;；]+/ 切 want，≥2 字的 token 全部出现在 got
 *  5. Dice 模糊 —— fuzzy=true 时（expect_text 场景）才启用，避免定位链被相似元素放过
 */
export function textMatch(want: string, got: string, opts?: { fuzzy?: boolean; fuzzyMin?: number }): MatchResult {
  const normWant = normalizeText(want)
  const normGot = normalizeText(got)
  if (!normWant || !normGot) return { ok: true, score: 1, via: '空', normWant, normGot }
  if (normWant === normGot) return { ok: true, score: 1, via: '相等', normWant, normGot }

  // 2. 双向子串
  if (normGot.includes(normWant) || normWant.includes(normGot)) {
    return { ok: true, score: 1, via: normGot.includes(normWant) ? '子串' : '反子串', normWant, normGot }
  }

  // 3. 省略号前缀：want 尾部有省略号（模型从截图抄的），去掉后应是 got 的前缀
  const bare = stripEllipsis(normWant)
  if (bare.length >= 2 && bare !== normWant) {
    if (normGot.startsWith(bare) || bare.startsWith(normGot)) {
      return { ok: true, score: 0.95, via: '省略号前缀', normWant, normGot }
    }
  }
  // 反向：got 尾部有省略号而 want 是全称（快照存了截断串、实时拿到全称）
  const bareGot = stripEllipsis(normGot)
  if (bareGot.length >= 2 && bareGot !== normGot) {
    if (normWant.startsWith(bareGot) || bareGot.startsWith(normWant)) {
      return { ok: true, score: 0.95, via: '省略号前缀(实际)', normWant, normGot }
    }
  }

  // 4. 分词全命中
  const tokens = normWant.split(/[\s,，、;；]+/).filter((t) => t.length >= 2)
  if (tokens.length >= 2) {
    const merged = tokens.join('')
    if (merged.length >= 2 && normGot.includes(merged)) {
      return { ok: true, score: 0.9, via: '分词', normWant, normGot }
    }
    if (tokens.every((t) => normGot.includes(t))) {
      return { ok: true, score: 0.88, via: '分词全命中', normWant, normGot }
    }
  }

  // 5. 模糊（仅 expect_text 场景）
  if (opts?.fuzzy) {
    const min = opts.fuzzyMin ?? 0.72
    const d = Math.max(dice(normWant, normGot), dice(bare, bareGot))
    if (d >= min) return { ok: true, score: d, via: `模糊${d.toFixed(2)}`, normWant, normGot }
    return { ok: false, score: d, via: '不匹配', normWant, normGot }
  }
  return { ok: false, score: 0, via: '不匹配', normWant, normGot }
}

/** 只要布尔的便捷包装（定位链的严格比较点用这个，不开模糊） */
export function sameText(want: string, got: string): boolean {
  return textMatch(want, got).ok
}
