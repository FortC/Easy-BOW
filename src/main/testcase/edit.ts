/**
 * 测试用例 MD 的行内编辑（纯字符串操作，无 LLM/浏览器依赖——自测覆盖）。
 *
 * 需求：面板里改一步（标题/操作/预期），保存后要「重新识别并重新生成其下方任务节点」。
 * 做法：按行定位第 N 个步骤小块（### 小节，跨「## 步骤」「## 清理」统一按出现顺序编号，
 * 与 parser 的 steps 顺序一致），整块重建文本 —— 其后的步骤天然被重新解析、重新编号。
 *
 * 只重写被编辑块的文本，其余行原样保留（含用例名、数据表、注释），避免"保存即重排全文"。
 */
import type { TestStep } from '@shared/types'

export interface StepBlock {
  /** 块首行（### 行）在 lines 中的下标 */
  start: number
  /** 块结束（不含） */
  end: number
  /** 块内标题（已去「### 」前缀，未加清理前缀） */
  title: string
  /** 块是否位于「## 清理」区块内 */
  cleanup: boolean
  /** 原始行文本（含 ### 行与其下所有行） */
  lines: string[]
}

/** 找出所有步骤块（按文件出现顺序编号，与 parser 的 steps 一一对应） */
export function locateStepBlocks(md: string): StepBlock[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  return locateStepBlocksFromLines(lines)
}

export function locateStepBlocksFromLines(lines: string[]): StepBlock[] {
  const blocks: StepBlock[] = []
  let inSection = false
  let cleanup = false
  let i = 0
  for (; i < lines.length; i++) {
    const l = lines[i]
    const t = l.trim()
    // 注意：(?!#) 排除 ### —— 否则「### 步骤 1」会被当成二级标题吞掉，一个块都定位不到
    const h2 = t.match(/^##(?!#)\s*(.+)$/)
    if (h2) {
      const name = h2[1]
      inSection = /步骤|清理/.test(name)
      cleanup = /清理/.test(name)
      continue
    }
    if (!inSection) continue
    const m = t.match(/^###(?!#)\s*(?:步骤\s*\d+\s*[:：]\s*)?(.+)$/)
    if (!m) continue
    // 块范围：到下一个 ### / ## / 文件尾
    let j = i + 1
    for (; j < lines.length; j++) {
      const s = lines[j].trim()
      if (/^###(?!#)\s/.test(s) || /^##(?!#)\s/.test(s)) break
    }
    // 尾部空行归给下一块（保持块间一个空行）
    let end = j
    while (end > i + 1 && !lines[end - 1].trim()) end--
    blocks.push({ start: i, end, title: m[1].trim(), cleanup, lines: lines.slice(i, end) })
    i = j - 1
  }
  return blocks
}

/** 把一条步骤渲染成 MD 小块行（不含尾随空行） */
export function renderStepBlock(step: { title: string; action: string; assertions?: string[]; dialog?: 'accept' | 'dismiss' | '' }, cleanup = false): string[] {
  const out: string[] = []
  out.push(`### ${step.title}`)
  if (step.action) out.push(`- 操作: ${step.action}`)
  for (const a of step.assertions || []) {
    const v = String(a || '').trim()
    if (v) out.push(`- 预期: ${v}`)
  }
  if (step.dialog === 'accept' || step.dialog === 'dismiss') {
    out.push(`- 弹窗: ${step.dialog === 'dismiss' ? '取消' : '确认'}`)
  }
  void cleanup
  return out
}

/** 从块文本里读出结构化内容（行内编辑表单的初值） */
export function readStepBlock(block: StepBlock): { title: string; action: string; assertions: string[]; dialog?: string } {
  let action = ''
  const assertions: string[] = []
  let dialog: string | undefined
  for (const l of block.lines.slice(1)) {
    const t = l.trim()
    const actM = t.match(/^[-*]\s*(?:操作|动作)\s*[:：]\s*(.+)$/)
    if (actM) {
      action = actM[1].trim()
      continue
    }
    const expM = t.match(/^[-*]\s*(?:预期|期望|断言)\s*[:：]\s*(.+)$/)
    if (expM) {
      assertions.push(expM[1].trim())
      continue
    }
    const dlgM = t.match(/^[-*]\s*弹窗\s*[:：]\s*(确认|接受|accept|取消|拒绝|dismiss)\s*$/i)
    if (dlgM) {
      const v = dlgM[1].toLowerCase()
      dialog = v === '取消' || v === '拒绝' || v === 'dismiss' ? 'dismiss' : 'accept'
    }
  }
  return { title: block.title, action, assertions, dialog }
}

export interface EditResult {
  ok: boolean
  md?: string
  error?: string
}

function splice(lines: string[], start: number, end: number, replacement: string[]): string[] {
  return [...lines.slice(0, start), ...replacement, '', ...lines.slice(end)]
}

/** 更新第 index 个步骤（1-based） */
export function updateStep(md: string, index: number, patch: { title?: string; action?: string; assertions?: string[]; dialog?: 'accept' | 'dismiss' | '' }): EditResult {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks = locateStepBlocksFromLines(lines)
  if (!blocks.length) return { ok: false, error: '用例里没有可编辑的步骤块' }
  if (!Number.isInteger(index) || index < 1 || index > blocks.length) {
    return { ok: false, error: `步骤序号 ${index} 超出范围（共 ${blocks.length} 步）` }
  }
  const b = blocks[index - 1]
  const cur = readStepBlock(b)
  const next = {
    title: (patch.title ?? cur.title).trim() || cur.title,
    action: patch.action !== undefined ? patch.action.trim() : cur.action,
    assertions: patch.assertions !== undefined ? patch.assertions : cur.assertions,
    dialog: patch.dialog !== undefined ? patch.dialog : (cur.dialog as any)
  }
  if (!next.action) return { ok: false, error: '「操作」不能为空（解析器要求每步都有操作）' }
  const rendered = renderStepBlock(next, b.cleanup)
  const out = splice(lines, b.start, b.end, rendered)
  return { ok: true, md: normalize(out) }
}

/** 删除第 index 个步骤 */
export function deleteStep(md: string, index: number): EditResult {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks = locateStepBlocksFromLines(lines)
  if (!Number.isInteger(index) || index < 1 || index > blocks.length) {
    return { ok: false, error: `步骤序号 ${index} 超出范围（共 ${blocks.length} 步）` }
  }
  const b = blocks[index - 1]
  const out = [...lines.slice(0, b.start), ...lines.slice(b.end)]
  return { ok: true, md: normalize(out) }
}

/** 在第 index 个步骤**下方**插入新步骤（index=0 表示插到最前面） */
export function insertStep(md: string, index: number, step: { title?: string; action?: string; assertions?: string[]; dialog?: 'accept' | 'dismiss' | '' }): EditResult {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const blocks = locateStepBlocksFromLines(lines)
  if (!blocks.length) return { ok: false, error: '用例里没有步骤区块，无法插入' }
  const action = (step.action || '').trim()
  if (!action) return { ok: false, error: '新步骤的「操作」不能为空' }
  let start: number
  let cleanup = false
  if (index <= 0) {
    start = blocks[0].start
  } else if (index > blocks.length) {
    const last = blocks[blocks.length - 1]
    start = last.end
    cleanup = last.cleanup
  } else {
    const b = blocks[index - 1]
    start = b.end
    cleanup = b.cleanup
  }
  const rendered = renderStepBlock(
    { title: (step.title || '新步骤').trim(), action, assertions: step.assertions || [], dialog: step.dialog },
    cleanup
  )
  const out = [...lines.slice(0, start), ...rendered, '', ...lines.slice(start)]
  return { ok: true, md: normalize(out) }
}

/** 收尾：去掉连续 3+ 空行，文件末尾恰好一个换行 */
function normalize(lines: string[]): string {
  const out: string[] = []
  let blank = 0
  for (const l of lines) {
    if (!l.trim()) {
      blank++
      if (blank > 1) continue
    } else {
      blank = 0
    }
    out.push(l)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n') + '\n'
}

/** 供 UI 预览：解析结果 → 步骤节点明细 */
export function stepPreview(tc: { steps: TestStep[] }): Array<{
  index: number
  title: string
  action: string
  assertions: string[]
  dialog?: 'accept' | 'dismiss'
  login?: boolean
  cleanup?: boolean
}> {
  return tc.steps.map((s, i) => ({
    index: i + 1,
    title: s.title,
    action: s.action,
    assertions: s.assertions.map((a) => a.raw),
    dialog: s.dialog,
    login: s.login,
    cleanup: s.title.startsWith('清理:')
  }))
}
