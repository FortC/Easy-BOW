import { useEffect, useRef, useState } from 'react'
import type { Schedule } from '@shared/types'
import { useModalFocus } from '../hooks/useDelayedUnmount'

type Policy = 'once' | 'daily' | 'interval'

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function describe(s: Schedule): string {
  if (s.type === 'once') return `单次 · ${fmtTime(s.at ?? 0)}`
  if (s.type === 'interval') return `每 ${s.intervalMin} 分钟`
  const m = s.dailyMinute ?? 0
  return `每天 ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 定时任务：把任务描述交给 AI 定时执行（与 AI 对话新增 / 维护列表 / 改策略；可绑定测试用例做定时回归） */
export default function ScheduleModal(props: {
  /** 是否处于打开状态（组件常驻挂载，靠它控制显隐与动画） */
  open: boolean
  initialTask: string
  /** 预绑定测试用例（来自测试面板用例库的 ⏰ 按钮）：到点跑该用例而非自由任务 */
  initialTestCase?: { id: number; name: string }
  onClose: () => void
  onToast: (msg: string, kind?: 'info' | 'success' | 'error') => void
}) {
  const [list, setList] = useState<Schedule[]>([])
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [task, setTask] = useState(props.initialTask || props.initialTestCase?.name || '')
  const [name, setName] = useState(props.initialTestCase ? `回归: ${props.initialTestCase.name}` : '')
  const [boundCaseId, setBoundCaseId] = useState<number | undefined>(props.initialTestCase?.id)
  const [policy, setPolicy] = useState<Policy>('daily')
  const [atLocal, setAtLocal] = useState(() => {
    const d = new Date(Date.now() + 3600_000)
    d.setSeconds(0, 0)
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  })
  const [dailyTime, setDailyTime] = useState('09:00')
  const [intervalMin, setIntervalMin] = useState(30)
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { closing, requestClose, onBackdropClick } = useModalFocus(bodyRef, props.onClose, props.open)

  const refresh = () => window.easybow.getSchedules().then(setList).catch(() => {})
  useEffect(() => {
    refresh()
  }, [])

  // 首次打开时把任务名预填一次（常驻挂载，initialTask 变化不应覆盖用户已输入的内容）
  const prefilledRef = useRef(false)
  useEffect(() => {
    if (!props.open || prefilledRef.current) return
    prefilledRef.current = true
    if (props.initialTask && !task) setTask(props.initialTask)
    if (props.initialTestCase) {
      setName(`回归: ${props.initialTestCase.name}`)
      setBoundCaseId(props.initialTestCase.id)
    }
  }, [props.open])

  const startEdit = (s: Schedule) => {
    setEditing(s)
    setTask(s.task)
    setName(s.name)
    setBoundCaseId(s.testCaseId)
    setPolicy(s.type)
    if (s.type === 'once' && s.at) {
      const d = new Date(s.at)
      setAtLocal(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16))
    } else if (s.type === 'daily') {
      setDailyTime(`${String(Math.floor((s.dailyMinute ?? 540) / 60)).padStart(2, '0')}:${String((s.dailyMinute ?? 540) % 60).padStart(2, '0')}`)
    } else if (s.type === 'interval') {
      setIntervalMin(s.intervalMin ?? 30)
    }
  }

  const resetForm = () => {
    setEditing(null)
    setTask(props.initialTask || props.initialTestCase?.name || '')
    setName(props.initialTestCase ? `回归: ${props.initialTestCase.name}` : '')
    setBoundCaseId(props.initialTestCase?.id)
  }

  const save = async () => {
    const t = task.trim()
    if (!t) {
      props.onToast('请填写任务描述（到点交给 AI 执行的指令）', 'error')
      return
    }
    setSaving(true)
    try {
      const base = {
        name: name.trim() || t.slice(0, 20),
        task: t,
        ...(boundCaseId != null ? { testCaseId: boundCaseId } : {}),
        enabled: true,
        type: policy,
        ...(policy === 'once' ? { at: new Date(atLocal).getTime() } : {}),
        ...(policy === 'daily' ? { dailyMinute: Number(dailyTime.slice(0, 2)) * 60 + Number(dailyTime.slice(3, 5)) } : {}),
        ...(policy === 'interval' ? { intervalMin: Math.max(1, Math.min(1440, intervalMin)) } : {})
      }
      const updated = await window.easybow.saveSchedule(editing ? { ...base, id: editing.id } : base)
      setList(updated)
      props.onToast(editing ? '定时任务已更新' : `定时任务已创建（${describe({ ...(base as any), nextRun: 0, id: 0, createdAt: 0 })}）`, 'success')
      resetForm()
    } catch (e: any) {
      props.onToast(e?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const toggle = async (s: Schedule) => {
    const updated = await window.easybow.saveSchedule({
      name: s.name,
      task: s.task,
      enabled: !s.enabled,
      type: s.type,
      at: s.at,
      dailyMinute: s.dailyMinute,
      intervalMin: s.intervalMin,
      id: s.id
    })
    setList(updated)
  }

  const del = async (s: Schedule) => {
    const updated = await window.easybow.deleteSchedule(s.id)
    setList(updated)
    if (editing?.id === s.id) resetForm()
    props.onToast(`已删除「${s.name}」`, 'info')
  }

  return (
    <div className="modal-mask" onClick={onBackdropClick}>
      <div
        ref={bodyRef}
        className={`modal${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="定时任务"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3>⏰ 定时任务{editing ? '（编辑）' : '（新增）'}</h3>
          <button className="close-x" aria-label="关闭定时任务" title="关闭（Esc）" onClick={requestClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">

        <div className="form-row">
          <label>任务描述（到点自动交给 AI 执行）</label>
          <textarea
            className="sch-task-input"
            value={task}
            placeholder="例：打开聚水潭，把今天的待发货订单号整理到腾讯文档《发货清单》，按买家留言备注优先级"
            onChange={(e) => setTask(e.target.value)}
            rows={3}
          />
        </div>
        {boundCaseId != null && (
          <div className="field-hint test-warn">
            🧪 已绑定测试用例（定时回归）：到点自动在独立测试页签执行该用例并生成报告，不执行上面的任务描述
            <button className="btn mini unbind-btn" onClick={() => setBoundCaseId(undefined)}>
              解绑（改为普通任务）
            </button>
          </div>
        )}
        <div className="form-row">
          <label>任务名（可选，默认取描述前 20 字）</label>
          <input value={name} placeholder="例：每日发货清单" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>定时策略</label>
            <select value={policy} onChange={(e) => setPolicy(e.target.value as Policy)}>
              <option value="daily">每天定时</option>
              <option value="interval">固定间隔循环</option>
              <option value="once">单次（指定时间）</option>
            </select>
          </div>
          <div className="form-row">
            {policy === 'once' && (
              <>
                <label>执行时间</label>
                <input type="datetime-local" value={atLocal} onChange={(e) => setAtLocal(e.target.value)} />
              </>
            )}
            {policy === 'daily' && (
              <>
                <label>每天时间</label>
                <input type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value)} />
              </>
            )}
            {policy === 'interval' && (
              <>
                <label>间隔（分钟，1-1440）</label>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={intervalMin}
                  onChange={(e) => setIntervalMin(Math.max(1, Math.min(1440, Number(e.target.value) || 30)))}
                />
              </>
            )}
          </div>
        </div>

        {list.length > 0 && (
          <>
            <div className="sch-list-title">已有定时任务（{list.length}）</div>
            <div className="sch-list">
              {list.map((s) => (
                <div key={s.id} className={`sch-item ${s.enabled ? '' : 'off'}`}>
                  <div className="sch-item-main">
                    <div className="sch-item-name">
                      {s.enabled ? '⏰' : '⏸'}
                      {s.testCaseId != null ? '🧪' : ''} {s.name}
                      <span className="sch-item-policy">{describe(s)}</span>
                    </div>
                    <div className="sch-item-meta">
                      {s.enabled ? `下次: ${fmtTime(s.nextRun)}` : '已停用'}
                      {s.lastRun ? ` · 上次: ${fmtTime(s.lastRun)}` : ''}
                    </div>
                  </div>
                  <div className="sch-item-ops">
                    <button className="btn mini" onClick={() => startEdit(s)} title="修改任务/策略">
                      改
                    </button>
                    <button className="btn mini" onClick={() => toggle(s)}>
                      {s.enabled ? '停' : '启'}
                    </button>
                    <button className="btn mini danger" onClick={() => del(s)}>
                      删
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="field-hint">执行前 1 分钟顶部会出现倒计时提示，可一键取消本次执行</div>
          </>
        )}
        </div>

        <div className="modal-foot">
          {editing && (
            <button className="btn" onClick={resetForm}>
              取消编辑
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : editing ? '保存修改' : '创建定时任务'}
          </button>
        </div>
      </div>
    </div>
  )
}
