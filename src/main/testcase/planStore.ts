import { app } from 'electron'
import { readFileSync } from 'fs'
import { join } from 'path'
import { writeJsonAtomic } from '../fsutil'
import type { StepPlan } from './plans'

const file = () => join(app.getPath('userData'), 'test-plans-v1.json')
function load(): StepPlan[] {
  try {
    const value = JSON.parse(readFileSync(file(), 'utf-8'))
    return Array.isArray(value) ? value.filter((p) => p.version === 1 && typeof p.key === 'string' && Array.isArray(p.actions) && p.actions.length <= 40) : []
  } catch { return [] }
}
export function getStepPlan(key: string): StepPlan | undefined { return load().find((p) => p.key === key) }
export function saveStepPlan(plan: StepPlan): void { writeJsonAtomic(file(), [plan, ...load().filter((p) => p.key !== plan.key)].slice(0, 300)) }
export function invalidateStepPlan(key: string): void { writeJsonAtomic(file(), load().filter((p) => p.key !== key)) }
