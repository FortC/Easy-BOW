import { BookOpen, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { KBEntry } from '@shared/types'
import { useModalFocus } from '../hooks/useDelayedUnmount'

/**
 * 问题经验库：积累「某站点某问题的正确处理方式」，任务执行时按域名注入 AI 提示词，
 * 避免重复踩坑（如：腾讯文档点正文即可编辑，不要找输入框）。
 */
export default function KnowledgeModal(props: { open: boolean; onClose: () => void }) {
  const [list, setList] = useState<KBEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [editing, setEditing] = useState<KBEntry | null>(null)
  const [domain, setDomain] = useState('')
  const [problem, setProblem] = useState('')
  const [solution, setSolution] = useState('')
  const [saving, setSaving] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { closing, requestClose, onBackdropClick } = useModalFocus(bodyRef, props.onClose, props.open)

  useEffect(() => {
    window.easybow.getKB().then((l) => {
      setList(l)
      setLoaded(true)
    })
  }, [])

  const persist = async (next: KBEntry[]) => {
    setSaving(true)
    try {
      setList(await window.easybow.setKB(next))
    } finally {
      setSaving(false)
    }
  }

  const resetForm = () => {
    setEditing(null)
    setDomain('')
    setProblem('')
    setSolution('')
  }

  const submit = async () => {
    if (!solution.trim()) return
    const entry: KBEntry = {
      id: editing?.id ?? Date.now(),
      domain: domain.trim(),
      problem: problem.trim(),
      solution: solution.trim(),
      enabled: true
    }
    const next = editing ? list.map((e) => (e.id === editing.id ? entry : e)) : [entry, ...list]
    await persist(next)
    resetForm()
  }

  return (
    <div className="modal-mask" onClick={onBackdropClick}>
      <div
        ref={bodyRef}
        className={`modal kb-modal${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="问题经验库"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 className="with-ico"><BookOpen size={16} strokeWidth={2} /> 问题经验库</h3>
          <button className="close-x" aria-label="关闭问题经验库" title="关闭（Esc）" onClick={requestClose}>
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        <div className="modal-body">
          <p className="kb-intro">
            把踩过的坑记在这里：AI 执行任务遇到匹配的站点时会看到对应做法，不再重复犯错。域名留空表示对所有站点生效。
          </p>

        <div className="kb-form">
          <div className="form-inline">
            <div className="form-row">
              <label>站点域名（如 docs.qq.com，留空=全局）</label>
              <input value={domain} placeholder="docs.qq.com" onChange={(e) => setDomain(e.target.value.trim())} />
            </div>
            <div className="form-row">
              <label>问题描述（简短）</label>
              <input value={problem} placeholder="如：找不到输入框" onChange={(e) => setProblem(e.target.value)} />
            </div>
          </div>
          <div className="form-row">
            <label>正确做法（AI 将按此执行）</label>
            <textarea
              className="kb-solution"
              value={solution}
              placeholder={'如：点击正文区域直接进入编辑状态，然后对正文输入；不要用浏览器查找(Ctrl+F)输入'}
              onChange={(e) => setSolution(e.target.value)}
            />
          </div>
          <div className="kb-form-ops">
            <button className="btn primary" onClick={submit} disabled={!solution.trim() || saving}>
              {editing ? '保存修改' : '＋ 添加'}
            </button>
            {editing && (
              <button className="btn" onClick={resetForm}>
                取消编辑
              </button>
            )}
          </div>
        </div>

        <div className="kb-list">
          {!loaded ? (
            <>
              <div className="skeleton skeleton-row" />
              <div className="skeleton skeleton-row" style={{ opacity: 0.7 }} />
              <div className="skeleton skeleton-row" style={{ opacity: 0.5 }} />
            </>
          ) : list.length === 0 ? (
            <div className="kb-empty">还没有经验条目，添加一条吧</div>
          ) : (
            list.map((e) => (
              <div key={e.id} className={`kb-item${e.enabled ? '' : ' off'}`}>
                <div className="kb-item-head">
                  <span className="kb-domain">{e.domain || '全局'}</span>
                  <span className="kb-problem">{e.problem || '（无标题）'}</span>
                  <span className="kb-item-ops">
                    <button
                      title={e.enabled ? '停用' : '启用'}
                      aria-label={`${e.enabled ? '停用' : '启用'} ${e.problem || e.domain || '该条目'}`}
                      onClick={() => persist(list.map((x) => (x.id === e.id ? { ...x, enabled: !x.enabled } : x)))}
                    >
                      {e.enabled ? '✅' : '⛔'}
                    </button>
                    <button
                      title="编辑"
                      aria-label={`编辑 ${e.problem || e.domain || '该条目'}`}
                      onClick={() => {
                        setEditing(e)
                        setDomain(e.domain)
                        setProblem(e.problem)
                        setSolution(e.solution)
                      }}
                    >
                      <Pencil size={12} strokeWidth={2} />
                    </button>
                    <button
                      title="删除"
                      aria-label={`删除 ${e.problem || e.domain || '该条目'}`}
                      onClick={() => persist(list.filter((x) => x.id !== e.id))}
                    >
                      <Trash2 size={12} strokeWidth={2} />
                    </button>
                  </span>
                </div>
                <div className="kb-solution-text">{e.solution}</div>
              </div>
            ))
          )}
        </div>
        </div>
      </div>
    </div>
  )
}
