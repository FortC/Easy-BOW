import { existsSync, copyFileSync, rmSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import type { Protocol } from '@shared/types'

/** cc-switch 里可导入的供应商条目 */
export interface CCSwitchProvider {
  id: string
  appType: string
  name: string
  isCurrent: boolean
  protocol: Protocol
  baseURL: string
  apiKey: string
  model: string
}

/** claude 类条目：settings_config.env 里的 ANTHROPIC_* */
function extractAnthropic(env: Record<string, string> | undefined): Omit<CCSwitchProvider, 'id' | 'appType' | 'name' | 'isCurrent'> {
  const e = env || {}
  return {
    protocol: 'anthropic',
    baseURL: e.ANTHROPIC_BASE_URL || '',
    apiKey: e.ANTHROPIC_AUTH_TOKEN || e.ANTHROPIC_API_KEY || '',
    model: e.ANTHROPIC_MODEL || e.ANTHROPIC_DEFAULT_SONNET_MODEL || e.ANTHROPIC_DEFAULT_OPUS_MODEL || ''
  }
}

/** codex 类条目：auth.OPENAI_API_KEY + config.toml 里的 model / base_url */
function extractCodex(settingsConfig: any): Omit<CCSwitchProvider, 'id' | 'appType' | 'name' | 'isCurrent'> {
  const apiKey = settingsConfig?.auth?.OPENAI_API_KEY || ''
  let model = ''
  let baseURL = ''
  const toml: string = typeof settingsConfig?.config === 'string' ? settingsConfig.config : ''
  if (toml) {
    // 找到生效的 model_provider = "x"，再取 [model_providers.x] 段的 base_url
    const providerMatch = /^\s*model_provider\s*=\s*"([^"]+)"/m.exec(toml)
    let section = toml
    if (providerMatch) {
      const sec = new RegExp(`\\[model_providers\\.${providerMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]([\\s\\S]*?)(?=\\n\\[|$)`).exec(toml)
      if (sec) section = sec[1]
    }
    const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(section) || /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)
    if (m) model = m[1]
    const b = /^\s*base_url\s*=\s*"([^"]+)"/m.exec(section) || /^\s*base_url\s*=\s*"([^"]+)"/m.exec(toml)
    if (b) baseURL = b[1]
  }
  return { protocol: 'openai', baseURL, apiKey, model }
}

function toProvider(appType: string, id: string, name: string, isCurrent: boolean, settingsConfig: any): CCSwitchProvider | null {
  let base: Omit<CCSwitchProvider, 'id' | 'appType' | 'name' | 'isCurrent'>
  if (appType === 'codex') {
    base = extractCodex(settingsConfig)
    // codex 条目兼容：有的把 env 平铺在 settings_config 里
    if (!base.apiKey || !base.baseURL) {
      const envBase = extractAnthropic(settingsConfig?.env)
      if (!base.apiKey) base.apiKey = settingsConfig?.env?.OPENAI_API_KEY || settingsConfig?.env?.ANTHROPIC_AUTH_TOKEN || ''
      if (!base.baseURL) base.baseURL = envBase.baseURL
      if (!base.model) base.model = envBase.model
    }
  } else {
    base = extractAnthropic(settingsConfig?.env)
  }
  if (!base.apiKey && !base.baseURL) return null // 空壳条目跳过
  return { id, appType, name: name || id, isCurrent: !!isCurrent, ...base }
}

/** 加载 node:sqlite：CJS require 优先（Electron 主进程产物），动态 import 兜底（ESM 场景） */
async function loadSqlite(): Promise<typeof import('node:sqlite') | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite') as typeof import('node:sqlite')
  } catch {}
  try {
    return await import('node:sqlite')
  } catch {
    return null
  }
}

/** 新版 cc-switch（≥3.5）：SQLite 库。先拷贝到临时文件再读，避免库被占用/锁死 */
async function readFromDb(dir: string): Promise<CCSwitchProvider[] | null> {
  const dbPath = join(dir, 'cc-switch.db')
  if (!existsSync(dbPath)) return null
  const tmp = join(tmpdir(), `easybow-ccswitch-${Date.now()}.db`)
  const tmps = [tmp, tmp + '-wal', tmp + '-shm']
  try {
    copyFileSync(dbPath, tmp)
    for (const ext of ['-wal', '-shm']) {
      try {
        copyFileSync(dbPath + ext, tmp + ext)
      } catch {}
    }
    const sqlite = await loadSqlite()
    if (!sqlite) return null
    const db = new sqlite.DatabaseSync(tmp, { readOnly: true })
    try {
      const rows = db.prepare('SELECT id, app_type, name, settings_config, is_current FROM providers').all() as any[]
      const out: CCSwitchProvider[] = []
      for (const r of rows) {
        let cfg: any = null
        try {
          cfg = JSON.parse(r.settings_config)
        } catch {}
        const p = toProvider(String(r.app_type || ''), String(r.id || ''), String(r.name || ''), r.is_current, cfg)
        if (p) out.push(p)
      }
      return out
    } finally {
      try {
        db.close()
      } catch {}
    }
  } catch {
    return null
  } finally {
    for (const f of tmps) {
      try {
        rmSync(f, { force: true })
      } catch {}
    }
  }
}

/** 旧版 cc-switch（<3.5）：config.json（providers.claude / providers.codex 两桶） */
function readFromJson(dir: string): CCSwitchProvider[] {
  const jsonPath = join(dir, 'config.json')
  if (!existsSync(jsonPath)) return []
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cfg = JSON.parse(require('fs').readFileSync(jsonPath, 'utf8'))
    const buckets: any = cfg?.providers || {}
    const out: CCSwitchProvider[] = []
    for (const [appType, bucket] of Object.entries(buckets)) {
      if (!bucket || typeof bucket !== 'object') continue
      for (const p of Object.values<any>(bucket)) {
        if (!p || typeof p !== 'object') continue
        const sc = p.settingsConfig || p.settings_config
        const item = toProvider(appType, String(p.id || ''), String(p.name || ''), p.isCurrent ?? p.is_current, sc)
        if (item) out.push(item)
      }
    }
    return out
  } catch {
    return []
  }
}

/** 读取本机 cc-switch 的供应商列表（SQLite 新版优先，旧版 JSON 兜底） */
export async function listCCSwitchProviders(): Promise<CCSwitchProvider[]> {
  const dir = join(homedir(), '.cc-switch')
  if (!existsSync(dir)) {
    throw new Error('未找到 cc-switch 配置（~/.cc-switch），请确认已安装 cc-switch')
  }
  const fromDb = await readFromDb(dir)
  const list = fromDb ?? readFromJson(dir)
  if (!list.length) {
    throw new Error('cc-switch 里没有可导入的供应商（未配置 baseURL / API Key）')
  }
  // 当前使用的排最前，其余按名称
  return list.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name))
}
