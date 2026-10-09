import { app } from 'electron'
import { readFileSync, existsSync } from 'fs'
import { writeJsonAtomic } from './fsutil'
import { join } from 'path'
import type { TaskTemplate } from '@shared/types'

/**
 * 任务模板库：任务输入快速填充（chips / 「/」快捷 / 菜单）。
 * 支持自动变量（{{日期}} 等，插入时解析）与填空变量（{{字段:说明}}，插入时弹表单）。
 */

const tplPath = () => join(app.getPath('userData'), 'templates.json')

/** 内置模板（首次使用预置；用户可改可删） */
const SEED: TaskTemplate[] = [
  {
    id: 1,
    name: '📋 跨页签搬运数据',
    group: '常用',
    pinned: true,
    ts: 0,
    text: `在页签1：打开（网址或说明），读取以下数据：
- 字段1：
- 字段2：
- 字段3：
用 save 把每条数据存入任务记忆。

然后 switch_tab 到页签2：在（目标页面说明）中，把记忆中的数据逐项填入对应输入框（长文本可用 {{记忆键}} 引用），填写完成后核对一遍再提交，并用 done 说明结果。`
  },
  {
    id: 2,
    name: '🔍 信息采集汇总',
    group: '常用',
    pinned: true,
    ts: 0,
    text: `在当前页签浏览（列表/搜索结果说明），读取前 N 条的（字段1、字段2、字段3），整理成表格；
内容不足时先 scroll 向下滚动再继续读取；
完成后用 done 输出汇总表格。`
  },
  {
    id: 3,
    name: '📝 表单填写',
    group: '常用',
    pinned: true,
    ts: 0,
    text: `在当前页面找到表单并逐项填写：
字段A = 值
字段B = 值
字段C = {{记忆键}}
填完先不要提交，用 done 说明每项的填写结果，等我确认。`
  },
  {
    id: 4,
    name: '🛒 下单/操作流程',
    group: '常用',
    pinned: true,
    ts: 0,
    text: `在页签1完成以下流程：
1. （第一步，如：搜索某商品并进入详情页）
2. （第二步，如：选择规格数量加入购物车）
3. （第三步）
每一步完成后简述进展；遇到登录或验证码时说明并等待人工处理；最终用 done 报告结果。`
  },
  {
    id: 5,
    name: '📅 每日数据搬运（带日期）',
    group: '定时任务',
    pinned: true,
    ts: 0,
    text: `打开（数据源页面），读取 {{今天}}（{{日期}}）的（数据项）并存入任务记忆；
再切到（目标页面）把数据填入对应表单/文档，完成后用 done 报告填写结果。`
  }
]

let cached: TaskTemplate[] | null = null

export function getTemplates(): TaskTemplate[] {
  if (cached) return cached
  try {
    if (existsSync(tplPath())) {
      const raw = JSON.parse(readFileSync(tplPath(), 'utf-8'))
      cached = Array.isArray(raw) ? raw.filter((e) => e && typeof e.text === 'string' && typeof e.name === 'string') : []
    } else {
      cached = SEED.map((t) => ({ ...t }))
      save()
    }
  } catch {
    cached = []
  }
  return cached
}

/** 新建或更新（带 id 为更新） */
export function saveTemplate(t: {
  id?: number
  name: string
  group?: string
  text: string
  pinned?: boolean
}): TaskTemplate[] {
  const list = getTemplates().slice()
  const item: TaskTemplate = {
    id: typeof t.id === 'number' ? t.id : (list.reduce((m, x) => Math.max(m, x.id), 0) || 0) + 1,
    name: String(t.name || '').trim().slice(0, 40) || '未命名模板',
    group: String(t.group || '').trim().slice(0, 20),
    text: String(t.text || ''),
    pinned: t.pinned !== false,
    ts: Date.now()
  }
  const at = list.findIndex((x) => x.id === item.id)
  if (at >= 0) list[at] = item
  else list.push(item)
  cached = list
  save()
  return cached
}

export function deleteTemplate(id: number): TaskTemplate[] {
  cached = getTemplates().filter((x) => x.id !== id)
  save()
  return cached
}

function save(): void {
  try {
    writeJsonAtomic(tplPath(), cached || [])
  } catch (e) {
    console.error('[easybow] 保存任务模板失败:', e)
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * 解析自动变量（填空变量 {{字段:说明}} 不在此处理，由渲染进程弹表单填写）。
 * tab 缺省时 {{当前网址}}/{{页签标题}} 置空。
 */
export function resolveTemplateVars(text: string, tab?: { title: string; url: string }): string {
  const now = new Date()
  const day = 86400000
  return text
    .replace(/\{\{日期\}\}/g, fmtDate(now))
    .replace(/\{\{时间\}\}/g, `${pad(now.getHours())}:${pad(now.getMinutes())}`)
    .replace(/\{\{今天\}\}/g, fmtDate(now))
    .replace(/\{\{昨天\}\}/g, fmtDate(new Date(now.getTime() - day)))
    .replace(/\{\{明天\}\}/g, fmtDate(new Date(now.getTime() + day)))
    .replace(/\{\{当前网址\}\}/g, tab?.url || '')
    .replace(/\{\{页签标题\}\}/g, tab?.title || '')
}
