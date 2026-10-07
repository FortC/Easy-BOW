import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS, type CCSwitchProviderInfo, type FastLlmState, type Protocol, type Settings } from '@shared/types'

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

  useEffect(() => {
    window.easybow.appVersion().then(setVersion).catch(() => {})
  }, [])

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
    // 不做点击遮罩关闭：避免误触外部区域丢失正在编辑的配置（用 ✕ 或保存关闭）
    <div className="modal-mask">
      <div className="modal">
        <h3>
          ⚙ 设置 — AI 接口
          <span className="close-x" onClick={props.onClose}>
            ✕
          </span>
        </h3>

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
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              style={{ flex: 1 }}
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
            <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn" onClick={startFastInit} disabled={fastBusy || fast?.state === 'downloading' || fast?.state === 'loading'}>
                {fastBusy || fast?.state === 'downloading' || fast?.state === 'loading'
                  ? '处理中…'
                  : fast?.state === 'error'
                    ? '重试加载'
                    : fast?.bundled
                      ? '加载内置本地模型'
                      : '下载并加载本地模型'}
              </button>
              {fast?.state === 'error' && <span className="field-hint" style={{ marginTop: 0 }}>{fast.detail}</span>}
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
            <label>主页</label>
            <input value={s.homepage} onChange={(e) => set({ homepage: e.target.value.trim() })} />
          </div>
        </div>

        {testResult && <div className={`test-result ${testResult.ok ? 'ok' : 'bad'}`}>{testResult.message}</div>}

        <div className="about-box">
          <b>EasyBow · AI 浏览器</b>
          <span>v{version || '…'}</span>
          <span>作者：clb &lt;lamthebest@foxmail.com&gt; · MIT · 问题反馈：邮件或在仓库提 Issue</span>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={test} disabled={testing || !s.apiKey || !s.model}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn primary" onClick={save} disabled={saving}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
