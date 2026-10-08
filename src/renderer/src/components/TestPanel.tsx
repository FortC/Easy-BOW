import { useEffect, useRef, useState } from 'react'
import type { MainEvent, TestCaseEntry, TestEnv, TestRunStatus } from '@shared/types'
import { useModalFocus } from '../hooks/useDelayedUnmount'

type PanelTab = 'convert' | 'run' | 'reports' | 'lib'

/** 用例草稿的本地持久化 key——切到其它弹窗再回来、或误关窗口都不丢 */
const DRAFT_KEY = 'easybow.testcase.draft'

/** 解析后的步骤节点（面板行内编辑的对象） */
interface StepDetail {
  index: number
  title: string
  action: string
  assertions: string[]
  dialog?: 'accept' | 'dismiss'
  login?: boolean
  cleanup?: boolean
}

function loadDraft(): { reqMd: string; caseMd: string } {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}')
    return { reqMd: typeof d.reqMd === 'string' ? d.reqMd : '', caseMd: typeof d.caseMd === 'string' ? d.caseMd : '' }
  } catch {
    return { reqMd: '', caseMd: '' }
  }
}

const STEP_ICON: Record<string, string> = {
  pending: '⏳',
  running: '🔄',
  passed: '✅',
  failed: '❌',
  skipped: '⏭️'
}

const RUN_VERDICT: Record<string, { text: string; cls: string }> = {
  running: { text: '执行中', cls: 'run-running' },
  passed: { text: '✅ 全部通过', cls: 'run-passed' },
  failed: { text: '❌ 存在失败', cls: 'run-failed' },
  error: { text: '⚠️ 运行异常', cls: 'run-failed' },
  stopped: { text: '⏹️ 已停止', cls: 'run-stopped' }
}

/** 浏览器仿真测试面板：需求 MD → 测试用例 MD → 运行 → 报告（+用例库/失败重跑/定时回归入口） */
export default function TestPanel(props: {
  /** 是否处于打开状态（组件常驻挂载，靠它控制显隐，草稿不因切换弹窗而丢失） */
  open: boolean
  /** 收起为右侧悬浮按钮（执行期间让出画面；收起时不渲染遮罩，不挡浏览器） */
  collapsed: boolean
  onCollapsedChange: (v: boolean) => void
  onClose: () => void
  onToast: (msg: string, kind?: 'info' | 'success' | 'error') => void
  /** 用例库条目 → 打开定时任务弹窗绑定（定时回归） */
  onScheduleCase?: (entry: { id: number; name: string }) => void
}) {
  const [tab, setTab] = useState<PanelTab>('convert')
  // ① 需求 → 用例
  const [reqMd, setReqMd] = useState('')
  const [mode, setMode] = useState<'prd' | 'rough'>('rough')
  const [converting, setConverting] = useState(false)
  // ② 用例与运行
  const [caseMd, setCaseMd] = useState('')
  const [parsed, setParsed] = useState<
    | {
        ok: boolean
        error?: string
        name?: string
        steps?: number
        assertions?: number
        vars?: string[]
        groups?: number
        stepsDetail?: StepDetail[]
      }
    | null
  >(null)
  const [stepsDetail, setStepsDetail] = useState<StepDetail[] | null>(null)
  /** 正在行内编辑的步骤序号（1-based；null=未编辑） */
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<{ title: string; action: string; assertions: string; dialog: string }>({
    title: '',
    action: '',
    assertions: '',
    dialog: ''
  })
  /** 最近一次改动影响的起始步骤（该步及其下方节点标记「已重生成」） */
  const [revisedFrom, setRevisedFrom] = useState<number | null>(null)
  const [envs, setEnvs] = useState<TestEnv[]>([])
  const [envName, setEnvName] = useState('')
  const [failFast, setFailFast] = useState(true)
  const [fillPreview, setFillPreview] = useState(false)
  /** 登录态复用：启动先探测已保存登录态，命中跳过登录步骤（默认开） */
  const [loginReuse, setLoginReuse] = useState(true)
  const [envDraft, setEnvDraft] = useState<TestEnv | null>(null)
  const [run, setRun] = useState<TestRunStatus | null>(null)
  /** 主 Agent 是否在跑（看门狗据此判断「显示执行中」是否属实） */
  const [agentLive, setAgentLive] = useState(false)
  // ③ 报告（null = 加载中，与「暂无报告」区分开，避免首屏文案闪烁）
  const [reports, setReports] = useState<Array<{ file: string; ts: number; verdict: string }> | null>(null)
  const [reportContent, setReportContent] = useState<string | null>(null)
  // ④ 用例库（同上，null = 加载中）
  const [cases, setCases] = useState<TestCaseEntry[] | null>(null)
  const [libTags, setLibTags] = useState('')
  const [libSaving, setLibSaving] = useState(false)
  /** 本次运行用的用例 MD（失败重跑取子集用） */
  const lastRunMd = useRef('')
  /** 看门狗：连续「UI 显示执行中但主进程已不在跑」的次数 */
  const stallMiss = useRef(0)
  /** 上次自动收展所依据的运行状态（只在状态变化时自动切换一次，不覆盖用户手动操作） */
  const lastAutoState = useRef<string>('')
  const bodyRef = useRef<HTMLDivElement>(null)
  const { closing, requestClose, onBackdropClick } = useModalFocus(bodyRef, props.onClose, props.open)

  // 打开时恢复上次未保存的用例草稿
  useEffect(() => {
    if (!props.open) return
    setReqMd((v) => v || loadDraft().reqMd)
    setCaseMd((v) => v || loadDraft().caseMd)
  }, [props.open])

  // 草稿变化即持久化（切弹窗、误关窗口都不丢）
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ reqMd, caseMd }))
      } catch {}
    }, 400)
    return () => window.clearTimeout(t)
  }, [reqMd, caseMd])

  // 用例编辑后自动重新识别（防抖）：解析成功即刷新步骤节点列表——
  // 手动改完一步，其下方节点按新内容重新生成
  useEffect(() => {
    if (!props.open) return
    if (!caseMd.trim()) {
      setParsed(null)
      setStepsDetail(null)
      return
    }
    const t = window.setTimeout(() => {
      window.easybow
        .testParse(caseMd)
        .then((r) => {
          setParsed(r)
          setStepsDetail(r.stepsDetail || null)
        })
        .catch(() => {})
    }, 600)
    return () => window.clearTimeout(t)
  }, [caseMd, props.open])

  useEffect(() => {
    window.easybow.testRunStatus().then(setRun).catch(() => {})
    window.easybow.getTestEnvs().then(setEnvs).catch(() => {})
    window.easybow
      .getAgentStatus()
      .then((s) => setAgentLive(s.state === 'running' || s.state === 'paused' || s.state === 'captcha'))
      .catch(() => {})
    const off = window.easybow.onEvent((ev: MainEvent) => {
      if (ev.channel === 'test-run') setRun(ev.run)
      else if (ev.channel === 'agent-status') {
        setAgentLive(ev.status.state === 'running' || ev.status.state === 'paused' || ev.status.state === 'captcha')
      }
    })
    return off
  }, [])

  // 执行期间自动收起为悬浮按钮（让出浏览器画面），结束后自动展开看结果。
  // 只在运行状态变化时切一次；用户手动收/展后本次运行内不再自动干预。
  useEffect(() => {
    if (!props.open) return
    const st = run?.state || ''
    if (st === lastAutoState.current) return
    lastAutoState.current = st
    if (st === 'running') props.onCollapsedChange(true)
    else if (st) props.onCollapsedChange(false)
  }, [run?.state, props.open])

  // 看门狗：UI 显示「执行中」但主进程其实已不在跑（中断/异常未收尾）→ 自动重置，
  // 避免「运行」按钮被永久禁用、面板永远停在执行中
  useEffect(() => {
    if (!run || run.state !== 'running') {
      stallMiss.current = 0
      return
    }
    const t = window.setInterval(() => {
      if (agentLive) {
        stallMiss.current = 0
        return
      }
      stallMiss.current++
      if (stallMiss.current >= 3) {
        stallMiss.current = 0
        window.easybow
          .testReset()
          .then((r) => {
            if (r) setRun(r)
          })
          .catch(() => {})
        props.onToast('测试状态已自动重置（主进程已不在执行）', 'info')
      }
    }, 5000)
    return () => window.clearTimeout(t)
  }, [run?.state, agentLive, props.onToast])

  const refreshReports = () =>
    window.easybow
      .testListReports()
      .then(setReports)
      .catch(() => setReports([]))
  const refreshCases = () =>
    window.easybow
      .getTestCases()
      .then(setCases)
      .catch(() => setCases([]))

  // 运行结束后刷新用例库（最近运行结论回写展示）
  useEffect(() => {
    if (run && run.state !== 'running') refreshCases()
  }, [run?.state])

  const doConvert = async () => {
    if (!reqMd.trim()) {
      props.onToast('请先粘贴/输入需求内容', 'error')
      return
    }
    setConverting(true)
    try {
      const r = await window.easybow.testConvert(reqMd, mode)
      if (r.ok && r.md) {
        setCaseMd(r.md)
        setParsed({ ok: true, steps: r.steps, assertions: r.assertions })
        props.onToast(`用例已生成（${r.steps} 步骤 / ${r.assertions} 断言${r.attempts && r.attempts > 1 ? '，重试后成功' : ''}），可编辑后运行`, 'success')
        setTab('run')
      } else {
        if (r.md) setCaseMd(r.md)
        props.onToast(r.error || '生成失败', 'error')
        setTab('run')
      }
    } catch (e: any) {
      props.onToast(e?.message || '生成失败', 'error')
    } finally {
      setConverting(false)
    }
  }

  const doParse = async () => {
    try {
      const r = await window.easybow.testParse(caseMd)
      setParsed(r)
      setStepsDetail(r.stepsDetail || null)
      if (r.ok) props.onToast(`校验通过：${r.steps} 步骤 / ${r.assertions} 断言`, 'success')
    } catch (e: any) {
      props.onToast(e?.message || '校验失败', 'error')
    }
  }

  const doStart = async () => {
    if (!caseMd.trim()) {
      props.onToast('测试用例为空：先在「需求→用例」生成，或直接粘贴用例 MD', 'error')
      return
    }
    try {
      const v = await window.easybow.testParse(caseMd)
      setParsed(v)
      setStepsDetail(v.stepsDetail || null)
      if (!v.ok) {
        props.onToast(`用例校验未通过: ${v.error}`, 'error')
        return
      }
      await window.easybow.testStart(caseMd, { envName: envName || undefined, failFast, fillPreview, loginReuse })
      lastRunMd.current = caseMd
      props.onToast(`测试已启动（独立测试页签${envName ? ` · ${envName}` : ''}）`, 'success')
      setReportContent(null)
    } catch (e: any) {
      props.onToast(e?.message || '启动失败', 'error')
    }
  }

  const saveEnvs = async (list: TestEnv[]) => {
    try {
      const saved = await window.easybow.setTestEnvs(list)
      setEnvs(saved)
      if (envName && !saved.some((e) => e.name === envName)) setEnvName('')
      props.onToast('测试环境已保存', 'success')
    } catch (e: any) {
      props.onToast(e?.message || '保存失败', 'error')
    }
  }

  // —— 步骤节点行内编辑：保存后整份用例重新解析，该步及其下方节点重新生成 ——
  const openEditor = (s: StepDetail) => {
    setEditingIdx(s.index)
    setEditForm({
      title: s.title.replace(/^清理:\s*/, ''),
      action: s.action,
      assertions: s.assertions.join('\n'),
      dialog: s.dialog || ''
    })
  }

  const applyStepEdit = async (
    op: 'update' | 'delete' | 'insert',
    idx: number,
    patch?: { title?: string; action?: string; assertions?: string[]; dialog?: 'accept' | 'dismiss' | '' }
  ) => {
    try {
      const r = await window.easybow.testEditStep(caseMd, idx, { op, ...patch })
      if (!r.ok || !r.md) {
        props.onToast(r.error || '编辑失败', 'error')
        return
      }
      setCaseMd(r.md)
      const v = await window.easybow.testParse(r.md)
      setParsed(v)
      setStepsDetail(v.stepsDetail || null)
      setRevisedFrom(op === 'delete' ? idx : idx)
      setEditingIdx(null)
      props.onToast(
        op === 'delete'
          ? `已删除步骤 ${idx}（其后步骤已重新编号）`
          : op === 'insert'
            ? `已在步骤 ${idx} 下方插入新步骤（其后节点已重新生成）`
            : `已更新步骤 ${idx}（该步及其下方节点已重新生成）`,
        'success'
      )
    } catch (e: any) {
      props.onToast(e?.message || '编辑失败', 'error')
    }
  }

  /** 失败重跑：把失败步骤抽成子用例放进编辑器（人工确认后运行） */
  const rerunFailed = async () => {
    if (!run || !lastRunMd.current) return
    const failedIdx = run.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').map((s) => s.index)
    if (!failedIdx.length) return
    try {
      const r = await window.easybow.testSubcase(lastRunMd.current, failedIdx)
      if (r.ok && r.md) {
        setCaseMd(r.md)
        setParsed(null)
        setStepsDetail(null)
        setTab('run')
        props.onToast(`已生成失败重跑用例（${failedIdx.length} 步），确认后点「运行测试」`, 'success')
      } else {
        props.onToast(r.error || '生成失败', 'error')
      }
    } catch (e: any) {
      props.onToast(e?.message || '生成失败', 'error')
    }
  }

  /** 保存当前编辑器用例到用例库 */
  const saveToLib = async () => {
    if (!caseMd.trim()) {
      props.onToast('编辑器里没有用例可保存', 'error')
      return
    }
    setLibSaving(true)
    try {
      const v = await window.easybow.testParse(caseMd)
      if (!v.ok) {
        props.onToast(`用例校验未通过: ${v.error}`, 'error')
        return
      }
      const updated = await window.easybow.saveTestCase({
        name: v.name || '未命名用例',
        md: caseMd,
        tags: libTags.split(/[,，\s]+/).filter(Boolean)
      })
      setCases(updated)
      setLibTags('')
      props.onToast(`已保存「${v.name}」到用例库`, 'success')
    } catch (e: any) {
      props.onToast(e?.message || '保存失败', 'error')
    } finally {
      setLibSaving(false)
    }
  }

  const runFromLib = async (entry: TestCaseEntry) => {
    setCaseMd(entry.md)
    setParsed(null)
    setStepsDetail(null)
    setTab('run')
    try {
      await window.easybow.testStart(entry.md, { envName: envName || undefined, failFast, loginReuse })
      lastRunMd.current = entry.md
      props.onToast(`已从用例库运行「${entry.name}」`, 'success')
    } catch (e: any) {
      props.onToast(e?.message || '启动失败', 'error')
    }
  }

  const viewReport = async (file: string) => {
    try {
      const c = await window.easybow.testReadReport(file)
      setReportContent(c)
    } catch (e: any) {
      props.onToast(e?.message || '读取失败', 'error')
    }
  }

  const running = run?.state === 'running'
  const curEnv = envs.find((e) => e.name === envName)
  /** 显示执行中但主进程已不在跑 → 允许手动重置（状态机自愈兜底） */
  const stuck = running && !agentLive

  if (!props.open && !closing) return null

  // —— 收起态：右侧悬浮按钮（不渲染遮罩，浏览器画面与操作完全不受影响）——
  if (props.collapsed) {
    return (
      <button
        className={`test-fab${running ? ' running' : ''}`}
        title="展开测试面板"
        aria-label="展开测试面板"
        onClick={() => props.onCollapsedChange(false)}
      >
        <span className="test-fab-icon">🧪</span>
        <span className="test-fab-text">
          {run ? `${RUN_VERDICT[run.state]?.text || run.state}` : '测试面板'}
          {run && run.totalSteps ? ` ${Math.min(run.currentStep || 0, run.totalSteps)}/${run.totalSteps}` : ''}
        </span>
        {run?.failed ? <span className="test-fab-badge">{run.failed}</span> : null}
      </button>
    )
  }

  return (
    <div className="modal-mask" onClick={onBackdropClick}>
      <div
        ref={bodyRef}
        className={`modal test-modal${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="浏览器仿真测试"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3>🧪 浏览器仿真测试</h3>
          <span className="test-head-ops">
            <button className="btn mini" title="收起为右侧悬浮按钮，让出浏览器画面" onClick={() => props.onCollapsedChange(true)}>
              收起
            </button>
            <button className="close-x" aria-label="关闭测试面板" title="关闭（Esc）" onClick={requestClose}>
              ✕
            </button>
          </span>
        </div>

        <div className="modal-body">
          <div className="test-tabs" role="tablist" aria-label="测试阶段">
            {(
              [
                ['convert', '① 需求 → 用例'],
                ['run', '② 用例与运行'],
                ['reports', '③ 报告'],
                ['lib', '④ 用例库']
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                className={`test-tab${tab === key ? ' active' : ''}`}
                onClick={() => {
                  setTab(key)
                  if (key === 'reports' && reports === null) refreshReports()
                  if (key === 'lib' && cases === null) refreshCases()
                }}
              >
                {label}
              </button>
            ))}
          </div>

        {tab === 'convert' && (
          <>
            <div className="form-row">
              <label>需求内容（粘贴 PRD 全文或手写粗略步骤）</label>
              <textarea
                className="test-md-input"
                value={reqMd}
                onChange={(e) => setReqMd(e.target.value)}
                rows={10}
                placeholder={'例（粗略步骤）：打开后台，登录 admin，新建客户「测试客户A」，检查列表里能搜到\n\n例（PRD）：粘贴需求文档全文，AI 提炼可测点生成用例'}
                spellCheck={false}
              />
            </div>
            <div className="form-inline">
              <div className="form-row">
                <label>转换模式</label>
                <select value={mode} onChange={(e) => setMode(e.target.value as 'prd' | 'rough')}>
                  <option value="rough">粗略步骤 → 补全断言/数据（保留原步骤语义）</option>
                  <option value="prd">PRD 全文 → 提炼可测点拆用例</option>
                </select>
              </div>
            </div>
            <div className="test-actions">
              <button className="btn primary" onClick={doConvert} disabled={converting}>
                {converting ? '生成中…（一次模型调用）' : '生成测试用例'}
              </button>
            </div>
            <div className="field-hint">
              生成后进入「② 用例与运行」人工审核/编辑——用例 MD 可保存到 git 仓库复用；「智能填充当前页表单」写进操作即可让 AI
              自动识别字段并填充（无 label 字段按 placeholder/name/邻接文本推断）。
            </div>
          </>
        )}

        {tab === 'run' && (
          <>
            <div className="form-row">
              <label>测试用例 MD（可编辑；下方步骤节点可单步改/删/插，保存后立即重新解析）</label>
              <textarea
                className="test-md-input"
                value={caseMd}
                onChange={(e) => {
                  setCaseMd(e.target.value)
                  setParsed(null)
                  setStepsDetail(null)
                }}
                rows={10}
                spellCheck={false}
              />
            </div>

            {/* 步骤节点：MD 的图形化视图，改一步 → 该步及其下方重新生成 */}
            {stepsDetail && stepsDetail.length > 0 && (
              <div className="test-nodes">
                <div className="test-envs-head">
                  <span>步骤节点（{stepsDetail.length} 步 · 编辑后自动重新识别，其下方节点同步重建）</span>
                  <button className="btn mini" onClick={() => applyStepEdit('insert', stepsDetail.length, { title: '新步骤', action: '在此描述操作，例如：点击「保存」' })}>
                    + 末尾新增
                  </button>
                </div>
                {stepsDetail.map((s) =>
                  editingIdx === s.index ? (
                    <div key={s.index} className="test-node editing">
                      <div className="test-node-edit">
                        <label>步骤标题</label>
                        <input value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value })} />
                        <label>操作（自然语言，AI 据此翻译成动作）</label>
                        <textarea
                          rows={2}
                          value={editForm.action}
                          onChange={(e) => setEditForm({ ...editForm, action: e.target.value })}
                        />
                        <label>预期（一行一条；支持 [文字]/[URL]/[标题]/[选择器 X]/[接口 X] 标记，也可写自然语言）</label>
                        <textarea
                          rows={3}
                          value={editForm.assertions}
                          placeholder={'[文字] 保存成功\n[URL] 包含 /list'}
                          onChange={(e) => setEditForm({ ...editForm, assertions: e.target.value })}
                        />
                        <label>弹窗应答</label>
                        <select value={editForm.dialog} onChange={(e) => setEditForm({ ...editForm, dialog: e.target.value })}>
                          <option value="">（默认确认）</option>
                          <option value="accept">确认</option>
                          <option value="dismiss">取消</option>
                        </select>
                      </div>
                      <div className="test-node-ops">
                        <button
                          className="btn mini primary"
                          onClick={() =>
                            applyStepEdit('update', s.index, {
                              title: editForm.title,
                              action: editForm.action,
                              assertions: editForm.assertions
                                .split('\n')
                                .map((x) => x.replace(/^\s*[-*]\s*(?:预期|期望|断言)?\s*[:：]?\s*/, '').trim())
                                .filter(Boolean),
                              dialog: (editForm.dialog || '') as 'accept' | 'dismiss' | ''
                            })
                          }
                        >
                          保存并重生成
                        </button>
                        <button className="btn mini" onClick={() => setEditingIdx(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={s.index} className={`test-node${revisedFrom != null && s.index >= revisedFrom ? ' revised' : ''}`}>
                      <div className="test-node-head">
                        <b>
                          {s.index}. {s.title}
                        </b>
                        {s.login && <span className="test-node-tag">🔑 登录步骤</span>}
                        {s.cleanup && <span className="test-node-tag">🧹 清理</span>}
                        {s.dialog && <span className="test-node-tag">弹窗: {s.dialog === 'dismiss' ? '取消' : '确认'}</span>}
                        <span className="test-node-ops">
                          <button className="btn mini" onClick={() => openEditor(s)}>
                            编辑
                          </button>
                          <button className="btn mini" onClick={() => applyStepEdit('insert', s.index, { title: '新步骤', action: '在此描述操作，例如：点击「保存」' })}>
                            +下方
                          </button>
                          <button className="btn mini danger" onClick={() => applyStepEdit('delete', s.index)}>
                            删
                          </button>
                        </span>
                      </div>
                      <div className="test-node-act">操作: {s.action}</div>
                      {s.assertions.length > 0 && (
                        <div className="test-node-asserts">
                          {s.assertions.map((a, i) => (
                            <code key={i}>{a}</code>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                )}
              </div>
            )}

            <div className="form-inline">
              <div className="form-row">
                <label>运行环境</label>
                <select value={envName} onChange={(e) => setEnvName(e.target.value)}>
                  <option value="">不使用（用例内 URL 直连）</option>
                  {envs.map((e) => (
                    <option key={e.name} value={e.name}>
                      {e.name}
                      {e.protected ? '（🔒 生产保护）' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>失败策略</label>
                <select value={failFast ? 'fast' : 'all'} onChange={(e) => setFailFast(e.target.value === 'fast')}>
                  <option value="fast">fail-fast（失败即停）</option>
                  <option value="all">跑完全部步骤</option>
                </select>
              </div>
              <div className="form-row">
                <label>填充预览</label>
                <select value={fillPreview ? '1' : '0'} onChange={(e) => setFillPreview(e.target.value === '1')}>
                  <option value="0">关闭（直接执行）</option>
                  <option value="1">开启（AI 填充值先人工确认）</option>
                </select>
              </div>
              <div className="form-row">
                <label>登录态</label>
                <select value={loginReuse ? '1' : '0'} onChange={(e) => setLoginReuse(e.target.value === '1')}>
                  <option value="1">复用已保存登录态（已登录则跳过登录步骤）</option>
                  <option value="0">每次重新登录</option>
                </select>
              </div>
            </div>
            <div className="test-actions">
              <button className="btn" onClick={doParse} disabled={!caseMd.trim()}>
                校验
              </button>
              <button className="btn primary" onClick={doStart} disabled={running || !caseMd.trim()}>
                ▶ 运行测试
              </button>
              {running && (
                <button className="btn danger" onClick={() => window.easybow.testStop().catch(() => {})}>
                  停止
                </button>
              )}
              {stuck && (
                <button
                  className="btn warn"
                  title="主进程已不在执行但界面仍显示执行中，点此强制复位"
                  onClick={() =>
                    window.easybow
                      .testReset()
                      .then((r) => r && setRun(r))
                      .catch(() => {})
                  }
                >
                  重置状态
                </button>
              )}
            </div>
            {parsed && (
              <div className={`field-hint ${parsed.ok ? '' : 'test-parse-err'}`}>
                {parsed.ok
                  ? `✅ ${parsed.name}：${parsed.steps} 步骤 / ${parsed.assertions} 断言${parsed.groups ? ` · ${parsed.groups} 组数据驱动` : ''}${parsed.vars?.length ? ` · 变量: ${parsed.vars.join(', ')}` : ''}`
                  : `❌ ${parsed.error}`}
              </div>
            )}
            {curEnv?.protected && (
              <div className="field-hint test-warn">🔒 生产保护环境：提交/删除类点击与运行前会弹人工确认，防止误操作真实数据</div>
            )}
            {loginReuse && (
              <div className="field-hint">
                🔑 登录态复用：启动先访问目标站点探测——测试页签分区已保存有效登录时，「登录」类步骤自动判过并跳过；会话失效被踢回登录页时自动重新登录。
              </div>
            )}

            {/* 环境档案管理（折叠区内联编辑） */}
            <div className="test-envs">
              <div className="test-envs-head">
                <span>环境档案（base_url 注入 {'{{base_url}}'} 变量；标记生产保护后提交需确认）</span>
                <button className="btn mini" onClick={() => setEnvDraft({ name: '', baseUrl: '', protected: false })}>
                  + 新增
                </button>
              </div>
              {envDraft ? (
                <div className="test-env-edit">
                  <input placeholder="名称，如：测试环境" value={envDraft.name} onChange={(e) => setEnvDraft({ ...envDraft, name: e.target.value })} />
                  <input
                    placeholder="baseUrl，如：http://test.example.com"
                    value={envDraft.baseUrl}
                    onChange={(e) => setEnvDraft({ ...envDraft, baseUrl: e.target.value })}
                  />
                  <label className="test-env-prot">
                    <input type="checkbox" checked={envDraft.protected} onChange={(e) => setEnvDraft({ ...envDraft, protected: e.target.checked })} />
                    生产保护
                  </label>
                  <button className="btn mini primary" onClick={() => saveEnvs([...envs.filter((x) => x.name !== envDraft.name), envDraft]).then(() => setEnvDraft(null))}>
                    保存
                  </button>
                  <button className="btn mini" onClick={() => setEnvDraft(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <div className="test-env-list">
                  {envs.length === 0 && <span className="field-hint">尚无环境档案——用例里的 {'{{base_url}}'} 会原样保留，直接写完整 URL 也可以</span>}
                  {envs.map((e) => (
                    <div key={e.name} className="test-env-item">
                      <b>{e.name}</b>
                      <span className="test-env-url">{e.baseUrl || '（无 baseUrl）'}</span>
                      {e.protected && <span className="test-env-badge">🔒 生产保护</span>}
                      <button className="btn mini" onClick={() => setEnvDraft({ ...e })}>
                        改
                      </button>
                      <button className="btn mini danger" onClick={() => saveEnvs(envs.filter((x) => x.name !== e.name))}>
                        删
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 运行进度与结果 */}
            {run && (
              <div className="test-run">
                <div className={`test-run-banner ${RUN_VERDICT[run.state]?.cls || ''}`}>
                  <b>{RUN_VERDICT[run.state]?.text || run.state}</b>
                  <span>
                    {run.caseName}
                    {run.groupName ? ` · 组「${run.groupName}」` : ''} · 步骤 {Math.min(run.currentStep || 0, run.totalSteps)}/{run.totalSteps} · 通过 {run.passed} · 失败 {run.failed}
                    {run.envName ? ` · ${run.envName}` : ''}
                  </span>
                  {run.state !== 'running' && (
                    <span className="test-run-ops">
                      {run.failed > 0 && (
                        <button className="btn mini warn" onClick={rerunFailed} title="把失败/跳过步骤抽成子用例，人工确认后重跑">
                          ↻ 重跑失败步骤
                        </button>
                      )}
                      <button className="btn mini" onClick={() => window.easybow.testOpenReports().catch(() => {})}>
                        打开报告目录
                      </button>
                    </span>
                  )}
                </div>
                <div className="test-steps">
                  {run.steps.map((s) => (
                    <div key={s.index} className={`test-step ${s.status}`}>
                      <div className="test-step-head">
                        <span>{STEP_ICON[s.status] || '⏳'}</span>
                        <b>
                          {s.index}. {s.title}
                        </b>
                        <span className="test-step-meta">
                          {s.modelSteps > 0 ? `${s.modelSteps} 模型步` : ''}
                          {s.note ? ` · ${s.note}` : ''}
                          {s.error ? ` · ${s.error}` : ''}
                        </span>
                      </div>
                      {s.assertions.length > 0 && (
                        <div className="test-asserts">
                          {s.assertions.map((a, i) => (
                            <div key={i} className={`test-assert ${a.passed ? 'ok' : 'bad'}`}>
                              <span>{a.passed ? '✓' : '✗'}</span>
                              <code>{a.raw}</code>
                              {!a.passed && a.actual && <em>实际: {a.actual}</em>}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'reports' && (
          <>
            <div className="test-reports">
              <div className="test-envs-head">
                <span>历史报告（保留最近 50 次，失败截图在报告目录 shots/ 下）</span>
                <button className="btn mini" onClick={refreshReports}>
                  刷新
                </button>
              </div>
              {reports === null && (
                <>
                  <div className="skeleton skeleton-row" />
                  <div className="skeleton skeleton-row" style={{ opacity: 0.7 }} />
                  <div className="skeleton skeleton-row" style={{ opacity: 0.5 }} />
                </>
              )}
              {reports !== null && reports.length === 0 && <div className="field-hint">暂无报告——运行一次测试后生成</div>}
              {reports !== null && reports.map((r) => (
                <div
                  key={r.file}
                  className="test-env-item"
                  role="button"
                  tabIndex={0}
                  title="点击查看报告全文"
                  onClick={() => viewReport(r.file)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      viewReport(r.file)
                    }
                  }}
                >
                  <b>{r.verdict}</b>
                  <span className="test-env-url">{r.file}</span>
                  <span className="test-step-meta">{new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
              ))}
              {reportContent != null && (
                <div className="test-report-view">
                  <pre>{reportContent}</pre>
                </div>
              )}
            </div>
          </>
        )}

        {tab === 'lib' && (
          <>
            <div className="test-envs">
              <div className="test-envs-head">
                <span>保存当前「②用例与运行」编辑器里的用例到用例库（可定时回归 / 失败重跑）</span>
              </div>
              <div className="test-env-edit">
                <input
                  placeholder="标签（可选，逗号分隔，如：冒烟, 登录）"
                  value={libTags}
                  onChange={(e) => setLibTags(e.target.value)}
                />
                <button className="btn mini primary" onClick={saveToLib} disabled={libSaving}>
                  {libSaving ? '保存中…' : '保存当前用例'}
                </button>
              </div>
            </div>
            <div className="test-env-list">
              {cases === null && (
              <>
                <div className="skeleton skeleton-row" />
                <div className="skeleton skeleton-row" style={{ opacity: 0.7 }} />
              </>
            )}
            {cases !== null && cases.length === 0 && (
                <div className="field-hint">
                  用例库为空——在「②用例与运行」编辑好用例后回到这里保存；保存后每条可一键运行、绑定定时回归（⏰）、删除
                </div>
              )}
              {cases !== null &&
              cases.map((c) => (
                <div key={c.id} className="test-env-item">
                  <b>{c.name}</b>
                  {c.tags.map((t) => (
                    <span key={t} className="test-env-badge">
                      {t}
                    </span>
                  ))}
                  <span className="test-env-url">
                    {c.lastVerdict ? `${c.lastVerdict}${c.lastRunAt ? ' · ' + new Date(c.lastRunAt).toLocaleString('zh-CN', { hour12: false }) : ''}` : '（未运行过）'}
                  </span>
                  <button className="btn mini primary" onClick={() => runFromLib(c)} disabled={running}>
                    运行
                  </button>
                  <button
                    className="btn mini"
                    onClick={() => {
                      setCaseMd(c.md)
                      setParsed(null)
                      setStepsDetail(null)
                      setTab('run')
                    }}
                  >
                    编辑
                  </button>
                  <button className="btn mini" title="绑定到定时任务（到点自动回归）" aria-label={`把 ${c.name} 绑定到定时任务`} onClick={() => props.onScheduleCase?.({ id: c.id, name: c.name })}>
                    ⏰
                  </button>
                  <button
                    className="btn mini danger"
                    aria-label={`删除用例 ${c.name}`}
                    onClick={async () => {
                      try {
                        setCases(await window.easybow.deleteTestCase(c.id))
                        props.onToast(`已删除「${c.name}」`, 'info')
                      } catch (e: any) {
                        props.onToast(e?.message || '删除失败', 'error')
                      }
                    }}
                  >
                    删
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
