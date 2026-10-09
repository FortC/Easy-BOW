/**
 * 任务模板变量助手（渲染进程）。
 * 填空变量语法 {{字段名:说明}} —— 插入模板/开始任务时弹表单填写；
 * 无说明的 {{记忆键}} 不视为变量（那是任务记忆引用，避免误弹填空框）。
 * 自动变量（{{日期}} 等）由主进程 resolveTemplateVars 解析。
 */

export interface TplVar {
  name: string
  desc: string
}

const VAR_RE = /\{\{([^{}:]+):([^{}]+)\}\}/g

/** 提取文本里的填空变量（按出现顺序去重） */
export function parseTemplateVars(text: string): TplVar[] {
  const out: TplVar[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, desc: m[2].trim() })
  }
  return out
}

/** 用填写的值替换填空变量；未填的保持原样 */
export function fillTemplateVars(text: string, values: Record<string, string>): string {
  return text.replace(VAR_RE, (full, name: string) => {
    const v = values[name.trim()]
    return v != null && v !== '' ? v : full
  })
}
