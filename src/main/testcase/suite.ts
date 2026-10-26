import type { TestCase, TestRunStatus } from '../../shared/types'
import { parseTestCase } from './parser'

export interface TestSuite {
  name: string
  cases: TestCase[]
  acceptanceIds: string[]
}

/** 只把顶层 TESTCASE 标题当边界；围栏示例中的标题不是用例。 */
export function splitCaseMarkdown(md: string): { preamble: string; documents: string[] } {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const starts: number[] = []
  let fence = ''
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (m) { if (!fence) fence = m[1][0]; else if (fence === m[1][0]) fence = ''; return }
    if (!fence && /^#\s+TESTCASE\s*[:：]/i.test(line)) starts.push(i)
  })
  if (!starts.length) return { preamble: '', documents: [md] }
  return { preamble: lines.slice(0, starts[0]).join('\n'), documents: starts.map((n, i) => lines.slice(n, starts[i + 1] ?? lines.length).join('\n')) }
}

export function parseTestSuite(md: string): { ok: boolean; error?: string; suite?: TestSuite } {
  const { preamble, documents } = splitCaseMarkdown(md)
  const cases: TestCase[] = []
  for (const [i, doc] of documents.entries()) {
    const parsed = parseTestCase(doc)
    if (!parsed.ok || !parsed.tc) return { ok: false, error: `用例 ${i + 1}: ${parsed.error}` }
    parsed.tc.id = `TC-${String(i + 1).padStart(3, '0')}`
    for (const step of parsed.tc.steps) for (const assertion of step.assertions) assertion.id = `${parsed.tc.id}-${assertion.id}`
    cases.push(parsed.tc)
  }
  const declared = preamble.split('\n').filter((l) => /^[-*]\s*验收点\s*[:：]/.test(l.trim()))
    .flatMap((l) => l.replace(/^[-*]\s*验收点\s*[:：]\s*/, '').split(/[,，\s]+/).filter(Boolean))
  const acceptanceIds = [...new Set([...declared, ...cases.flatMap((c) => c.acceptanceIds || [])])]
  const name = preamble.match(/^#\s+TESTSUITE\s*[:：]\s*(.+)$/mi)?.[1]?.trim() || (cases.length === 1 ? cases[0].name : `${cases[0].name}等 ${cases.length} 个用例`)
  return { ok: true, suite: { name, cases, acceptanceIds } }
}

/** 未覆盖/未执行不会因为其他用例通过而被算作通过。 */
export function suiteCoverage(suite: TestSuite, results: Array<{ caseId: string; state: TestRunStatus['state'] }>): NonNullable<TestRunStatus['coverage']> {
  return suite.acceptanceIds.map((id) => {
    const mapped = suite.cases.filter((tc) => tc.acceptanceIds?.includes(id))
    const runs = results.filter((r) => mapped.some((tc) => tc.id === r.caseId))
    const status = !mapped.length ? 'uncovered' : runs.some((r) => r.state === 'failed' || r.state === 'error') ? 'failed'
      : !runs.length || runs.some((r) => r.state !== 'passed') || mapped.some((tc) => !tc.steps.some((s) => s.phase !== 'cleanup' && s.assertions.length) || runs.filter((r) => r.caseId === tc.id).length < Math.max(1, tc.groups?.length || 0)) ? 'not_run' : 'passed'
    return { id, status, cases: mapped.map((tc) => tc.id!) }
  })
}

/** 重跑完整的受影响用例/数据组，保留前置和清理，不能孤立重放一个依赖上文的失败步骤。 */
export function selectFailedCases(suite: TestSuite, indices: number[]): TestCase[] {
  const selected = new Set(indices)
  const out: TestCase[] = []
  let offset = 0
  for (const tc of suite.cases) {
    for (const group of tc.groups?.length ? tc.groups : [{ name: '', vars: tc.vars }]) {
      const hit = tc.steps.some((_s, i) => selected.has(offset + i + 1))
      offset += tc.steps.length
      if (hit) out.push({ ...tc, name: `${tc.name}${group.name ? ` [${group.name}]` : ''}`, vars: { ...tc.vars, ...group.vars }, groups: undefined })
    }
  }
  return out
}
