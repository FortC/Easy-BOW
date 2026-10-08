import { useEffect, useRef, useState } from 'react'
import type { MainEvent, TestCaseEntry, TestEnv, TestRunStatus } from '@shared/types'
import { useModalFocus } from '../hooks/useDelayedUnmount'

type PanelTab = 'convert' | 'run' | 'reports' | 'lib'

/** 用例草稿的本地持久化 key——切到其它弹窗再回来、或误关窗口都不丢 */
const DRAFT_KEY = 'easybow.testcase.draft'

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
    { ok: boolean; error?: string; name?: string; steps?: number; assertions?: number; vars?: string[]; groups?: number } | null
  >(null)
  const [envs, setEnvs] = useState<TestEnv[]>([])
  const [envName, setEnvName] = useState('')
  const [failFast, setFailFast] = useState(true)
  const [fillPreview, setFillPreview] = useState(false)
  const [envDraft, setEnvDraft] = useState<TestEnv | null>(null)
  const [run, setRun] = useState<TestRunStatus | null>(null)
  // ③ 报告（null = 加载中，与「暂无报告」区分开，避免首屏文案闪烁）
  const [reports, setReports] = useState<Array<{ file: string; ts: number; verdict: string }> | null>(null)
  const [reportContent, setReportContent] = useState<string | null>(null)
  // ④ 用例库（同上，null = 加载中）
  const [cases, setCases] = useState<TestCaseEntry[] | null>(null)
  const [libTags, setLibTags] = useState('')
  const [libSaving, setLibSaving] = useState(false)
  /** 本次运行用的用例 MD（失败重跑取子集用） */
  const lastRunMd = useRef('')
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

  useEffect(() => {
    window.easybow.testRunStatus().then(setRun).catch(() => {})
    window.easybow.getTestEnvs().then(setEnvs).catch(() => {})
    const off = window.easybow.onEvent((ev: MainEvent) => {
      if (ev.channel === 'test-run') setRun(ev.run)
    })
    return off
  }, [])

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
      if (!v.ok) {
        props.onToast(`用例校验未通过: ${v.error}`, 'error')
        return
      }
      await window.easybow.testStart(caseMd, { envName: envName || undefined, failFast, fillPreview })
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
    setTab('run')
    try {
      await window.easybow.testStart(entry.md, { envName: envName || undefined, failFast })
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

  if (!props.open && !closing) return null

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
          <button className="close-x" aria-label="关闭测试面板" title="关闭（Esc）" onClick={requestClose}>
            ✕
          </button>
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
                  <option value="rough">粗略步骤 → 补全断言/数据（保留原步骤）</option>
                  <option value="prd">PRD 全文 → 提炼拆用例</option>
                </select>
              </div>
              <div className="form-row test-convert-btn no-flex">
                <button className="btn primary" onClick={doConvert} disabled={converting}>
                  {converting ? '生成中…' : '生成测试用例'}
                </button>
              </div>
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
              <label>测试用例 MD（可编辑；预期行支持 [文字]/[URL]/[标题]/[选择器 X] 类型标记）</label>
              <textarea
                className="test-md-input"
                value={caseMd}
                onChange={(e) => {
                  setCaseMd(e.target.value)
                  setParsed(null)
                }}
                rows={10}
                spellCheck={false}
              />
            </div>
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
