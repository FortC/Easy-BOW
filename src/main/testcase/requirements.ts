/** 给原始验收点确定性编号，编号在转换前建立，不能交给模型自由删减。 */
export function compileRequirements(md: string): { annotated: string; acceptance: Array<{ id: string; text: string }> } {
  const acceptance: Array<{ id: string; text: string }> = []
  const reserved = new Set(md.match(/\bAC-[\w.-]+\b/g) || [])
  let automatic = 0
  let fence = ''
  const annotated = md.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = ''; return line }
    if (fence) return line
    if (!/^\s*[-*]\s*\[[ xX]\]/.test(line) && !/\bAC-[\w.-]+\b/.test(line)) return line
    let id = line.match(/\bAC-[\w.-]+\b/)?.[0]
    if (!id) {
      do { id = `AC-AUTO-${String(++automatic).padStart(3, '0')}` } while (reserved.has(id))
      reserved.add(id)
    }
    if (!acceptance.some((a) => a.id === id)) acceptance.push({ id, text: line.trim() })
    return `${line} <!-- 验收点: ${id} -->`
  }).join('\n')
  return { annotated, acceptance }
}

/** 保留全文，包括超长单行；优先在段落边界切片。 */
export function requirementChunks(text: string, limit = 18000): string[] {
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    const boundary = rest.lastIndexOf('\n\n', limit)
    const end = boundary >= limit / 2 ? boundary + 2 : limit
    chunks.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) chunks.push(rest)
  return chunks
}
