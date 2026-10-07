/**
 * 定时任务调度器：到点自动把任务描述交给 AI（AgentRunner.startTask）执行。
 * - 执行前 60 秒开始每秒广播 schedule-countdown（UI 顶部倒计时条 + 取消按钮）
 * - 触发时 AI 正忙则跳过本次（toast 说明），空闲则自动开跑
 * - 持久化到 userData/schedules.json；once 执行后自动停用（保留记录可重新启用）
 */
import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import type { MainEvent, Schedule } from '@shared/types'

type Broadcast = (ev: MainEvent) => void
type RunTask = (task: string) => Promise<void>
type IsIdle = () => boolean

/** 计算下一次触发时间戳（纯函数，自测覆盖） */
export function computeNextRun(s: Pick<Schedule, 'type' | 'at' | 'dailyMinute' | 'intervalMin'>, from = Date.now()): number {
  if (s.type === 'once') return Math.max(0, s.at ?? from)
  if (s.type === 'interval') return from + Math.max(1, s.intervalMin ?? 60) * 60_000
  if (s.type === 'daily') {
    const m = Math.min(Math.max(s.dailyMinute ?? 540, 0), 1439)
    const d = new Date(from)
    d.setHours(Math.floor(m / 60), m % 60, 0, 0)
    if (d.getTime() <= from) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return from
}

/** 策略的人类可读描述（UI/提示用） */
export function describePolicy(s: Pick<Schedule, 'type' | 'at' | 'dailyMinute' | 'intervalMin'>): string {
  if (s.type === 'once') return `单次 · ${new Date(s.at ?? 0).toLocaleString('zh-CN', { hour12: false })}`
  if (s.type === 'interval') return `每 ${s.intervalMin ?? 60} 分钟`
  const m = s.dailyMinute ?? 540
  return `每天 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export class Scheduler {
  private broadcast: Broadcast
  private runTask: RunTask
  private isIdle: IsIdle
  private schedules: Schedule[] = []
  private nextId = 1
  private timer: NodeJS.Timeout | null = null
  /** 本次已取消触发的任务 id（到点时检查并跳过） */
  private cancelledThisRound = new Set<number>()
  private file = join(app.getPath('userData'), 'schedules.json')

  constructor(broadcast: Broadcast, runTask: RunTask, isIdle: IsIdle) {
    this.broadcast = broadcast
    this.runTask = runTask
    this.isIdle = isIdle
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (Array.isArray(raw)) this.schedules = raw
    } catch {}
    // 启动时重算 nextRun：错过的 once 不补跑（改为停用），daily/interval 顺延到下一轮
    const now = Date.now()
    for (const s of this.schedules) {
      if (s.type === 'once' && s.nextRun <= now) {
        if (s.enabled) s.enabled = false
        continue
      }
      if (s.nextRun <= now) s.nextRun = computeNextRun(s, now)
    }
    this.nextId = Math.max(0, ...this.schedules.map((s) => s.id)) + 1
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.schedules, null, 2))
    } catch {}
    this.broadcast({ channel: 'schedules', schedules: this.schedules })
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 1000)
    this.broadcast({ channel: 'schedules', schedules: this.schedules })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): Schedule[] {
    return this.schedules
  }

  save(input: Omit<Schedule, 'id' | 'createdAt' | 'nextRun' | 'lastRun'> & { id?: number }): Schedule[] {
    // 前端按策略条件展开字段（改 interval 时不带 at/dailyMinute）：
    // 过滤 undefined 防止整体覆盖写入 undefined，并按当前策略清理异构字段，
    // 避免脏数据潜伏（undefined 在 JSON 持久化时自然丢弃）
    const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as typeof input
    if (patch.id != null) {
      const s = this.schedules.find((x) => x.id === patch.id)
      if (!s) throw new Error(`定时任务 ${patch.id} 不存在`)
      Object.assign(s, patch)
      if (s.type === 'once') {
        s.dailyMinute = undefined
        s.intervalMin = undefined
      } else if (s.type === 'daily') {
        s.at = undefined
        s.intervalMin = undefined
      } else {
        s.at = undefined
        s.dailyMinute = undefined
      }
      s.nextRun = computeNextRun(s)
      this.cancelledThisRound.delete(s.id)
    } else {
      const s: Schedule = {
        id: this.nextId++,
        name: patch.name || patch.task.slice(0, 20) || '未命名任务',
        task: patch.task,
        enabled: patch.enabled,
        type: patch.type,
        at: patch.at,
        dailyMinute: patch.dailyMinute,
        intervalMin: patch.intervalMin,
        createdAt: Date.now(),
        nextRun: 0
      }
      s.nextRun = computeNextRun(s)
      this.schedules.push(s)
    }
    this.persist()
    return this.schedules
  }

  remove(id: number): Schedule[] {
    this.schedules = this.schedules.filter((s) => s.id !== id)
    this.persist()
    return this.schedules
  }

  /** 取消即将执行的这一次（不改策略，下一轮照常） */
  cancelRun(id: number): Schedule[] {
    const s = this.schedules.find((x) => x.id === id)
    if (!s) return this.schedules
    this.cancelledThisRound.add(id)
    s.nextRun = computeNextRun(s, Date.now()) // 直接顺延到下一轮
    this.persist()
    this.broadcast({ channel: 'toast', message: `已取消「${s.name}」本次执行`, kind: 'info' })
    return this.schedules
  }

  private tick(): void {
    const now = Date.now()
    let dirty = false
    for (const s of this.schedules) {
      if (!s.enabled) continue
      const left = Math.round((s.nextRun - now) / 1000)
      // 触发前 60s：每秒推送倒计时（UI 顶部条 + 取消）
      if (left > 0 && left <= 60) {
        this.broadcast({ channel: 'schedule-countdown', id: s.id, name: s.name, secondsLeft: left })
      }
      if (left <= 0) {
        // 计算下一轮（先算，once 会因 enabled=false 不再触发）
        const cancelled = this.cancelledThisRound.has(s.id)
        this.cancelledThisRound.delete(s.id)
        s.lastRun = now
        if (s.type === 'once') {
          s.enabled = false
        } else {
          s.nextRun = computeNextRun(s, now)
        }
        dirty = true
        if (cancelled) {
          this.broadcast({ channel: 'toast', message: `「${s.name}」本次已跳过（用户取消）`, kind: 'info' })
          continue
        }
        if (!this.isIdle()) {
          this.broadcast({ channel: 'toast', message: `定时任务「${s.name}」到点，但 AI 正在执行其他任务，本次跳过`, kind: 'error' })
          continue
        }
        this.broadcast({ channel: 'toast', message: `⏰ 定时任务开始：${s.name}`, kind: 'success' })
        this.runTask(s.task).catch((e) => {
          this.broadcast({ channel: 'toast', message: `定时任务「${s.name}」启动失败: ${e?.message || e}`, kind: 'error' })
        })
      }
    }
    if (dirty) this.persist()
  }
}
