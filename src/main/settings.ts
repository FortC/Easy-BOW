import { app, safeStorage } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { writeJsonAtomic } from './fsutil'

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

let cached: Settings | null = null

/** 密文前缀：settings.json 里 apiKey 以此标识「已用 safeStorage 加密」 */
const ENC_PREFIX = 'enc:v1:'

/* ————— 入参白名单校验（复核 P1-8）：settings:set 的每个字段都当不可信输入 ————— */

const BOOLEANS: Array<keyof Settings> = [
  'vision',
  'visionFallback',
  'testLoginReuse',
  'bgRun',
  'telemetry',
  'semanticRecall',
  'semanticVerify',
  'boostedExtract',
  'diagnose',
  'axTree',
  'multiCandidate',
  'autoExperience',
  'prescreen',
  'humanLike',
  'persistSession'
]

function optionalEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined
}

function optionalBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function optionalStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined
}

function optionalInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const n = Math.round(v)
  return n >= min && n <= max ? n : undefined
}

/** URL 类字段（baseURL/homepage）只放行 http(s)（站点页签不可信，file:/data: 等一律拒） */
function optionalHttpUrl(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string' || v.length > max) return undefined
  if (v === '') return v // 允许清空（homepage 留空走默认、baseURL 留空走官方端点）
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:' ? v : undefined
  } catch {
    return undefined
  }
}

/**
 * 过滤并修正一个 settings 补丁：只保留白名单字段，类型/枚举/范围不合法的字段直接丢弃
 * （保留原值），绝不把渲染进程给的未知键合并进落盘设置。
 */
export function sanitizeSettingsPatch(patch: unknown): Partial<Settings> {
  if (!patch || typeof patch !== 'object') return {}
  const p = patch as Record<string, unknown>
  const out: Partial<Settings> = {}

  const provider = optionalEnum(p.provider, ['openai', 'anthropic'] as const)
  if (provider) out.provider = provider
  const aiMode = optionalEnum(p.aiMode, ['hybrid', 'cloud'] as const)
  if (aiMode) out.aiMode = aiMode
  const verifyMode = optionalEnum(p.verifyMode, ['off', 'fast', 'strict'] as const)
  if (verifyMode) out.verifyMode = verifyMode
  const speed = optionalEnum(p.speed, ['normal', 'slow'] as const)
  if (speed) out.speed = speed
  const closeAction = optionalEnum(p.closeAction, ['ask', 'tray', 'exit'] as const)
  if (closeAction) out.closeAction = closeAction

  const baseURL = optionalHttpUrl(p.baseURL, 300)
  if (baseURL !== undefined) out.baseURL = baseURL
  const homepage = optionalHttpUrl(p.homepage, 800)
  if (homepage !== undefined) out.homepage = homepage
  const apiKey = optionalStr(p.apiKey, 600)
  if (apiKey !== undefined) out.apiKey = apiKey
  const model = optionalStr(p.model, 200)
  if (model !== undefined) out.model = model
  const maxSteps = optionalInt(p.maxSteps, 1, 200)
  if (maxSteps !== undefined) out.maxSteps = maxSteps
  const maxElements = optionalInt(p.maxElements, 10, 400)
  if (maxElements !== undefined) out.maxElements = maxElements

  for (const k of BOOLEANS) {
    const b = optionalBool(p[k as string])
    if (b !== undefined) (out as Record<string, unknown>)[k] = b
  }
  return out
}

/* ————— apiKey 静态加密（复核 P1-9）：safeStorage（Windows DPAPI） ————— */

function encryptApiKey(plain: string): string {
  try {
    if (!plain || !safeStorage.isEncryptionAvailable()) return plain
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return plain
  }
}

function decryptApiKey(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'))
  } catch {
    // 解密失败（换机器/换账户）：宁可空也不把密文当 key 用
    return ''
  }
}

export function getSettings(): Settings {
  // safeStorage 需要 app ready；模块顶层（ready 前）只读原始值，ready 后由
  // settingsReloadAfterReady() 失效缓存重新解密（顶层那次仅读 bgRun 等布尔开关）
  if (cached) return cached
  try {
    if (existsSync(settingsPath())) {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      const merged = { ...DEFAULT_SETTINGS, ...raw }
      if (typeof merged.apiKey === 'string') merged.apiKey = decryptApiKey(merged.apiKey)
      cached = merged
    } else {
      cached = { ...DEFAULT_SETTINGS }
    }
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  return cached as Settings
}

/** app ready 后调用：使缓存失效，下一次 getSettings 重新解密 apiKey */
export function settingsReloadAfterReady(): void {
  cached = null
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  cached = next
  // 落盘前把 apiKey 换成密文（内存缓存保留明文供运行时使用）
  const persist = { ...next, apiKey: encryptApiKey(next.apiKey || '') }
  try {
    writeJsonAtomic(settingsPath(), persist)
  } catch (e) {
    console.error('[easybow] 保存设置失败:', e)
  }
  return next
}
