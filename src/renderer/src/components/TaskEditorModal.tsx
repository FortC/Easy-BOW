import { useEffect, useRef } from 'react'
import { useModalFocus } from '../hooks/useDelayedUnmount'

const TEMPLATES: { name: string; text: string }[] = [
  {
    name: '📋 跨页签搬运数据',
    text: `在页签1：打开（网址或说明），读取以下数据：
- 字段1：
- 字段2：
- 字段3：
用 save 把每条数据存入任务记忆。

然后 switch_tab 到页签2：在（目标页面说明）中，把记忆中的数据逐项填入对应输入框（长文本可用 {{记忆键}} 引用），填写完成后核对一遍再提交，并用 done 说明结果。`
  },
  {
    name: '🔍 信息采集汇总',
    text: `在当前页签浏览（列表/搜索结果说明），读取前 N 条的（字段1、字段2、字段3），整理成表格；
内容不足时先 scroll 向下滚动再继续读取；
完成后用 done 输出汇总表格。`
  },
  {
    name: '📝 表单填写',
    text: `在当前页面找到表单并逐项填写：
字段A = 值
字段B = 值
字段C = {{记忆键}}
填完先不要提交，用 done 说明每项的填写结果，等我确认。`
  },
  {
    name: '🛒 下单/操作流程',
    text: `在页签1完成以下流程：
1. （第一步，如：搜索某商品并进入详情页）
2. （第二步，如：选择规格数量加入购物车）
3. （第三步）
每一步完成后简述进展；遇到登录或验证码时说明并等待人工处理；最终用 done 报告结果。`
  }
]

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

  useEffect(() => {
    ref.current?.focus()
    // 光标移到末尾
    const el = ref.current
    if (el) el.selectionStart = el.selectionEnd = el.value.length
  }, [])

  const appendTemplate = (t: string) => {
    const cur = props.task.trim()
    props.setTask(cur ? cur + '\n\n' + t : t)
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
          <h3>✏️ 任务描述（大编辑器）</h3>
          <button className="close-x" aria-label="关闭大编辑器" title="关闭（Esc）" onClick={requestClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <div className="form-row">
            <label>任务模板（点击插入到末尾，按需修改）</label>
            <div className="presets">
              {TEMPLATES.map((t) => (
                <button key={t.name} className="preset" onClick={() => appendTemplate(t.text)}>
                  {t.name}
                </button>
              ))}
            </div>
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
          <button className="btn" onClick={requestClose}>
            取消
          </button>
          <button className="btn primary" onClick={requestClose}>
            ✓ 使用此任务（Ctrl+Enter）
          </button>
        </div>
      </div>
    </div>
  )
}
