import { createHash } from 'crypto'
import type { AgentAction, TestStep } from '../../shared/types'
import type { Candidate } from '../extractor'

export interface StepPlan {
  version: 1
  key: string
  createdAt: number
  actions: AgentAction[]
}

export function planKey(step: TestStep, baseUrl: string, caseName: string): string {
  return createHash('sha256').update(JSON.stringify([1, caseName, baseUrl, step.action, step.assertions.map((a) => a.raw)])).digest('hex')
}

export function candidateTarget(c: Candidate): NonNullable<AgentAction['target']> {
  const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(c.tag)
  return { role: c.role, tag: c.tag, label: field ? c.extra : c.fullText || c.text || c.extra,
    anchor: c.anchor, frameKey: c.frameKey, framePaths: c.framePaths }
}

export function resolveTarget(target: NonNullable<AgentAction['target']>, candidates: Candidate[]): number {
  if (!target.label.trim()) return -1
  const matches = candidates.map((c, i) => ({ target: candidateTarget(c), i })).filter(({ target: t }) =>
    t.role === target.role && t.tag === target.tag && t.label === target.label &&
    (t.anchor || '') === (target.anchor || '') && (t.frameKey || '') === (target.frameKey || '') &&
    JSON.stringify(t.framePaths) === JSON.stringify(target.framePaths))
  return matches.length === 1 ? matches[0].i : -1
}

/** 缓存只保留已验证动作、语义目标和变量引用，不落盘坐标/编号/输入凭据。 */
export function reusableActions(actions: AgentAction[], memory: Record<string, string>): AgentAction[] | null {
  const out: AgentAction[] = []
  for (const a of actions) {
    if (a.error || !['click', 'type', 'hover', 'scroll', 'goto', 'wait_for'].includes(a.name)) return null
    const item: AgentAction = { name: a.name }
    if (['click', 'type', 'hover'].includes(a.name)) {
      if (!a.target?.label.trim()) return null
      item.target = a.target
    }
    if (a.name === 'type') {
      const key = Object.keys(memory).find((k) => memory[k] && (a.text === memory[k] || a.text === `{{${k}}}`))
      if (!key) return null
      item.text = `{{${key}}}`
    }
    if (a.name === 'goto') {
      if (!a.url) return null
      if (a.url.includes('{{base_url}}')) item.url = a.url
      else if (memory.base_url && a.url.startsWith(memory.base_url)) item.url = '{{base_url}}' + a.url.slice(memory.base_url.length)
      else return null
      if (/[?#]/.test(item.url)) return null
    }
    if (a.name === 'scroll') { item.direction = a.direction; item.amount = a.amount }
    // 等待条件可能含业务数据；只复用完全由变量引用组成的值。
    if (a.name === 'wait_for') {
      if (!a.value || !/^\{\{[^}]+\}\}$/.test(a.value)) return null
      item.kind = a.kind; item.value = a.value; item.method = a.method; item.seconds = a.seconds
    }
    out.push(item)
  }
  return out.length && out.length <= 40 ? out : null
}
