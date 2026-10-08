/**
 * 需求 MD → 测试用例 MD 转换器（一次 LLM 调用，无浏览器依赖）。
 * 双模式：prd=完整 PRD 提炼拆用例 / rough=粗略手写步骤补全断言与数据。
 * 产出必须通过 parser 校验；失败自动带错误回喂重试一次（转换失败不外吐不可执行的 MD）。
 */
import type { LlmProvider } from '../agent/llm'
import { parseTestCase, summarize } from './parser'

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
5. 断言要可验证：写页面可见文案/URL 片段/稳定 CSS 选择器，禁止写「页面正常」「功能正确」这类不可验证预期`

const PRD_ADDON = `你面对的是一份完整的产品需求文档（PRD）。任务：
1. 通读全文，提取「可测功能点」（有明确输入/操作/可见结果的功能）
2. 为本 PRD 生成一个冒烟级测试用例集（先输出最核心主流程的用例，一个 TESTCASE 只覆盖一条主流程；PRD 里如有多个独立功能，选择最重要的 1 个主流程 + 若干关键异常场景合并进同一用例的步骤序列）
3. 边界与异常：主流程用例的关键异常（必填校验、错误提示）以独立步骤体现，断言错误提示文案/错误元素
4. 测试数据按业务语义造合理值（手机号/邮箱/身份证等给格式合法的假值）
只输出一个 TESTCASE（不要输出多个，用户可分次转换）。`

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
  const input = (reqMd || '').trim().slice(0, 30000)
  if (!input) return { ok: false, error: '需求内容为空' }
  const system = `你是测试用例生成器。${mode === 'prd' ? PRD_ADDON : ROUGH_ADDON}\n\n${SPEC}\n\n${FEWSHOT}`

  let lastError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user =
      attempt === 1
        ? `# 需求（${mode === 'prd' ? 'PRD 全文' : '粗略手写步骤'}）\n${input}\n\n输出测试用例 MD：`
        : `# 需求（${mode === 'prd' ? 'PRD 全文' : '粗略手写步骤'}）\n${input}\n\n你上一次的输出解析失败：${lastError}\n请严格按规范修正后重新输出完整用例 MD：`
    const out = await provider.chat(system, [{ role: 'user', content: user }])
    const md = extractMd(out.text)
    const parsed = parseTestCase(md)
    if (parsed.ok && parsed.tc) {
      const s = summarize(parsed.tc)
      return { ok: true, md, steps: s.steps, assertions: s.assertions, attempts: attempt }
    }
    lastError = parsed.error || '解析失败'
    if (attempt === 2) return { ok: false, md, error: `生成结果不符合用例规范: ${lastError}`, attempts: attempt }
  }
  return { ok: false, error: 'unreachable' }
}
