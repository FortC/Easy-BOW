/**
 * 需求 MD → 多用例 MD：全文分段转换，无浏览器依赖。
 * 双模式：prd=完整 PRD 提炼拆用例 / rough=粗略手写步骤补全断言与数据。
 * 每段产出经 suite parser 校验并可重试一次；缺少业务预期会保留待确认标记并阻止运行。
 */
import type { LlmProvider } from '../agent/llm'
import { parseTestSuite } from './suite'
import { compileRequirements, requirementChunks } from './requirements'

export type ConvertMode = 'prd' | 'rough'

const SPEC = `输出必须是如下规范的测试用例 Markdown（直接输出 MD 正文，禁止代码块围栏包裹整体，禁止解释性文字）：

# TESTCASE: <用例名>

## 测试数据
| 变量 | 值 |
|---|---|
| username | test01 |
| password | Test@1234 |

## 步骤

### 步骤 1: <短标题>
- 操作: <一句自然语言操作描述：在哪、对什么元素、做什么；智能填表写「智能填充当前页表单」>
- 预期: [文字] 页面出现「xxx」        ← 每个步骤至少一条预期（纯导航/准备步骤可省略）
- 预期: [URL] 包含 /xxx
- 预期: [选择器 .error-msg] 不存在
- 弹窗: 确认                          ← 仅步骤会触发 confirm/alert 时写（确认/取消）

## 清理                          ← 可选：测试数据还原（退出登录、删除测试记录等）
### 步骤 1: <标题>
- 操作: ...

硬性规则：
1. 预期行必须带类型标记：[文字]/[URL]/[标题]/[选择器 X]（存在/不存在/值=Y/文本=Y），禁止裸写自然语言预期
2. 测试数据表里的值在操作中用 {{变量名}} 引用（如「在用户名输入 {{username}}」），不要把具体值散落在步骤里
3. 每个步骤一个明确动作主题；步骤间有依赖时按执行顺序排列
4. URL 类操作用「访问 {{base_url}}/路径」（base_url 由运行环境注入）
5. 断言要可验证：写页面可见文案/URL 片段/稳定 CSS 选择器，禁止写「页面正常」「功能正确」这类不可验证预期。后端接口类预期用网络断言：[接口 /api/xxx] 状态 = 200 / [接口 /api/xxx] 响应包含 "success"（按 URL 片段匹配最近一次请求）
6. 文件上传：测试数据表里写本地绝对路径值（@D:\\path\\file.png 形式），操作写「上传 {{变量}}」
7. 需要同一脚本跑多组数据（如正确密码/错误密码）时：数据区用「### 组名」小节分多组，步骤只写一份，系统会逐组执行并合并报告；单组场景不要用组小节`

const PRD_ADDON = `你面对的是一份完整的产品需求文档（PRD）。任务：
1. 通读全文，提取「可测功能点」（有明确输入/操作/可见结果的功能）
2. 为本 PRD 生成多个独立 TESTCASE，主流程、异常和边界场景分别建用例，不能把互斥场景串成一条流程
3. 边界与异常：主流程用例的关键异常（必填校验、错误提示）以独立步骤体现，断言错误提示文案/错误元素
4. 测试数据按业务语义造合理值（手机号/邮箱/身份证等给格式合法的假值）
输出本段需求的所有可测用例，每个以 # TESTCASE: 开始。在标题下增加「- 需求: 原需求编号」和「- 验收点: AC-xxx, AC-yyy」，仅引用输入存在的编号。`

const ROUGH_ADDON = `你面对的是工程师手写的粗略测试步骤（可能口语化、缺断言、缺数据）。任务：
1. 严格保留用户的步骤语义与顺序，不擅自增加/删减/合并业务步骤
2. 补全每一步可验证的「预期」断言（带类型标记）：操作类步骤断言结果文案/URL；表单提交断言成功提示或错误提示不出现
3. 把步骤里出现的具体测试值提取到「测试数据」表，操作中改用 {{变量}} 引用
4. 必要时补「清理」步骤还原数据
用户的粗略步骤就是需求本身，不要按自己的想象重构流程。`

const FEWSHOT = `示例（输入：「打开后台，登录，新建一个客户叫测试客户A，检查列表里有」）：

# TESTCASE: 后台新建客户冒烟测试

## 测试数据
| 变量 | 值 |
|---|---|
| username | admin |
| password | Admin@123 |
| cust_name | 测试客户A_TS |

## 步骤

### 步骤 1: 打开后台登录页
- 操作: 访问 {{base_url}}/login

### 步骤 2: 登录
- 操作: 在用户名输入 {{username}}，在密码输入 {{password}}，点击「登录」
- 预期: [URL] 包含 /dashboard

### 步骤 3: 新建客户
- 操作: 点击「客户管理」，点击「新建客户」，智能填充当前页表单（客户名称固定 {{cust_name}}）
- 预期: [文字] 页面出现「新建成功」

### 步骤 4: 校验列表
- 操作: 返回客户列表，搜索 {{cust_name}}
- 预期: [文字] 页面出现 {{cust_name}}

## 清理
### 步骤 1: 删除测试客户
- 操作: 搜索 {{cust_name}}，删除该客户
- 预期: [文字] 页面出现「删除成功」`

export interface ConvertResult {
  ok: boolean
  md?: string
  error?: string
  steps?: number
  assertions?: number
  cases?: number
  uncovered?: string[]
  warnings?: string[]
  attempts?: number
}

/** 宽松提取模型输出里的用例 MD（容忍围栏包裹） */
function extractMd(text: string): string {
  let t = text.trim()
  const fence = t.match(/```(?:md|markdown)?\s*\n([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  // 围栏多重包裹时再剥一层
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  const h1 = t.indexOf('# TESTCASE')
  if (h1 > 0) t = t.slice(h1)
  return t.trim()
}

export async function convertRequirement(
  provider: LlmProvider,
  reqMd: string,
  mode: ConvertMode
): Promise<ConvertResult> {
  const input = (reqMd || '').trim()
  if (!input) return { ok: false, error: '需求内容为空' }
  // 明确拒绝超出资源上限，绝不以截断伪装成全文转换。
  if (input.length > 1000000) return { ok: false, error: '需求超过 100 万字符，请拆分文档后导入；未发送任何内容' }
  const compiled = compileRequirements(input)
  const chunks = requirementChunks(compiled.annotated)
  const system = `你是测试用例生成器。${mode === 'prd' ? PRD_ADDON : ROUGH_ADDON}\n\n${SPEC}\n\n${FEWSHOT}
补充约束：示例只说明格式，不是被测产品事实。不得沿用示例的账号密码、路由、成功文案或 CSS。
仅使用需求明确给出的页面、文案、路由和选择器；无法确定的预期写「- 预期: [待确认] 说明缺少什么」，留给用户补充，不能编造。
每个可执行业务步骤都应有预期；准备/导航/清理步骤可省略。每个用例必须独立准备数据和恢复数据。
需求有 AC 编号时必须在用例标题下用「- 验收点: AC-xxx」关联对应验收点。`
  const documents: string[] = []
  let attempts = 0
  for (const [index, chunk] of chunks.entries()) {
    let lastError = ''
    let accepted = false
    for (let attempt = 1; attempt <= 2; attempt++) {
      attempts++
      const user = `# 需求片段 ${index + 1}/${chunks.length}\n${chunk}\n${lastError ? `上次格式错误：${lastError}。请修正。` : ''}\n输出本片段测试用例 MD；缺少上下文请标待确认，不能自行假设：`
      const out = await provider.chat(system, [{ role: 'user', content: user }], undefined, { plain: true, maxTokens: 8192 })
      const md = extractMd(out.text)
      const parsed = parseTestSuite(md)
      if (parsed.ok && parsed.suite) { documents.push(md); accepted = true; break }
      lastError = parsed.error || '解析失败'
    }
    if (!accepted) return { ok: false, error: `需求片段 ${index + 1}/${chunks.length} 转换失败: ${lastError}；未交付不完整用例集`, attempts }
  }
  const manifest = compiled.acceptance.map((a) => a.id)
  const md = `# TESTSUITE: 需求验证\n${manifest.length ? `- 验收点: ${manifest.join(', ')}\n` : ''}\n${documents.join('\n\n')}`
  const suite = parseTestSuite(md).suite!
  const covered = new Set(suite.cases.flatMap((c) => c.acceptanceIds || []))
  return { ok: true, md, cases: suite.cases.length,
    steps: suite.cases.reduce((n, c) => n + c.steps.length, 0),
    assertions: suite.cases.reduce((n, c) => n + c.steps.reduce((a, step) => a + step.assertions.length, 0), 0),
    uncovered: manifest.filter((id) => !covered.has(id)), warnings: !manifest.length ? ['原需求没有 AC 编号或验收复选清单，无法计算完整验收覆盖率；建议补充验收点后重新生成。'] : [], attempts }
}
