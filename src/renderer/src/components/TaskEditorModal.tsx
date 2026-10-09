import { Check, PenLine, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TaskTemplate } from '@shared/types'
import { useModalFocus } from '../hooks/useDelayedUnmount'

export default function TaskEditorModal(props: {
  /** 是否处于打开状态（用于焦点管理，退场由 App 的延迟卸载处理） */
  open: boolean
  task: string
  setTask: (t: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const { closing, requestClose, onBackdropClick } = useModalFocus(bodyRef, props.onClose, props.open)
  // 任务模板库（与任务输入框共用一份；此处插入到文本末尾，{{字段:说明}} 留给用户自行填）
  const [tplList, setTplList] = useState<TaskTemplate[]>([])
  const [saveAs, setSaveAs] = useState<{ name: string; group: string } | null>(null)
  const [enhancing, setEnhancing] = useState(false)

  useEffect(() => {
    ref.current?.focus()
    // 光标移到末尾
    const el = ref.current
    if (el) el.selectionStart = el.selectionEnd = el.value.length
    window.easybow
      .getTemplates()
      .then(setTplList)
      .catch(() => {})
  }, [])

  const appendTemplate = async (t: TaskTemplate) => {
    let text = t.text
    try {
      text = await window.easybow.resolveTemplateVars(t.text)
    } catch {}
    const cur = props.task.trim()
    props.setTask(cur ? cur + '\n\n' + text : text)
    ref.current?.focus()
  }

  const chars = props.task.length
  const lines = props.task ? props.task.split('\n').length : 0

  return (
    <div className="modal-mask" onClick={onBackdropClick}>
      <div
        ref={bodyRef}
        className={`modal task-editor${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="任务描述大编辑器"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 className="with-ico"><PenLine size={16} strokeWidth={2} /> 任务描述（大编辑器）</h3>
          <button className="close-x" aria-label="关闭大编辑器" title="关闭（Esc）" onClick={requestClose}>
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label>
              任务模板（点击插入到末尾，按需修改）
              <span
                className="ccimport-btn"
                title="把当前文本存为任务模板（下次一键填充）"
                onClick={() => setSaveAs({ name: props.task.trim().slice(0, 12) || '未命名模板', group: '' })}
              >
                ⭐ 存为模板
              </span>
            </label>
            <div className="presets">
              {tplList.map((t) => (
                <button key={t.id} className="preset" title={t.text.slice(0, 200)} onClick={() => appendTemplate(t)}>
                  {t.name}
                </button>
              ))}
              {!tplList.length && <span className="field-hint no-top">暂无模板，可在下方写好任务后点「⭐ 存为模板」</span>}
            </div>
            {saveAs && (
              <div className="tpl-save-inline">
                <input
                  placeholder="模板名"
                  value={saveAs.name}
                  onChange={(e) => setSaveAs({ ...saveAs, name: e.target.value })}
                />
                <input
                  placeholder="分组（可空）"
                  value={saveAs.group}
                  onChange={(e) => setSaveAs({ ...saveAs, group: e.target.value })}
                />
                <button
                  className="btn mini primary"
                  onClick={async () => {
                    try {
                      const list = await window.easybow.saveTemplate({
                        name: saveAs.name || '未命名模板',
                        group: saveAs.group,
                        text: props.task,
                        pinned: true
                      })
                      setTplList(list)
                      setSaveAs(null)
                    } catch {}
                  }}
                >
                  保存
                </button>
                <button className="btn mini" onClick={() => setSaveAs(null)}>
                  取消
                </button>
              </div>
            )}
          </div>

          <textarea
            ref={ref}
            className="task-editor-input"
            value={props.task}
            placeholder={
              '详细描述任务，越具体 AI 执行越准确。\n\n例如：\n1. 在页签1打开聚水潭订单列表，读取今天前10条订单的「订单号/买家/金额/状态」并存入任务记忆\n2. 切到页签2的发货登记表单，逐条填入刚才读取的订单信息\n3. 全部填完后核对一遍，不要提交，报告填写结果'
            }
            spellCheck={false}
            aria-label="任务描述"
            onChange={(e) => props.setTask(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl+Enter 直接采用；Esc 交给 useModalFocus 统一处理
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                requestClose()
              }
            }}
          />
        </div>

        <div className="modal-foot">
          <span className="task-editor-count">
            {chars} 字 · {lines} 行
          </span>
          <button
            className="btn"
            title="让 AI 把这段描述增强为清晰、结构化的任务指令（补步骤/字段/预期，保留原意）"
            disabled={enhancing || !props.task.trim()}
            onClick={async () => {
              setEnhancing(true)
              try {
                props.setTask(await window.easybow.enhanceTask(props.task.trim()))
              } catch {}
              setEnhancing(false)
            }}
          >
            {enhancing ? (
              <>
                <Sparkles size={12} strokeWidth={2} /> 增强中…
              </>
            ) : (
              <>
                <Sparkles size={12} strokeWidth={2} /> AI 增强
              </>
            )}
          </button>
          <button className="btn" onClick={requestClose}>
            取消
          </button>
          <button className="btn primary" onClick={requestClose}>
            <Check size={12} strokeWidth={2.5} /> 使用此任务（Ctrl+Enter）
          </button>
        </div>
      </div>
    </div>
  )
}
