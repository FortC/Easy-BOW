import { Settings as SettingsIcon, X } from 'lucide-react'
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

export default function SettingsModal(props: {
  open?: boolean
  initial: Settings | null
  onClose: () => void
  onSaved: (s: Settings) => void
}) {
  const [s, setS] = useState<Settings>(props.initial || DEFAULT_SETTINGS)
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
        aria-label="设置 — AI 接口"
        tabIndex={-1}
      >
        <div className="modal-head">
          <h3 className="with-ico"><SettingsIcon size={16} strokeWidth={2} /> 设置 — AI 接口</h3>
          <button className="close-x" aria-label="关闭设置" title="关闭（Esc）" onClick={requestClose}>
            <X size={14} strokeWidth={2.5} />
          </button>
        </div>

        <div className="modal-body">

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

        <div className="form-inline">
          <div className="form-row">
            <label>操作速度（风控敏感站点选慢速）</label>
            <select value={s.speed} onChange={(e) => set({ speed: e.target.value as 'normal' | 'slow' })}>
              <option value="normal">正常（更快）</option>
              <option value="slow">慢速（更拟人，适合淘宝/小红书）</option>
            </select>
          </div>
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
          <div className="form-row">
            <label>主页</label>
            <input value={s.homepage} onChange={(e) => set({ homepage: e.target.value.trim() })} />
          </div>
        </div>

        <div className="form-row">
          <label>🧠 智能增强（v2.0：语义匹配 / 失败自愈 / 经验沉淀；出问题时可逐项关闭回滚）</label>
          <div className="field-hint">
            语义重排把与任务相关的元素提前（商品名称≈品名）；填后校验把「值填对但字段填错」显式报错；
            失败自愈按七类失败归因并注入修正提示；AX 树给自定义控件补浏览器引擎语义；拟人化操作逐字符输入+曲线移动鼠标
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>语义重排</label>
            <select value={s.semanticRecall === false ? '0' : '1'} onChange={(e) => set({ semanticRecall: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>填后语义校验</label>
            <select value={s.semanticVerify === false ? '0' : '1'} onChange={(e) => set({ semanticVerify: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>扩展提取</label>
            <select value={s.boostedExtract === false ? '0' : '1'} onChange={(e) => set({ boostedExtract: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>失败自愈诊断</label>
            <select value={s.diagnose === false ? '0' : '1'} onChange={(e) => set({ diagnose: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>多候选裁决</label>
            <select value={s.multiCandidate === false ? '0' : '1'} onChange={(e) => set({ multiCandidate: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>AX 树感知</label>
            <select value={s.axTree === false ? '0' : '1'} onChange={(e) => set({ axTree: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>经验自动沉淀</label>
            <select value={s.autoExperience === false ? '0' : '1'} onChange={(e) => set({ autoExperience: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>本地语义初筛</label>
            <select value={s.prescreen === false ? '0' : '1'} onChange={(e) => set({ prescreen: e.target.value === '1' })}>
              <option value="1">开启（默认）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>拟人化操作</label>
            <select value={s.humanLike === false ? '0' : '1'} onChange={(e) => set({ humanLike: e.target.value === '1' })}>
              <option value="1">开启（默认：逐字符输入/曲线鼠标）</option>
              <option value="0">关闭（瞬时操作，最快）</option>
            </select>
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>运行埋点（trace）</label>
            <select value={s.telemetry === false ? '0' : '1'} onChange={(e) => set({ telemetry: e.target.value === '1' })}>
              <option value="1">开启（默认：本地 jsonl，不发任何数据）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>持久化会话</label>
            <select
              value={s.persistSession === false ? '0' : '1'}
              onChange={(e) => set({ persistSession: e.target.value === '1' })}
            >
              <option value="1">开启（默认：登录态跨启动保留）</option>
              <option value="0">关闭（每次启动全新会话）</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <label>⚡ v3.0 操控升级（智能等待 / 定位链 / 反思重规划；默认全开，出问题可逐项关闭独立回滚）</label>
          <div className="field-hint">
            智能等待用页面静默信号替代固定盲等；定位链在页面改版后按容器锚点/语义键重定位（写操作禁坐标兜底）；
            反思禁止重复失败方式、卡住自动重规划（重规划后收尾强制 L2 复核）
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>智能等待</label>
            <select value={s.smartWait === false ? '0' : '1'} onChange={(e) => set({ smartWait: e.target.value === '1' })}>
              <option value="1">开启（默认：DOM/网络静默信号）</option>
              <option value="0">关闭（固定等待，最保守）</option>
            </select>
          </div>
          <div className="form-row">
            <label>定位链</label>
            <select value={s.locatorChain === false ? '0' : '1'} onChange={(e) => set({ locatorChain: e.target.value === '1' })}>
              <option value="1">开启（默认：锚点/语义/就近重定位）</option>
              <option value="0">关闭（退回「全等+序号」仲裁）</option>
            </select>
          </div>
          <div className="form-row">
            <label>时间线截图</label>
            <select
              value={s.timelineShot ?? 'smart'}
              onChange={(e) => set({ timelineShot: e.target.value as 'all' | 'smart' | 'off' })}
            >
              <option value="smart">分级（默认：常规缩略/出错与完成高清）</option>
              <option value="all">全部高清</option>
              <option value="off">不截图</option>
            </select>
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>反思（失败清单）</label>
            <select value={s.reflection === false ? '0' : '1'} onChange={(e) => set({ reflection: e.target.value === '1' })}>
              <option value="1">开启（默认：禁止重复失败方式）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>动态重规划</label>
            <select value={s.replan === false ? '0' : '1'} onChange={(e) => set({ replan: e.target.value === '1' })}>
              <option value="1">开启（默认：卡住自动重排节点）</option>
              <option value="0">关闭</option>
            </select>
          </div>
          <div className="form-row">
            <label>动作后核验</label>
            <select value={s.actionVerify === false ? '0' : '1'} onChange={(e) => set({ actionVerify: e.target.value === '1' })}>
              <option value="1">开启（默认：页面无变化时提示）</option>
              <option value="0">关闭</option>
            </select>
          </div>
        </div>
        <div className="form-inline">
          <div className="form-row">
            <label>结构化输出</label>
            <select value={s.structuredOut === false ? '0' : '1'} onChange={(e) => set({ structuredOut: e.target.value === '1' })}>
              <option value="1">开启（默认：JSON schema 原生输出，自动降级）</option>
              <option value="0">关闭（纯文本 JSON）</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <label>🧭 planner 强推理模型（可选，仅用于重规划 / 严格复核 / 卡住节点专家重试，不参与逐步执行）</label>
          <div className="field-hint">
            建议：主模型 = 快速对话模型（逐步执行），planner = 强推理模型（规划/复核/专家重试）。
            留空 = 跟随主配置（全链路行为不变）。planner 不参与逐步执行。
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

        <div className="form-row">
          <label>
            自动经验库（AI 任务中自动沉淀的站点字段映射/教训/成功路径，注入提示词加速二次执行）
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

        {testResult && <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.message}</div>}

        <div className="about-box">
          <b>EasyBow · AI 浏览器</b>
          <span>v{version || '…'}</span>
          <span>作者：clb &lt;lamthebest@foxmail.com&gt; · MIT · 问题反馈：邮件或在仓库提 Issue</span>
        </div>
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
