/**
 * 感知增强 S3 —— AX Tree 并联（浏览器引擎计算的可访问性语义，与自研 extractor 并联而非替换）。
 *
 * 自研 extractor 强在 iframe/shadow 穿透；AX Tree 强在浏览器引擎计算的 role/name/state
 * （自定义控件、Shadow DOM、中文语义名）。这里把 AX 树扁平化为语义条目，按两条桥配对候选：
 * ① 名字桥（normalized name 全等，覆盖有 aria-label 的候选）；② 几何桥（仅无文本候选——
 * AXNode 不带 rect，需查 DOM.getBoxModel；无文本候选通常 <15 个，单批并行一次往返）。
 * 任何失败都静默降级为空列表（关闭开关 settings.axTree=false 可完全停用）。
 *
 * v4/P1-2：相比旧版（全部 ≤150 节点逐个查盒子、8 轮串行往返），盒子查询只留给无文本候选，
 * 有文本候选全部走名字桥零查询——密集后台页（几十个有名控件）的盒子查询量降一个数量级。
 */
import type { Cdp } from './cdp'
import type { ExtractResult } from './extractor'
import { normalize } from './semantic'

export interface AxItem {
  x: number
  y: number
  w: number
  h: number
  /** role name（如 "textbox 商品名称"）——name 部分与候选配对用 */
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
 * 取 AX 树语义条目：一次 getFullAXTree + 仅为「无文本候选」批量补盒子（DOM.getBoxModel）。
 * withBoxes 传入 extractor 候选文本列表以决定哪些 AX 节点需要几何（有文本的不查，零往返）。
 */
export async function fetchAxTree(cdp: Cdp, maxNodes = 150, candKnownTexts?: string[]): Promise<AxItem[]> {
  await cdp.send('Accessibility.enable', {})
  let nodes: any[]
  try {
    const r = await cdp.send<{ nodes: any[] }>('Accessibility.getFullAXTree', {})
    nodes = r?.nodes || []
  } finally {
    cdp.send('Accessibility.disable', {}).catch(() => {})
  }
  const known = new Set((candKnownTexts || []).map((t) => normalize(t)).filter(Boolean))
  const picked: Array<{ bid: number; role: string; name: string; state?: string; needBox: boolean }> = []
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
    const property = (key: string) => n.properties?.find((p: any) => p.name === key)?.value?.value ?? n[key]
    if (property('disabled') === true) states.push('disabled')
    const checked = property('checked')
    if (checked === true || checked === 'true' || checked === 'mixed') states.push(checked === 'mixed' ? '半选' : '已勾选')
    if (property('expanded') === true) states.push('已展开')
    if (property('expanded') === false) states.push('已收起')
    // 名字能对上候选文本的不需要盒子（名字桥配对）；对不上的才要几何（图标候选）
    picked.push({ bid, role, name: nm, state: states.length ? states.join('/') : undefined, needBox: !known.has(nm) })
    if (picked.length >= maxNodes) break
  }
  if (!picked.length) return []

  const out: AxItem[] = []
  // v4/P1-2：盒子查询只留给「名字配不上的」AX 节点（无文本图标等），单批 25 并行一次往返
  const needBox = picked.filter((p) => p.needBox)
  const boxed = new Map<number, { x: number; y: number; w: number; h: number }>()
  for (let i = 0; i < needBox.length; i += 25) {
    const batch = needBox.slice(i, i + 25)
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
      boxed.set(p.bid, { x, y, w, h })
    }
  }
  for (const p of picked) {
    const b = boxed.get(p.bid)
    out.push(b ? { ...b, desc: `${p.role} ${p.name}`, state: p.state } : { x: 0, y: 0, w: 0, h: 0, desc: `${p.role} ${p.name}`, state: p.state })
  }
  return out
}

/**
 * 把 AX 语义叠加进候选 extra（在位修改，不改变顺序——编号不受影响）。
 * 双桥配对：① 名字桥（候选 text/extra 合并归一 == AX name，重名不配对防列表串行）；
 * ② 几何桥（w>0 的 AX 条目按中心点包含匹配，仅兜底名字没配上的）。
 * 只给文本线索不足的候选补充 ax= 标签（有 label/placeholder 的不必重复），上限 40 个控 token；
 * state 对所有配对成功的候选生效（文本里没有的新信息，行内渲染）。
 * 返回成功叠加的条数（0 = 未生效，调用方无需处理）。
 */
export function annotateWithAx(res: ExtractResult, ax: AxItem[]): number {
  if (!ax.length || !res.candidates.length) return 0

  // 1) 名字唯一化：normalized name → item（重名的不参与配对，防列表串行）
  const nameCount = new Map<string, number>()
  for (const a of ax) {
    const nm = a.desc.slice(a.desc.indexOf(' ') + 1)
    nameCount.set(nm, (nameCount.get(nm) || 0) + 1)
  }
  const byName = new Map<string, AxItem>()
  for (const a of ax) {
    const nm = a.desc.slice(a.desc.indexOf(' ') + 1)
    if (nameCount.get(nm) === 1) byName.set(nm, a)
  }

  // 2) 双桥配对叠加：名字桥优先；空文本候选（图标/自定义控件）靠几何桥兜底
  let hits = 0
  for (const c of res.candidates) {
    const known = normalize(`${c.text}${c.extra}`)
    let item: AxItem | undefined = known ? byName.get(known) || byName.get(normalize(c.text)) : undefined
    if (!item) {
      // 几何桥：候选中心落在 AX 盒内（8px 容差），最小包含盒最精确——只对有盒子的 AX 条目
      const cx = c.rect.x + c.rect.w / 2
      const cy = c.rect.y + c.rect.h / 2
      let best: AxItem | null = null
      for (const it of ax) {
        if (it.w <= 0 || it.h <= 0) continue
        if (cx >= it.x - 8 && cx <= it.x + it.w + 8 && cy >= it.y - 8 && cy <= it.y + it.h + 8) {
          if (!best || it.w * it.h < best.w * best.h) best = it
        }
      }
      item = best || undefined
    }
    if (item) {
      if (item.state && !c.state) c.state = item.state
      if (hits < 40 && known.length < 6 && !known.includes(item.desc.split(' ')[1] || '\0')) {
        const tag = `ax=${item.desc.replace(/\s+/g, '_')}`
        c.extra = c.extra ? `${c.extra} ${tag}`.slice(0, 200) : tag
        hits++
      }
    }
  }
  return hits
}
