/**
 * v4.4 跨域/OOPIF 通达层（聚水潭等嵌套报表的「抓不到数据」根因修复）：
 * 同源嵌套由 EXTRACT_FN/READ_CONTENT_FN 的 contentDocument 递归覆盖；跨域 iframe
 * （独立渲染进程，contentDocument 读不到）此前整棵子树静默跳过。本层用 Electron
 * `webContents.mainFrame.framesInSubtree` 枚举完整 frame 树（含跨域），在每个 frame
 * 自身上下文 `WebFrameMain.executeJavaScript` 执行提取脚本（可跨进程），
 * 坐标经「父页面 iframe 元素矩形」偏移链合并到顶层视口。
 *
 * 定位契约：跨域 frame 的候选带 `frameKey`（frame 树位置，如 "0.2.1"），
 * 解析/赋值都必须回该 frame 上下文执行（executor 按 frameKey 分流）；
 * 坐标解析不出时候选照常入列（文本可读），标记 inViewport=false 降级为「仅供读」。
 */
import type { WebContents, WebFrameMain } from 'electron'
import type { Candidate, ExtractResult } from './extractor'

/** frame 树节点（扁平化；key=树位置索引路径，如 "0.2.1"） */
export interface FrameEntry {
  key: string
  frame: WebFrameMain
  url: string
  depth: number
  parentKey: string | null
}

/** 本 frame 自身上下文探针：身份信息（window.name 跨域可读，是父子关联的第一线索） */
const FRAME_PROBE_FN = String(function frameProbe() {
  return {
    name: String(window.name || ''),
    url: location.href,
    iw: window.innerWidth,
    ih: window.innerHeight
  }
})

/** 父文档 iframe 元素清单：位置/尺寸/name（跨域 contentWindow.name 可读）/是否跨域挡读 */
const IFRAME_LIST_FN = String(function iframeList() {
  let els: Element[] = []
  try {
    els = Array.from(document.querySelectorAll('iframe'))
  } catch {
    return []
  }
  return els.map((el, i) => {
    const f = el as HTMLIFrameElement
    const r = f.getBoundingClientRect()
    let name = ''
    try {
      name = String((f.contentWindow as any)?.name || '')
    } catch {}
    let blocked = true
    try {
      blocked = !(f.contentDocument && f.contentDocument.body)
    } catch {}
    return {
      i,
      src: f.getAttribute('src') || '',
      name,
      cw: f.clientWidth || 0,
      ch: f.clientHeight || 0,
      x: r.left + (f.clientLeft || 0),
      y: r.top + (f.clientTop || 0),
      blocked
    }
  })
})

/** 扁平化 frame 树（mainFrame.framesInSubtree 含跨域子进程 frame） */
export function frameTree(wc: WebContents): FrameEntry[] {
  const out: FrameEntry[] = []
  const walk = (f: WebFrameMain, key: string, depth: number, parentKey: string | null): void => {
    let url = ''
    try {
      url = f.url
    } catch {}
    out.push({ key, frame: f, url, depth, parentKey })
    let kids: WebFrameMain[] = []
    try {
      kids = f.frames
    } catch {}
    kids.forEach((k, i) => walk(k, `${key}.${i}`, depth + 1, key))
  }
  try {
    walk(wc.mainFrame, '0', 0, null)
  } catch {}
  return out
}

/** 在指定 frame 上下文执行注入函数（跨进程可达；frame 消失/导航竞态返回 null）。
 *  带 5s 超时竞速：窗口被遮挡/最小化时渲染器被 Chromium 挂起，executeJavaScript 永不 settle——
 *  数据补充绝不允许把提取/执行链路挂死（超时按「该 frame 暂不可读」降级） */
export async function runInFrame<T>(f: WebFrameMain, fn: string, args: unknown[] = []): Promise<T | null> {
  try {
    const expr = `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`
    const v = await Promise.race([
      f.executeJavaScript(expr),
      new Promise<null>((r) => {
        const t = setTimeout(() => r(null), 5000)
        t.unref?.()
      })
    ])
    return (v === undefined ? null : v) as T
  } catch {
    return null
  }
}

/** 按 frameKey 在当前 frame 树里找回目标 frame（页面导航后 key 可能失效 → null） */
export function findByKey(wc: WebContents, key: string): WebFrameMain | null {
  for (const e of frameTree(wc)) if (e.key === key) return e.frame
  return null
}

/** 按 frameKey 执行注入函数（executor 分流用） */
export async function runByKey<T>(wc: WebContents, key: string, fn: string, args: unknown[] = []): Promise<T | null> {
  const f = findByKey(wc, key)
  if (!f) return null
  return runInFrame<T>(f, fn, args)
}

/** 按 frameKey 求目标 frame 到顶层视口的偏移（executor 坐标合并用） */
export async function offsetByKey(wc: WebContents, key: string): Promise<{ x: number; y: number } | null> {
  const tree = frameTree(wc)
  const entry = tree.find((e) => e.key === key)
  if (!entry) return null
  return frameOffset(wc, entry, tree)
}

/** 目标 frame 相对顶层视口的偏移链（父文档 iframe 元素坐标逐层累加）。
 *  父子关联优先 window.name（跨域可读），其次 src/尺寸，最后按 frame 树顺序对齐。 */
export async function frameOffset(
  wc: WebContents,
  entry: FrameEntry,
  tree?: FrameEntry[]
): Promise<{ x: number; y: number } | null> {
  const t = tree || frameTree(wc)
  let ox = 0
  let oy = 0
  let cur = entry
  const guards = 12
  for (let g = 0; g < guards && cur.parentKey !== null; g++) {
    const parent = t.find((e) => e.key === cur.parentKey)
    if (!parent) return null
    const probe = await runInFrame<{ name: string; url: string; iw: number; ih: number }>(cur.frame, FRAME_PROBE_FN)
    const list = await runInFrame<
      Array<{ i: number; src: string; name: string; cw: number; ch: number; x: number; y: number; blocked: boolean }>
    >(parent.frame, IFRAME_LIST_FN)
    if (!probe || !list || !list.length) return null
    // 兄弟 frame 顺序 = 父文档 iframe 顺序（同父下的 frame 树顺序），用于 order 对齐
    const siblings = t.filter((e) => e.parentKey === cur.parentKey)
    const sibIdx = siblings.indexOf(cur)
    let hit = list.find((it) => it.name && it.name === probe.name)
    if (!hit && probe.url) {
      const bySrc = list.filter((it) => it.src && (probe.url.startsWith(it.src) || it.src.startsWith(probe.url)))
      if (bySrc.length === 1) hit = bySrc[0]
    }
    if (!hit) {
      const bySize = list.filter((it) => Math.abs(it.cw - probe.iw) <= 12 && Math.abs(it.ch - probe.ih) <= 12)
      if (bySize.length === 1) hit = bySize[0]
    }
    if (!hit && sibIdx >= 0 && sibIdx < list.length) hit = list[sibIdx]
    if (!hit) return null
    ox += hit.x
    oy += hit.y
    cur = parent
  }
  return { x: Math.round(ox * 100) / 100, y: Math.round(oy * 100) / 100 }
}

/** 跨域 frame 补充提取：对「父文档 contentDocument 读不到」的 frame 在其自身上下文跑
 *  EXTRACT_FN，候选并入 res.candidates（带 frameKey + 顶层视口坐标）。
 *  并入前按 (text,tag,rect 近似) 与既有候选去重——URL 对齐失败回退「全部非主 frame」时
 *  同源 frame 会被重复覆盖，去重兜底。递归处理跨域 frame 内部的跨域子 frame。 */
export async function supplementExtract(
  wc: WebContents,
  res: ExtractResult,
  extractFn: string,
  maxElements: number,
  viewportH: number,
  /** v4.5：文案长度上限，与主上下文 EXTRACT_FN 调用保持同一常量（frameAccess 不 import textmatch
   *  以免主进程模块耦合，调用方从 executor 传入） */
  textCap?: number
): Promise<number> {
  const served = new Set<string>() // 已补充的 frame key（frame 树每轮重建，跨轮记忆）
  const servedSrcs: string[] = []
  let added = 0
  const candBudget = maxElements // 补充候选总预算（合并后列表 ≤ 2×maxElements，提示词侧照常裁剪）
  for (let round = 0; round < 3 && added < candBudget && served.size < 4; round++) {
    const tree = frameTree(wc)
    let progressed = false
    for (const parent of tree) {
      const list = await runInFrame<
        Array<{ i: number; src: string; name: string; cw: number; ch: number; x: number; y: number; blocked: boolean }>
      >(parent.frame, IFRAME_LIST_FN)
      if (!list) continue
      const kids = tree.filter((e) => e.parentKey === parent.key)
      for (const it of list) {
        if (!it.blocked) continue
        // 关联子 frame：name → src → 尺寸 → 顺序
        let kid: (typeof kids)[number] | undefined
        if (it.name) {
          for (const k of kids) {
            const p = await runInFrame<{ name: string }>(k.frame, FRAME_PROBE_FN)
            if (p && p.name === it.name) {
              kid = k
              break
            }
          }
        }
        if (!kid && it.src) {
          const bySrc = kids.filter((k) => k.url && (k.url.startsWith(it.src) || it.src.startsWith(k.url)))
          if (bySrc.length === 1) kid = bySrc[0]
        }
        if (!kid) {
          for (const k of kids) {
            const p = await runInFrame<{ iw: number; ih: number }>(k.frame, FRAME_PROBE_FN)
            if (p && Math.abs(p.iw - it.cw) <= 12 && Math.abs(p.ih - it.ch) <= 12) {
              kid = k
              break
            }
          }
        }
        if (!kid && it.i < kids.length) kid = kids[it.i]
        if (!kid || served.has(kid.key)) continue
        served.add(kid.key)
        if (it.src) servedSrcs.push(it.src)
        const sub = await runInFrame<ExtractResult>(kid.frame, extractFn, [maxElements, true, textCap || 80])
        if (!sub || !Array.isArray(sub.candidates) || !sub.candidates.length) continue
        progressed = true
        const off = await frameOffset(wc, kid, tree)
        for (const c of sub.candidates as Candidate[]) {
          if (added >= candBudget) break
          const rect = { ...c.rect }
          if (off) {
            rect.x += off.x
            rect.y += off.y
          }
          const dup = res.candidates.some(
            (e) =>
              e.tag === c.tag &&
              e.text === c.text &&
              Math.abs(e.rect.x - rect.x) <= 2 &&
              Math.abs(e.rect.y - rect.y) <= 2
          )
          if (dup) continue
          const cand: Candidate = {
            ...c,
            framePaths: [],
            frameKey: kid!.key,
            rect,
            inViewport: off ? rect.y + rect.h > 0 && rect.y < viewportH : false // 坐标解不出=仅供读
          }
          res.candidates.push(cand)
          added++
        }
      }
    }
    if (!progressed) break
  }
  // 已补充的 src 从「跨域不可见」名单移除（剩下的才是真正没救到的）
  if (servedSrcs.length) {
    res.blockedFrames = (res.blockedFrames || []).filter(
      (s) => !servedSrcs.some((sv) => sv && (s.includes(sv) || sv.includes(s)))
    )
  }
  return added
}

/** read_content 跨域补充：对 contentDocument 读不到的 frame 在自身上下文跑 readContentFn，
 *  返回拼接文本（已含各 frame 内部的同源嵌套内容）。 */
export async function supplementReadContent(
  wc: WebContents,
  readFn: string,
  maxCharsEach: number,
  budget = 4
): Promise<string> {
  const parts: string[] = []
  const tree = frameTree(wc)
  for (const entry of tree) {
    if (parts.length >= budget) break
    if (entry.depth === 0) continue // 主 frame 已由顶层 read_content 覆盖
    // 只补跨域挡读的 frame：父文档列出 iframe 后按 name/src/顺序关联（与 supplementExtract 同法）
    const parent = tree.find((e) => e.key === entry.parentKey)
    if (!parent) continue
    const list = await runInFrame<Array<{ i: number; src: string; name: string; blocked: boolean }>>(
      parent.frame,
      IFRAME_LIST_FN
    )
    const probe = await runInFrame<{ name: string; url: string }>(entry.frame, FRAME_PROBE_FN)
    if (!list || !probe) continue
    const siblings = tree.filter((e) => e.parentKey === entry.parentKey)
    const sibIdx = siblings.indexOf(entry)
    let hit = list.find((it) => it.name && it.name === probe.name)
    if (!hit && entry.url) {
      const bySrc = list.filter((it) => it.src && (entry.url.startsWith(it.src) || it.src.startsWith(entry.url)))
      if (bySrc.length === 1) hit = bySrc[0]
    }
    if (!hit && sibIdx >= 0 && sibIdx < list.length) hit = list[sibIdx]
    if (!hit || !hit.blocked) continue // 同源 frame 已被递归版 read_content 覆盖
    const r = await runInFrame<{ text?: string }>(entry.frame, readFn, [maxCharsEach])
    if (r && r.text) parts.push(`[跨域iframe ${entry.url.slice(0, 60)}]\n${r.text}`)
  }
  return parts.join('\n\n')
}
