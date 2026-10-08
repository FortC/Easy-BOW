import { useEffect, useState } from 'react'
import type { MainEvent, TestEnv, TestRunStatus } from '@shared/types'

type PanelTab = 'convert' | 'run' | 'reports'

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

/** 浏览器仿真测试面板：需求 MD → 测试用例 MD → 运行 → 报告 */
export default function TestPanel(props: {
  onClose: () => void
  onToast: (msg: string, kind?: 'info' | 'success' | 'error') => void
}) {
  const [tab, setTab] = useState<PanelTab>('convert')
  // ① 需求 → 用例
  const [reqMd, setReqMd] = useState('')
  const [mode, setMode] = useState<'prd' | 'rough'>('rough')
  const [converting, setConverting] = useState(false)
  // ② 用例与运行
  const [caseMd, setCaseMd] = useState('')
  const [parsed, setParsed] = useState<{ ok: boolean; error?: string; name?: string; steps?: number; assertions?: number; vars?: string[] } | null>(null)
  const [envs, setEnvs] = useState<TestEnv[]>([])
  const [envName, setEnvName] = useState('')
  const [failFast, setFailFast] = useState(true)
  const [envDraft, setEnvDraft] = useState<TestEnv | null>(null)
  const [run, setRun] = useState<TestRunStatus | null>(null)
  // ③ 报告
  const [reports, setReports] = useState<Array<{ file: string; ts: number; verdict: string }>>([])
  const [reportContent, setReportContent] = useState<string | null>(null)

  useEffect(() => {
    window.easybow.testRunStatus().then(setRun).catch(() => {})
    window.easybow.getTestEnvs().then(setEnvs).catch(() => {})
    const off = window.easybow.onEvent((ev: MainEvent) => {
      if (ev.channel === 'test-run') setRun(ev.run)
    })
    return off
  }, [])

  const refreshReports = () => window.easybow.testListReports().then(setReports).catch(() => {})

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
      await window.easybow.testStart(caseMd, { envName: envName || undefined, failFast })
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

  return (
    <div className="modal-mask">
      <div className="modal test-modal">
        <h3>
          🧪 浏览器仿真测试
          <span className="close-x" onClick={props.onClose}>
            ✕
          </span>
        </h3>

        <div className="test-tabs">
          <button className={`test-tab${tab === 'convert' ? ' active' : ''}`} onClick={() => setTab('convert')}>
            ① 需求 → 用例
          </button>
          <button className={`test-tab${tab === 'run' ? ' active' : ''}`} onClick={() => setTab('run')}>
            ② 用例与运行
          </button>
          <button
            className={`test-tab${tab === 'reports' ? ' active' : ''}`}
            onClick={() => {
              setTab('reports')
              refreshReports()
            }}
          >
            ③ 报告
          </button>
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
              <div className="form-row test-convert-btn">
                <button className="btn primary" onClick={doConvert} disabled={converting}>
                  {converting ? '生成中…（一次模型调用）' : '生成测试用例'}
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
              <div className="form-row test-run-btns">
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
            </div>
            {parsed && (
              <div className={`field-hint ${parsed.ok ? '' : 'test-parse-err'}`}>
                {parsed.ok
                  ? `✅ ${parsed.name}：${parsed.steps} 步骤 / ${parsed.assertions} 断言${parsed.vars?.length ? ` · 变量: ${parsed.vars.join(', ')}` : ''}`
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
                    {run.caseName} · 步骤 {Math.min(run.currentStep || 0, run.totalSteps)}/{run.totalSteps} · 通过 {run.passed} · 失败 {run.failed}
                    {run.envName ? ` · ${run.envName}` : ''}
                  </span>
                  {run.state !== 'running' && (
                    <span className="test-run-ops">
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
              {reports.length === 0 && <div className="field-hint">暂无报告——运行一次测试后生成</div>}
              {reports.map((r) => (
                <div key={r.file} className="test-env-item" onClick={() => viewReport(r.file)}>
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
      </div>
    </div>
  )
}
