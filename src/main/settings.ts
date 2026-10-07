import { app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

const settingsPath = () => join(app.getPath('userData'), 'settings.json')

let cached: Settings | null = null

export function getSettings(): Settings {
  if (cached) return cached
  try {
    if (existsSync(settingsPath())) {
      const raw = JSON.parse(readFileSync(settingsPath(), 'utf-8'))
      cached = { ...DEFAULT_SETTINGS, ...raw }
    } else {
      cached = { ...DEFAULT_SETTINGS }
    }
  } catch {
    cached = { ...DEFAULT_SETTINGS }
  }
  return cached as Settings
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  cached = next
  try {
    writeFileSync(settingsPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (e) {
    console.error('[easybow] 保存设置失败:', e)
  }
  return next
}
