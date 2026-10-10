/**
 * 感知增强 S3 —— AX Tree 并联（浏览器引擎计算的可访问性语义，与自研 extractor 并联而非替换）。
 *
 * 自研 extractor 强在 iframe 穿透；AX Tree 强在浏览器引擎计算的 role/name/state
 * （自定义控件、Shadow DOM、中文语义名）。这里把 AX 树扁平化为「矩形 → 语义描述」，
 * 通过名字配对自动探测坐标系偏移后按矩形就近匹配，把 ax= 信号叠加进候选 extra。
 * 任何失败都静默降级为空列表（关闭开关 settings.axTree=false 可完全停用）。
 */
import type { Cdp } from './cdp'
import type { ExtractResult } from './extractor'
import { normalize } from './semantic'

export interface AxItem {
  x: number
  y: number
  w: number
  h: number
  /** role name（如 "textbox 商品名称"） */
  desc: string
  /** W4 state 行内：disabled/checked/expanded 等语义状态（仅存在时携带；写入候选并进元素列表行内） */
  state?: string
}

/** 保留的可交互 AX 角色（只取有语义名的，避免整棵树噪声） */
const AX_ROLES = new Set([
  'textbox',
  'button',
  'link',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'searchbox',
  'spinbutton',
  'switch',
  'listbox',
  'slider'
])

/**
 * 取 AX 树并解析为带矩形的语义条目（最多 maxNodes 个盒子查询，分批并行）。
 * DOM.getBoxModel 的坐标与 getBoundingClientRect 可能差一个滚动偏移——
 * 由 annotateWithAx 的名字配对自动校正，这里只负责取原始数据。
 * W2/W4：上限 80→150（role/name/state 升格为候选定位键与行内状态）、批 10→25、单批超时 5s→3s。
 */
export async function fetchAxTree(cdp: Cdp, maxNodes = 150): Promise<AxItem[]> {
  await cdp.send('Accessibility.enable', {})
  let nodes: any[]
  try {
    const r = await cdp.send<{ nodes: any[] }>('Accessibility.getFullAXTree', {})
    nodes = r?.nodes || []
  } finally {
    cdp.send('Accessibility.disable', {}).catch(() => {})
  }
  const picked: Array<{ bid: number; role: string; name: string; state?: string }> = []
  for (const n of nodes) {
    if (!n || n.ignored) continue
    const role = typeof n.role === 'object' && n.role ? String(n.role.value || '') : String(n?.role || '')
    const name = typeof n.name === 'object' && n.name ? String(n.name.value || '') : String(n?.name || '')
    const bid = Number(n.backendDOMNodeId || 0)
    if (!bid || !role || !AX_ROLES.has(role)) continue
    const nm = normalize(name)
    if (!nm || nm.length > 30) continue
    // W4 state 采集：disabled/checked/expanded（浏览器引擎判定，含 aria 与自定义控件语义）
    const states: string[] = []
    if (n.disabled === true) states.push('disabled')
    if (n.checked === true || n.checked === 'mixed') states.push(n.checked === 'mixed' ? '半选' : '已勾选')
    if (n.expanded === true) states.push('已展开')
    if (n.expanded === false) states.push('已收起')
    picked.push({ bid, role, name: nm, state: states.length ? states.join('/') : undefined })
    if (picked.length >= maxNodes) break
  }
  if (!picked.length) return []

  const out: AxItem[] = []
  // 分批并行取盒子（W2：单批 25、单批超时 3s——批量 reflow 风险由「只在步首并行段执行」错峰）
  for (let i = 0; i < picked.length; i += 25) {
    const batch = picked.slice(i, i + 25)
    const boxes = await Promise.all(
      batch.map((p) =>
        cdp
          .send<{ content?: number[] }>('DOM.getBoxModel', { backendNodeId: p.bid }, 3000)
          .then((bm) => ({ p, bm }))
          .catch(() => ({ p, bm: null as { content?: number[] } | null }))
      )
    )
    for (const { p, bm } of boxes) {
      const q = bm?.content
      if (!q || q.length < 8) continue
      const xs = [q[0], q[2], q[4], q[6]]
      const ys = [q[1], q[3], q[5], q[7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const w = Math.max(...xs) - x
      const h = Math.max(...ys) - y
      if (w <= 0 || h <= 0) continue
      out.push({ x, y, w, h, desc: `${p.role} ${p.name}`, state: p.state })
    }
  }
  return out
}

/**
 * 把 AX 语义叠加进候选 extra（在位修改，不改变顺序——编号不受影响）。
 * 匹配：先用「候选 text === AX name 且名字唯一」的配对探测全局坐标偏移，
 * 再按候选中心点是否落在（偏移校正 + 8px 容差后的）AX 盒内做就近匹配；
 * 只给文本线索不足的候选补充（有 label/placeholder 的不必重复），上限 40 个控 token。
 * 返回成功叠加的条数（0 = 未生效，调用方无需处理）。
 */
export function annotateWithAx(res: ExtractResult, ax: AxItem[]): number {
  if (!ax.length || !res.candidates.length) return 0

  // 1) 名字唯一化：normalized name → item（重名的不参与配对）
  const nameCount = new Map<string, number>()
  for (const a of ax) nameCount.set(a.desc.slice(a.desc.indexOf(' ') + 1), (nameCount.get(a.desc.slice(a.desc.indexOf(' ') + 1)) || 0) + 1)
  const byName = new Map<string, AxItem>()
  for (const a of ax) {
    const nm = a.desc.slice(a.desc.indexOf(' ') + 1)
    if (nameCount.get(nm) === 1) byName.set(nm, a)
  }

  // 2) 名字配对探测偏移（≥2 对才可信；不足则假定偏移为 0）
  let dx = 0
  let dy = 0
  let pairs = 0
  for (const c of res.candidates) {
    const item = byName.get(normalize(c.text))
    if (!item) continue
    dx += c.rect.x + c.rect.w / 2 - (item.x + item.w / 2)
    dy += c.rect.y + c.rect.h / 2 - (item.y + item.h / 2)
    pairs++
  }
  if (pairs >= 2) {
    dx /= pairs
    dy /= pairs
  }

  // 3) 就近匹配叠加。
  //    W4：state（disabled/checked/expanded）对**所有**几何匹配候选生效——这是文本里没有的新信息，
  //    已有充足语义线索的候选不重复叠 ax= 文本标签，但 state 照写（元素列表行内渲染 `(disabled)` 等）
  let hits = 0
  for (const c of res.candidates) {
    const known = normalize(`${c.text}${c.extra}`)
    const cx = c.rect.x + c.rect.w / 2
    const cy = c.rect.y + c.rect.h / 2
    let best: AxItem | null = null
    for (const item of ax) {
      const ix = item.x + dx
      const iy = item.y + dy
      if (cx >= ix - 8 && cx <= ix + item.w + 8 && cy >= iy - 8 && cy <= iy + item.h + 8) {
        if (!best || item.w * item.h < best.w * best.h) best = item // 最小包含盒最精确
      }
    }
    if (best) {
      if (best.state && !c.state) c.state = best.state
      if (hits < 40 && known.length < 6 && !known.includes(best.desc.split(' ')[1] || '\0')) {
        const tag = `ax=${best.desc.replace(/\s+/g, '_')}`
        c.extra = c.extra ? `${c.extra} ${tag}`.slice(0, 200) : tag
        hits++
      }
    }
  }
  return hits
}
