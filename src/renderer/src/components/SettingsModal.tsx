import { Settings as SettingsIcon, X, Plug, Zap, Brain, Globe } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, type CCSwitchProviderInfo, type ExperienceEntry, type FastLlmState, type Protocol, type Settings } from '@shared/types'
import { useModalFocus } from '../hooks/useDelayedUnmount'

const PRESETS: { name: string; provider: Protocol; baseURL: string; model: string }[] = [
  { name: 'OpenAI', provider: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { name: 'Anthropic', provider: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { name: 'DeepSeek', provider: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { name: '智谱 GLM', provider: 'openai', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  { name: 'Kimi', provider: 'openai', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0711-preview' },
  { name: 'OpenRouter', provider: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { name: 'Ollama 本地', provider: 'openai', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' }
]

/** 设置分类标签页：配置项按「接口 / 执行 / 智能 / 浏览器」分组，逐页聚焦不再一滚到底 */
type SettingsTab = 'api' | 'run' | 'smart' | 'browser'

const TABS: Array<{ key: SettingsTab; label: string; icon: typeof Plug }> = [
  { key: 'api', label: '接口', icon: Plug },
  { key: 'run', label: '执行', icon: Zap },
  { key: 'smart', label: '智能', icon: Brain },
  { key: 'browser', label: '浏览器', icon: Globe }
]

/** 智能 tab 的紧凑开关行：名称 + iOS 风格滑动开关（取代 20 个下拉框，一眼扫完） */
function Toggle(props: { label: string; tip?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="cfg-toggle" title={props.tip || ''}>
      <span className="cfg-name">{props.label}</span>
      <button
        type="button"
        className={`cfg-switch${props.on ? ' on' : ''}`}
        role="switch"
        aria-checked={props.on}
        aria-label={props.label}
        onClick={() => props.onChange(!props.on)}
      >
        <span className="cfg-knob" />
      </button>
    </label>
  )
}

export default function SettingsModal(props: {
  open?: boolean
  initial: Settings | null
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [s, setS] = useState<Settings>(props.initial || DEFAULT_SETTINGS)
  const [tab, setTab] = useState<SettingsTab>('api')
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saving, setSaving] = useState(false)
  // cc-switch 一键导入
  const [ccList, setCcList] = useState<CCSwitchProviderInfo[] | null>(null)
  const [ccLoading, setCcLoading] = useState(false)
  // 本地快速决策模型（混合模式）
  const [fast, setFast] = useState<FastLlmState | null>(null)
  const [fastBusy, setFastBusy] = useState(false)
  const [version, setVersion] = useState('')
  // S5 自动经验库（AI 自动沉淀；可查看/删除）
  const [expList, setExpList] = useState<ExperienceEntry[] | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  // 点遮罩不关闭（避免误触丢失正在编辑的配置），但 Esc 关闭并做焦点管理
  const { closing, requestClose, onBackdropClick } = useModalFocus(bodyRef, props.onClose, props.open !== false)

  useEffect(() => {
    window.easybow.appVersion().then(setVersion).catch(() => {})
    window.easybow.getExperience().then(setExpList).catch(() => setExpList([]))
  }, [])

  /** 删除一条自动经验（S5 风险缓解：错误经验固化时 UI 可删） */
  const removeExp = async (id: number) => {
    if (!expList) return
    const next = expList.filter((e) => e.id !== id)
    setExpList(next)
    try {
      await window.easybow.setExperience(next)
    } catch {}
  }

  const clearExp = async () => {
    setExpList([])
    try {
      await window.easybow.setExperience([])
    } catch {}
  }

  useEffect(() => {
    let alive = true
    window.easybow.fastllmStatus().then((st) => {
      if (alive) setFast(st)
    })
    // 下载/加载期间每 2s 轮询进度兜底（进度另有 fastllm 事件推送）
    const timer = window.setInterval(async () => {
      try {
        const st = await window.easybow.fastllmStatus()
        if (alive) setFast(st)
      } catch {}
    }, 2000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  const startFastInit = async () => {
    setFastBusy(true)
    try {
      const st = await window.easybow.fastllmInit()
      setFast(st)
      if (st.state === 'ready') setTestResult({ ok: true, message: '本地快速决策模型已就绪 ⚡ 混合模式生效' })
    } catch (e: any) {
      setFast({ state: 'error', detail: e?.message || '下载失败' })
    } finally {
      setFastBusy(false)
    }
  }

  const set = (patch: Partial<Settings>) => {
    setS((prev) => ({ ...prev, ...patch }))
    setTestResult(null)
  }

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    set({ provider: p.provider, baseURL: p.baseURL, model: p.model })
  }

  const loadCCSwitch = async () => {
    if (ccLoading) return
    setCcLoading(true)
    try {
      const list = await window.easybow.listCCSwitchProviders()
      setCcList(list)
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || '读取 cc-switch 失败' })
    } finally {
      setCcLoading(false)
    }
  }

  const applyCCSwitch = (p: CCSwitchProviderInfo) => {
    set({ provider: p.protocol, baseURL: p.baseURL, apiKey: p.apiKey, model: p.model })
    setCcList(null)
    setTestResult({ ok: true, message: `已导入 cc-switch 配置「${p.name}」，记得点「保存」生效` })
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      await window.easybow.setSettings(s) // 测试前先保存，主进程用保存后的配置
      const r = await window.easybow.testConnection()
      setTestResult({ ok: r.ok, message: `${r.message}（消耗 ~${r.usage?.inputTokens ?? '?'}+${r.usage?.outputTokens ?? '?'} tokens）` })
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const saved = await window.easybow.setSettings(s)
      props.onSaved(saved)
    } catch (e: any) {
      setTestResult({ ok: false, message: e?.message || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  return (
    // 不做点击遮罩关闭：避免误触外部区域丢失正在编辑的配置（用 ✕ / Esc / 保存关闭）
    <div className="modal-mask" onClick={onBackdropClick}>
      <div
        ref={bodyRef}
        className={`modal wide${closing ? ' is-closing' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 className="with-ico"><SettingsIcon size={16} strokeWidth={2} /> 设置</h3>
          <button className="close-x" aria-label="关闭设置" title="关闭（Esc）" onClick={requestClose}>
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        {/* 分类标签页：接口 / 执行 / 智能 / 浏览器 */}
        <div className="settings-tabs" role="tablist" aria-label="设置分类">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`settings-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <t.icon size={14} strokeWidth={2.2} />
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">

        {tab === 'api' && (
          <div className="tab-pane" role="tabpanel">
            <div className="pane-intro">AI 接口与模型：主模型（逐步执行）+ planner 强推理模型（规划/复核）</div>

            <div className="form-row">
              <label>
                快速预设（点击自动填充 baseURL 与推荐模型）
                <span className="ccimport-btn" title="读取本机 cc-switch 里已配置的供应商（Claude Code / Codex 中转），一键填入接口、密钥与模型" onClick={loadCCSwitch}>
                  {ccLoading ? '读取中…' : '⇩ 从 cc-switch 导入'}
                </span>
              </label>
              <div className="presets">
                {PRESETS.map((p) => (
                  <span key={p.name} className="preset" onClick={() => applyPreset(p)}>
                    {p.name}
                  </span>
                ))}
              </div>
              {ccList && (
                <div className="ccimport-list">
                  {ccList.map((p) => (
                    <div key={p.appType + p.id} className="ccimport-item" onClick={() => applyCCSwitch(p)} title="点击填入">
                      <span className="ccimport-name">{p.name}</span>
                      <span className="ccimport-meta">
                        {p.baseURL || '（无 baseURL）'}
                        {p.model ? ` · ${p.model}` : ''}
                      </span>
                      <span className="ccimport-tag">{p.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
                      {p.isCurrent && <span className="ccimport-tag cur">当前使用</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="form-row">
              <label>接口协议</label>
              <select value={s.provider} onChange={(e) => set({ provider: e.target.value as Protocol })}>
                <option value="openai">OpenAI 兼容（绝大多数国产/中转接口）</option>
                <option value="anthropic">Anthropic 兼容（Claude 官方或中转）</option>
              </select>
            </div>

            <div className="form-row">
              <label>Base URL（接口地址）</label>
              <input
                value={s.baseURL}
                placeholder={s.provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'}
                onChange={(e) => set({ baseURL: e.target.value.trim() })}
              />
            </div>

            <div className="form-row">
              <label>API Key</label>
              <div className="form-row-inline">
                <input
                  className="grow"
                  type={showKey ? 'text' : 'password'}
                  value={s.apiKey}
                  placeholder="sk-…（仅保存在本机）"
                  onChange={(e) => set({ apiKey: e.target.value.trim() })}
                />
                <button className="btn" onClick={() => setShowKey((v) => !v)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
            </div>

            <div className="form-row">
              <label>模型名称</label>
              <input value={s.model} placeholder="gpt-4o-mini / deepseek-chat / glm-4.7…" onChange={(e) => set({ model: e.target.value.trim() })} />
            </div>

            <div className="form-row">
              <label>🧭 planner 强推理模型（可选，仅用于重规划 / 严格复核 / 卡住节点专家重试，不参与逐步执行）</label>
              <div className="field-hint">
                建议：主模型 = 快速对话模型（逐步执行），planner = 强推理模型（规划/复核/专家重试）。
                留空 = 跟随主配置（全链路行为不变）。
              </div>
            </div>
            <div className="form-inline">
              <div className="form-row">
                <label>planner 接口地址</label>
                <input
                  placeholder="留空跟随主配置"
                  value={s.planner?.baseURL || ''}
                  onChange={(e) => set({ planner: { ...s.planner, baseURL: e.target.value.trim() } })}
                />
              </div>
              <div className="form-row">
                <label>planner 模型</label>
                <input
                  placeholder="留空跟随主配置"
                  value={s.planner?.model || ''}
                  onChange={(e) => set({ planner: { ...s.planner, model: e.target.value.trim() } })}
                />
              </div>
            </div>
            <div className="form-row">
              <label>planner API Key</label>
              <input
                type="password"
                placeholder="留空跟随主配置"
                value={s.planner?.apiKey || ''}
                onChange={(e) => set({ planner: { ...s.planner, apiKey: e.target.value } })}
              />
            </div>
          </div>
        )}

        {tab === 'run' && (
          <div className="tab-pane" role="tabpanel">
            <div className="pane-intro">任务执行方式：模型分工、视觉、复核与节奏</div>

            <div className="form-row">
              <label>AI 处理模式（混合模式用本地小模型秒出简单步骤，不确定时自动回退云端）</label>
              <select value={s.aiMode} onChange={(e) => set({ aiMode: e.target.value as 'hybrid' | 'cloud' })}>
                <option value="hybrid">混合模式（推荐：⚡本地快速决策 + 云端大模型）</option>
                <option value="cloud">纯大模型（所有步骤都由接入的云端模型决策）</option>
              </select>
              <div className="field-hint">
                {fast?.state === 'ready'
                  ? '⚡ 本地快速决策模型已就绪（Qwen2.5-0.5B int8，仅本机推理，不发数据上云）'
                  : fast?.state === 'downloading' || fast?.state === 'loading'
                    ? `本地模型${fast.state === 'downloading' ? '下载' : '加载'}中${fast.progress ? ` ${Math.round(fast.progress * 100)}%` : ''}：${fast.detail || ''}`
                    : fast?.bundled
                      ? '安装包已内置本地快速决策模型（Qwen2.5-0.5B int8），点击下方按钮加载即可，无需下载'
                      : '混合模式需先下载本地快速决策模型（Qwen2.5-0.5B int8，约 500MB，来源 hf-mirror，仅本机使用）；未就绪时自动等效纯大模型模式'}
              </div>
              {fast?.state !== 'ready' && (
                <div className="fast-init-row">
                  <button className="btn" onClick={startFastInit} disabled={fastBusy || fast?.state === 'downloading' || fast?.state === 'loading'}>
                    {fastBusy || fast?.state === 'downloading' || fast?.state === 'loading'
                      ? '处理中…'
                      : fast?.state === 'error'
                        ? '重试加载'
                        : fast?.bundled
                          ? '加载内置本地模型'
                          : '下载并加载本地模型'}
                  </button>
                  {fast?.state === 'error' && <span className="field-hint no-top">{fast.detail}</span>}
                </div>
              )}
            </div>

            <div className="form-row">
              <label>视觉模式（每步把页面视口截图发给模型，看图+元素列表一起判断，更准；每步约多 0.5k~2k tokens）</label>
              <select value={s.vision ? '1' : '0'} onChange={(e) => set({ vision: e.target.value === '1' })}>
                <option value="0">关闭（默认：仅元素列表，0 图片费用）</option>
                <option value="1">开启（需模型支持图片输入，如 glm-4.5v / gpt-4o / qwen-vl / kimi-latest；glm-4.7、deepseek-chat 为纯文本）</option>
              </select>
              <div className="field-hint">模型不支持图片时会自动降级为元素列表模式，任务不会中断；「测试连接」会顺带探测视觉支持</div>
            </div>

            <div className="form-row">
              <label>视觉兜底（元素列表连续定位不到目标时，自动临时开几步截图，让模型「看图定位」并支持按截图坐标点击）</label>
              <select value={s.visionFallback === false ? '0' : '1'} onChange={(e) => set({ visionFallback: e.target.value === '1' })}>
                <option value="1">开启（默认：疑难页面才发图，平时 0 图片费用）</option>
                <option value="0">关闭（任何情况下都不发截图）</option>
              </select>
              <div className="field-hint">只在「元素失效/不可见/页面提不出元素」连着发生时触发，连点 3 步后自动回到常规模式；模型不支持图片时改用本地 OCR 文字兜底</div>
            </div>

            <div className="form-row">
              <label>节点复核模式（任务分解为节点链，每节点按「预期」复核，未通过自动修正重试）</label>
              <select
                value={s.verifyMode || 'fast'}
                onChange={(e) => set({ verifyMode: e.target.value as 'off' | 'fast' | 'strict' })}
              >
                <option value="fast">快速（默认：本地信号 + 本地快速决策模型复核，0 额外 token）</option>
                <option value="strict">严格（加云端大模型终审，更准但每个节点多一次小调用）</option>
                <option value="off">关闭（不分解节点、不复核，逐步执行）</option>
              </select>
              <div className="field-hint">
                复核顺序：页面文字/URL/选择器本地判定 → 本地快速决策模型 →（严格模式）云端大模型；未通过时自动开启视觉看图修正并重试（最多 3
                次），多次失败暂停等人工介入
              </div>
            </div>

            <div className="form-inline">
              <div className="form-row">
                <label>单任务最大步数（{s.maxSteps}）</label>
                <input
                  type="number"
                  min={5}
                  max={100}
                  value={s.maxSteps}
                  onChange={(e) => set({ maxSteps: Math.max(5, Math.min(100, Number(e.target.value) || 30)) })}
                />
              </div>
              <div className="form-row">
                <label>每步元素上限（{s.maxElements}，越小越省 token）</label>
                <input
                  type="number"
                  min={20}
                  max={120}
                  value={s.maxElements}
                  onChange={(e) => set({ maxElements: Math.max(20, Math.min(120, Number(e.target.value) || 80)) })}
                />
              </div>
            </div>

            <div className="form-row">
              <label>操作速度</label>
              <select value={s.speed} onChange={(e) => set({ speed: e.target.value as 'fast' | 'normal' | 'slow' })}>
                <option value="fast">极速（无拟人延迟：内部系统/调试，最快）</option>
                <option value="normal">正常（默认）</option>
                <option value="slow">慢速（更拟人，风控敏感站点如淘宝/小红书）</option>
              </select>
            </div>
          </div>
        )}

        {tab === 'smart' && (
          <div className="tab-pane" role="tabpanel">
            <div className="pane-intro-row">
              <div className="pane-intro" style={{ marginBottom: 0 }}>
                感知与智能化开关：全部默认开启、可独立关闭回滚（点击行内开关切换；悬停名称看说明）
              </div>
              <button
                className="btn"
                title="把本页全部开关恢复为官方默认值"
                onClick={() =>
                  set({
                    semanticRecall: true,
                    semanticVerify: true,
                    boostedExtract: true,
                    prescreen: true,
                    axTree: true,
                    ocrEnhance: true,
                    structuredOut: true,
                    timelineShot: 'smart',
                    diagnose: true,
                    multiCandidate: true,
                    reflection: true,
                    replan: true,
                    actionVerify: true,
                    smartWait: true,
                    locatorChain: true,
                    shadowDom: true,
                    humanLike: true,
                    telemetry: true,
                    persistSession: true,
                    autoExperience: true,
                    cacheAccounting: true,
                    stableSystemPrompt: true,
                    outputBudget: true,
                    textGridCoords: 'edges',
                    historyFold: true,
                    pagedRead: true,
                    obsDetail: true,
                    replanTune: true,
                    clickVerifyTune: true,
                    localRetry: true,
                    pageHashSkip: true,
                    repeatNudge: true
                  })
                }
              >
                ↺ 恢复默认
              </button>
            </div>

            <div className="cfg-group">语义与感知 <span>元素提取、语义匹配与结构化输出的增强项</span></div>
            <div className="cfg-grid">
              <Toggle label="语义重排" tip="把与任务语义相关的元素提到列表前面（商品名称≈品名）" on={s.semanticRecall !== false} onChange={(v) => set({ semanticRecall: v })} />
              <Toggle label="填后语义校验" tip="值填对了但字段不对时显式报错（静默错误归零）" on={s.semanticVerify !== false} onChange={(v) => set({ semanticVerify: v })} />
              <Toggle label="扩展提取" tip="目标关键词一个都没命中时提高上限重提取一次" on={s.boostedExtract !== false} onChange={(v) => set({ boostedExtract: v })} />
              <Toggle label="本地语义初筛" tip="候选过多时本地小模型先筛 Top-20（视口前 8 强制保留，1.2s 预算）" on={s.prescreen !== false} onChange={(v) => set({ prescreen: v })} />
              <Toggle label="AX 树感知" tip="浏览器引擎计算的可访问性语义叠加进元素列表（自定义控件友好）" on={s.axTree !== false} onChange={(v) => set({ axTree: v })} />
              <Toggle label="OCR 图标增强" tip="给无文字的图片类候选补 OCR 标签（后台并行，不拖慢单步）" on={s.ocrEnhance !== false} onChange={(v) => set({ ocrEnhance: v })} />
              <Toggle label="结构化输出" tip="JSON schema 原生输出（探测式启用，失败自动降级）" on={s.structuredOut !== false} onChange={(v) => set({ structuredOut: v })} />
              <label className="cfg-toggle" title="时间线截图的清晰度分级">
                <span className="cfg-name">时间线截图</span>
                <select
                  className="cfg-select"
                  value={s.timelineShot ?? 'smart'}
                  onChange={(e) => set({ timelineShot: e.target.value as 'all' | 'smart' | 'off' })}
                >
                  <option value="smart">分级</option>
                  <option value="all">全高清</option>
                  <option value="off">不截图</option>
                </select>
              </label>
            </div>

            <div className="cfg-group">自愈与守护 <span>失败恢复、防错点与等待策略</span></div>
            <div className="cfg-grid">
              <Toggle label="失败自愈诊断" tip="按七类失败归因并注入修正提示" on={s.diagnose !== false} onChange={(v) => set({ diagnose: v })} />
              <Toggle label="多候选裁决" tip="模型给出 2-3 个候选编号时按语义相似度自动定夺" on={s.multiCandidate !== false} onChange={(v) => set({ multiCandidate: v })} />
              <Toggle label="反思失败清单" tip="同一目标同一方式失败 2 次后禁止第 3 次重复" on={s.reflection !== false} onChange={(v) => set({ reflection: v })} />
              <Toggle label="动态重规划" tip="连续无节点推进时自动重排剩余节点（收尾强制云端复核）" on={s.replan !== false} onChange={(v) => set({ replan: v })} />
              <Toggle label="动作后核验" tip="动作后页面无变化时显式提示，防止模型脑补成功" on={s.actionVerify !== false} onChange={(v) => set({ actionVerify: v })} />
              <Toggle label="智能等待" tip="DOM/网络静默信号替代固定盲等（特殊页面自动熔断回退）" on={s.smartWait !== false} onChange={(v) => set({ smartWait: v })} />
              <Toggle label="定位链" tip="元素失效后按容器锚点/语义键重定位（含 path 命中文本校验）" on={s.locatorChain !== false} onChange={(v) => set({ locatorChain: v })} />
              <Toggle label="Shadow DOM" tip="元素提取穿透 open shadow root（组件库表单可见可操作）" on={s.shadowDom !== false} onChange={(v) => set({ shadowDom: v })} />
            </div>

            <div className="cfg-group">Token 优化（v4.6） <span>省 token / 提速 / 步数收敛——默认全开，出问题逐项关闭回滚</span></div>
            <div className="cfg-grid">
              <Toggle label="用量分账" tip="缓存命中率与各调用点（决策/规划/复核/点击复核）token 分账（纯计量，建议常开）" on={s.cacheAccounting !== false} onChange={(v) => set({ cacheAccounting: v })} />
              <Toggle label="缓存断点修复" tip="视觉/画布/测试附加段移出 system——模式切换不再击穿提示词缓存（大模型多步任务省一半以上输入）" on={s.stableSystemPrompt !== false} onChange={(v) => set({ stableSystemPrompt: v })} />
              <Toggle label="输出预算分档" tip="按调用点与模型档位收紧 max_tokens（推理模型自动放宽；截断时自动回退旧预算）" on={s.outputBudget !== false} onChange={(v) => set({ outputBudget: v })} />
              <Toggle label="历史折叠" tip="超过 12 步的任务折叠早期步骤摘要（用户指导与近期错误保留）" on={s.historyFold !== false} onChange={(v) => set({ historyFold: v })} />
              <Toggle label="正文分片读取" tip="read_content 默认只回填前 800 字，模型按需 offset 续读（缓存秒回，不重复 OCR）" on={s.pagedRead !== false} onChange={(v) => set({ pagedRead: v })} />
              <Toggle label="元素列表分档" tip="非密集页用精简行格式（语义行与视口前 8 行保留全字段；密集页/出错步自动全量）" on={s.obsDetail !== false} onChange={(v) => set({ obsDetail: v })} />
              <Toggle label="打转调优" tip="2 步无推进/同一失败重复 2 次即触发重规划（上限 3 次），重规划附带失败现场" on={s.replanTune !== false} onChange={(v) => set({ replanTune: v })} />
              <Toggle label="点击复核分档" tip="expect_text 已含行标识的同名行跳过放大截图复核（提交/删除/支付类恒复核不放宽）" on={s.clickVerifyTune !== false} onChange={(v) => set({ clickVerifyTune: v })} />
              <Toggle label="本地重试扩权" tip="本地快速决策失败冷却 10→5 步，简单重试步不再交云端税" on={s.localRetry !== false} onChange={(v) => set({ localRetry: v })} />
              <Toggle label="免观测降级" tip="页面与上一步完全相同时省略元素列表（单步省 ~2k token；连续 2 次自动回全量）" on={s.pageHashSkip !== false} onChange={(v) => set({ pageHashSkip: v })} />
              <Toggle label="repeat 提示" tip="连续 3 步同构动作时建议用 repeat 一次执行多轮（翻页采集/批量操作）" on={s.repeatNudge !== false} onChange={(v) => set({ repeatNudge: v })} />
              <label className="cfg-toggle" title="纯文本模式下粗网格坐标的输出范围">
                <span className="cfg-name">网格坐标</span>
                <select
                  className="cfg-select"
                  value={s.textGridCoords ?? 'edges'}
                  onChange={(e) => set({ textGridCoords: e.target.value as 'edges' | 'all' | 'off' })}
                >
                  <option value="edges">首尾保留（省 token）</option>
                  <option value="all">每行输出</option>
                  <option value="off">不输出</option>
                </select>
              </label>
            </div>

            <div className="cfg-group">拟人与数据 <span>操作节奏、埋点与会话</span></div>
            <div className="cfg-grid">
              <Toggle label="拟人化操作" tip="逐字符输入 + 曲线移动鼠标（风控敏感站点建议开启；极速档自动跳过）" on={s.humanLike !== false} onChange={(v) => set({ humanLike: v })} />
              <Toggle label="经验自动沉淀" tip="AI 任务中自动积累站点字段映射/教训/成功路径" on={s.autoExperience !== false} onChange={(v) => set({ autoExperience: v })} />
              <Toggle label="运行埋点" tip="本地 jsonl 记录步耗时/失败分类（不发任何数据）" on={s.telemetry !== false} onChange={(v) => set({ telemetry: v })} />
              <Toggle label="持久化会话" tip="登录态跨启动保留" on={s.persistSession !== false} onChange={(v) => set({ persistSession: v })} />
            </div>

            <details className="cfg-details">
              <summary>自动经验库（{expList?.length ?? 0} 条）</summary>
              <div className="form-row" style={{ marginTop: 8 }}>
                <label>
                  AI 任务中自动沉淀的站点字段映射/教训/成功路径，注入提示词加速二次执行
                  {expList && expList.length > 0 && (
                    <span className="ccimport-btn" style={{ marginLeft: 8 }} onClick={clearExp}>
                      清空
                    </span>
                  )}
                </label>
                {expList === null ? (
                  <div className="field-hint">读取中…</div>
                ) : expList.length === 0 ? (
                  <div className="field-hint">暂无自动经验——跑几个任务后，AI 会把「商品名称→实际字段名」这类对应关系自动记下来</div>
                ) : (
                  <div className="ccimport-list">
                    {expList.slice(0, 12).map((e) => (
                      <div key={e.id} className="ccimport-item" title={e.value}>
                        <span className="ccimport-tag">{e.kind === 'field_map' ? '字段映射' : e.kind === 'lesson' ? '教训' : '路径'}</span>
                        <span className="ccimport-name">{e.domain || '全局'}</span>
                        <span className="ccimport-meta">
                          {e.key.slice(0, 16)} → {e.value.slice(0, 40)}（验证 {e.score} 次{e.enabled ? '' : '，已停用'}）
                        </span>
                        <span className="ccimport-tag" onClick={() => removeExp(e.id)} title="删除这条经验">
                          <X size={11} strokeWidth={2.5} />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}
        {tab === 'browser' && (
          <div className="tab-pane" role="tabpanel">
            <div className="pane-intro">浏览器行为与关于</div>

            <div className="form-inline">
              <div className="form-row">
                <label>后台/最小化运行</label>
                <select value={s.bgRun ? '1' : '0'} onChange={(e) => set({ bgRun: e.target.value === '1' })}>
                  <option value="0">关闭（默认：最小化时页面可能被节流降速）</option>
                  <option value="1">开启（窗口最小化仍全速执行；修改后重启应用生效）</option>
                </select>
              </div>
              <div className="form-row">
                <label>关闭窗口时</label>
                <select
                  value={s.closeAction || 'ask'}
                  onChange={(e) => set({ closeAction: e.target.value as 'ask' | 'tray' | 'exit' })}
                >
                  <option value="ask">每次询问（默认：问最小化到托盘还是退出）</option>
                  <option value="tray">最小化到托盘（AI 任务继续跑，托盘图标可回到窗口）</option>
                  <option value="exit">直接退出程序</option>
                </select>
              </div>
            </div>
            <div className="form-row">
              <label>主页</label>
              <input value={s.homepage} onChange={(e) => set({ homepage: e.target.value.trim() })} />
            </div>

            <div className="about-box">
              <b>EasyBow · AI 浏览器</b>
              <span>v{version || '…'}</span>
              <span>作者：clb &lt;lamthebest@foxmail.com&gt; · MIT · 问题反馈：邮件或在仓库提 Issue</span>
            </div>
          </div>
        )}

        {testResult && <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.message}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={test} disabled={testing || !s.apiKey || !s.model}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
