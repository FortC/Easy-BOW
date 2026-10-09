/**
 * 度量体系 S0 —— 任务级 trace 埋点。
 * 每个任务一个 jsonl 文件（一行一事件，追加写），落盘 userData/traces/{yyyyMMdd}/{taskId}.jsonl。
 * 核心用途：任务成功率 / 截断率（totalFound > candidates）/ token 消耗 / 人工介入率 /
 * 风控触发率的基线与前后对比。写盘失败静默吞掉（风险表：不得因埋点中断任务）。
 */
import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export type TraceEventType =
  | 'task_start'
  | 'task_end'
  | 'extract'
  | 'llm_call'
  | 'action'
  | 'verify'
  | 'failure'
  | 'human'
  | 'friction'

export interface TraceEvent {
  ts: number
  taskId: string
  step: number
  type: TraceEventType
  data: Record<string, unknown>
}

export class Telemetry {
  private taskId = ''
  private file = ''
  private active = false
  private ended = false

  /** 任务启动：建目录、写 task_start；enabled=false（设置关闭）时完全静默 */
  start(task: string, enabled = true): void {
    this.active = enabled
    this.ended = false
    if (!enabled) return
    try {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
      this.taskId = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
      const dir = join(app.getPath('userData'), 'traces', day)
      mkdirSync(dir, { recursive: true })
      this.file = join(dir, `${this.taskId}.jsonl`)
      this.write({ ts: Date.now(), taskId: this.taskId, step: 0, type: 'task_start', data: { task: task.slice(0, 300) } })
    } catch {
      this.active = false
    }
  }

  /** 追加一条事件（未启动/已结束/写失败都静默） */
  log(type: TraceEventType, step: number, data: Record<string, unknown> = {}): void {
    if (!this.active || this.ended) return
    try {
      this.write({ ts: Date.now(), taskId: this.taskId, step, type, data })
    } catch {}
  }

  /** 任务收尾（幂等）：task_end 带最终状态与累计指标 */
  end(summary: { state: string; steps?: number; tokens?: { inputTokens: number; outputTokens: number } }): void {
    if (!this.active || this.ended) return
    this.ended = true
    try {
      this.write({
        ts: Date.now(),
        taskId: this.taskId,
        step: summary.steps || 0,
        type: 'task_end',
        data: {
          state: summary.state,
          steps: summary.steps,
          tokensIn: summary.tokens?.inputTokens,
          tokensOut: summary.tokens?.outputTokens
        }
      })
    } catch {}
  }

  /** 是否有进行中的 trace（测试用） */
  get recording(): boolean {
    return this.active && !this.ended
  }

  get filePath(): string {
    return this.file
  }

  private write(ev: TraceEvent): void {
    if (!this.file) return
    appendFileSync(this.file, JSON.stringify(ev) + '\n', 'utf-8')
  }
}
