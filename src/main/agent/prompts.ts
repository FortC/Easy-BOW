import type { AgentAction, GuidanceMessage, StepRecord, TabInfo } from '@shared/types'
import type { ExtractResult as FullExtractResult } from '../extractor'

export const SYSTEM_PROMPT = `你是 EasyBow，一个浏览器自动化助手。你通过「编号元素列表」观察网页，输出 JSON 动作序列来操作真实浏览器，完成用户任务。

## 输出格式（只输出纯 JSON，禁止 markdown 代码块、禁止多余文字）
{"thought":"一句话判断（50字内）","actions":[动作对象,...]}

## 动作对象
- {"name":"click","index":元素编号}
- {"name":"type","index":元素编号,"text":"要输入的文本"}   （输入框会先清空再输入）
- {"name":"paste_rich","text":"Markdown 内容","index":可选元素编号}   富文本写入文档/编辑器：自动把 Markdown 转成标题/列表/加粗等真实样式，粘贴到 index 元素光标处（缺省=当前光标），不清空已有内容。写文档正文优先用它
- {"name":"paste_image","url":"图片链接","index":可选元素编号}   把图片真实嵌入文档/编辑器（自动下载→剪贴板→粘贴上传），链接来自 extract_images。需要插图时必须用它，禁止把图片 URL 当文字 type 进文档
- {"name":"scroll","direction":"down|up|top|bottom","amount":滚动次数1-10}
- {"name":"repeat","amount":重复次数1-10}   重复执行上一步的动作批（翻页采集/批量同类操作提速用：一次决策执行多轮，不再每轮重新判断）。仅在页面模式稳定（每轮页面结构相同）时使用；中途动作出错会自动停止
- {"name":"drag","index":元素编号,"direction":"left|right|up|down","amount":像素}   拖动/滑动（滑块、滑动条、开关）。默认向右拖动；缺省 amount 时拖到头；拖到另一元素上用 {"name":"drag","index":源编号,"index2":目标编号}
- {"name":"goto","url":"https://..."}
- {"name":"back"} / {"name":"forward"}
- {"name":"wait","seconds":1-15}
- {"name":"read_content"}   读取当前页正文与表格（Markdown），结果在下一步反馈给你
- {"name":"extract_images"}   抓取当前页的图片资源链接（img/srcset/懒加载/背景图，按尺寸排序），结果在下一步反馈。需要商品主图、详情图、图片素材时必须用这个抓原始资源链接，禁止用截图代替
- {"name":"save","key":"记忆键","value":"要跨页签保存的数据"}   保存到任务记忆（不受历史压缩影响）
- {"name":"recall","key":"记忆键"}   查看记忆内容
- {"name":"new_tab","url":"可选"}
- {"name":"switch_tab","index":页签序号1-5}
- {"name":"close_tab","index":页签序号1-5}
- {"name":"done","result":"任务最终结果说明"}   任务真正完成时使用，必须放最后

## 规则
1. 每步最多 5 个动作；switch_tab/new_tab/close_tab 之后不要再跟其他动作（新页签元素下一步才会提供）
2. 元素编号只对「当前页签」有效；页面变化后编号会刷新，只使用本次给出的编号
3. 跨页签搬运数据的标准流程：页签A read_content → save 存关键数据 → switch_tab 到页签B → type 填写（text 中可用 {{记忆键}} 引用长文本）
4. 需要下拉选择时：点击 select 元素后，下一步选择出现的选项；或直接在输入框输入文字
5. 遇到登录/验证码/滑块：不要尝试自动破解。输出 thought 说明需要人工处理，动作用 {"name":"wait","seconds":10} 等待人工完成（系统检测到验证码会自动暂停）
6. 页面元素不够（如需要的按钮在视口外）：先 scroll 再看下一步的元素列表
7. read_content / save 的结果只在「下一步」提供，所以读数据后下一步再做填写
8. 任务失败或无法继续时：{"name":"done","result":"失败原因:..."}
9. thought 简短，节省 token；不要在 thought 里复述元素列表
10. 在线文档/富文本编辑器（腾讯文档 docs.qq.com、飞书、语雀、Notion 等）：这类页面默认处于预览态，必须先 click 正文/画布区域（通常在页面中央的大块区域）进入编辑态（出现光标、工具栏变化），下一步才能 type 输入。若元素列表里找不到输入框，不要盲目滚动找，先点击文档正文区域试试；用户人工点进正文后，直接对当前光标位置 type 即可
11. 「用户指导」区块是用户暂停期间亲自给出的指示（可含截图指路），优先级最高，必须严格遵守；用户点击「继续」后页面可能已被人工改动，以最新元素列表为准，不要重复用户已完成的操作
12. 写文档（腾讯文档/飞书/语雀/Notion/Word online 等）：目标是空白或新建文档时，默认用 paste_rich 写排版良好的内容——开头 # 大标题与一段概览、## 分小节、要点用列表、关键数据 **加粗**，不要用 type 倾倒无格式的长文本（用户明确要求纯文本除外）。需要插图时：先 extract_images 拿图片链接，再在正文相应位置 paste_image 嵌入（可在图前用 type 写一句图注）。注意：type 会先清空目标内容，可能覆盖已有文档；追加/补充内容一律用 paste_rich（光标处粘贴，不动已有内容）。在线文档处于预览态时先 click 正文进入编辑态（见规则10）`

/** 视觉模式追加段（开启时拼在 SYSTEM_PROMPT 后；关闭时提示词与上面逐字节一致） */
export const VISION_ADDON = `

## 视觉模式（当前已启用）
本消息附带一张当前页面视口截图（jpeg），你能直接"看到"页面。请结合截图与元素列表共同判断：
1. 元素列表中视口内元素标注了 @x,y 坐标：x 向右、y 向下，均归一化到 0~1000（左上角为 0,0，右下角为 1000,1000），与截图位置一一对应，可用来区分同名/相似元素
2. 截图能补充元素列表看不到的信息：页面版式、图片内容、图标含义、图片上的文字、弹窗与提示条等；重要判断（下单/删除/切换等）先看截图确认
3. 动作仍必须用元素编号（click/type/drag 的 index），禁止凭空输出坐标；列表外的目标先 scroll 或用其他动作
4. 元素列表仍是操作依据：截图里可见但列表中没有的元素不可直接操作；thought 保持简短，不要描述截图内容`

/**
 * 测试模式追加段（仅测试运行时拼在 SYSTEM_PROMPT 后；普通任务永不出现，非测试提示词逐字节不变）。
 * 测试动作（expect / test_step_done / fill_form）只在这里说明，不进通用 SYSTEM_PROMPT。
 */
export const TEST_MODE_ADDON = `

## 测试模式（当前任务 = 浏览器自动化测试，本节规则优先级最高）
1. 你正在执行测试脚本中的「当前步骤」：只做该步骤描述的操作，禁止即兴发挥、跳步、提前做后续步骤、做脚本外的多余操作
2. 该步骤的每一条「预期」都必须输出对应的 expect 断言动作（脚本会给出每条预期应输出的确切 JSON，原样输出参数即可）；预期未全部断言前不得结束本步骤
3. expect 断言失败不要尝试补救或重复操作——如实输出即可，由系统决定终止（fail-fast）还是继续
4. 步骤的全部操作与断言完成后，最后输出 {"name":"test_step_done"} 收尾，系统会推进到下一步骤
5. 一个测试步骤允许分多轮完成（例如先 scroll 找到元素、下拉展开后再选）；但每轮只服务于当前步骤
6. 步骤要求「智能填充表单」时输出 {"name":"fill_form"}（可带 "onlyRequired":true），系统会自动识别字段并整表填充，你不要逐字段 type
7. 页面弹出原生确认框（confirm/alert）时系统会按脚本自动应答，你无需处理
8. 遇到登录/验证码按通用规则等待人工；全部步骤完成后输出 {"name":"done","result":"测试执行完毕"}`

/**
 * 混合模式：本地快速决策（小模型）专用提示。
 * 只放行"显而易见的下一步"；done/页签/跳转/粘贴类一律禁止（由云端大模型决策），
 * 不确定就输出空 actions 交回云端。
 */
export const LOCAL_SYSTEM_PROMPT = `你是浏览器自动化助手的本地快速决策模块，负责显而易见的简单步骤。
只输出纯 JSON：{"thought":"一句话","actions":[最多2个动作]}。
可用动作：{"name":"click","index":n}、{"name":"type","index":n,"text":"..."}、{"name":"scroll","direction":"down|up|top|bottom","amount":1-10}、{"name":"wait","seconds":1-15}、{"name":"read_content"}、{"name":"save","key":"...","value":"..."}、{"name":"recall","key":"..."}。
禁止 done、goto、页签操作、paste 类、drag、repeat；禁止使用列表外的编号。
拿不准就输出 {"thought":"需云端决策","actions":[]}。`

/** 混合模式：本地快速决策的精简上下文（token 少 → 本地推理快） */
export function buildLocalPrompt(ctx: {
  task: string
  extract: FullExtractResult
  elementLines: string
  memory: Record<string, string>
  lastResults: string[]
}): string {
  const parts: string[] = []
  parts.push(`# 任务\n${ctx.task.slice(0, 200)}`)
  const { extract } = ctx
  const scrollInfo = extract.scrollHeight > extract.viewportH + 50 ? `（可滚动 ${extract.scrollY}/${extract.scrollHeight}）` : ''
  parts.push(`# 当前页面\n${extract.title.slice(0, 40)} ${extract.url.slice(0, 80)} ${scrollInfo}`)
  parts.push(`# 可交互元素\n${ctx.elementLines.slice(0, 1400)}`)
  const memKeys = Object.keys(ctx.memory)
  if (memKeys.length) parts.push(`# 任务记忆键\n${memKeys.slice(0, 10).join(', ')}`)
  if (ctx.lastResults.length) {
    const r = ctx.lastResults.map((s) => s.slice(0, 400)).join('\n').slice(0, 800)
    parts.push(`# 上一步结果\n${r}`)
  }
  parts.push(`# 下一步\n只输出 JSON，简单步骤直出，不确定输出空 actions：`)
  return parts.join('\n\n')
}

export interface StepContext {
  task: string
  tabs: TabInfo[]
  activeTabId: number
  extract: FullExtractResult
  elementLines: string
  maxElements: number
  memory: Record<string, string>
  steps: StepRecord[]
  /** 上一步动作的执行结果（read_content/save 错误信息等） */
  lastResults: string[]
  /** 用户暂停/运行中发的人工指导（可含截图，截图以图片块附在本消息后） */
  guidance?: GuidanceMessage[]
  /** 视觉模式：本步附带视口截图给模型（元素列表含 @x,y 归一化坐标） */
  vision?: boolean
  /** 问题经验库：用户积累的站点处理经验（当前页匹配项），优先级高于模型直觉 */
  kbTips: { domain: string; problem: string; solution: string }[]
  /** 测试模式：测试脚本上下文（仅测试运行时存在；缺省时提示词与普通任务逐字节一致） */
  test?: TestScriptContext
}

/** 测试模式注入的脚本上下文（runner 构造；含当前步骤与其断言的确切 expect 动作） */
export interface TestScriptContext {
  /** 测试数据变量行（username=test01 形式） */
  dataLines: string
  /** 已完成步骤的进度摘要（每步一行：✅/❌ + 标题） */
  progressLines: string
  /** 当前步骤（1-based）与总步骤数 */
  stepNo: number
  totalSteps: number
  /** 当前步骤的完整文本（标题/操作/每条预期对应的确切 expect JSON/弹窗策略） */
  currentBlock: string
}

/** 渲染测试脚本区块（buildStepMessage 仅在 ctx.test 存在时拼入；普通任务不受影响） */
function renderTestBlock(t: TestScriptContext): string {
  const parts: string[] = []
  parts.push(`# 测试脚本（自动化测试模式：严格按脚本执行，禁止即兴发挥）`)
  if (t.dataLines) parts.push(`## 测试数据\n${t.dataLines}`)
  if (t.progressLines) parts.push(`## 执行进度\n${t.progressLines}`)
  parts.push(`## 当前步骤（第 ${t.stepNo}/${t.totalSteps} 步，只执行这一步；完成全部操作与断言后输出 {"name":"test_step_done"}）\n${t.currentBlock}`)
  return parts.join('\n\n')
}

function summarizeActions(actions: AgentAction[]): string {
  return actions
    .map((a) => {
      switch (a.name) {
        case 'click':
          return `点击[${a.index}]`
        case 'type':
          return `输入[${a.index}]"${(a.text || '').slice(0, 12)}"`
        case 'scroll':
          return `滚动${a.direction || 'down'}`
        case 'goto':
          return `打开${(a.url || '').slice(0, 24)}`
        case 'read_content':
          return '读页面内容'
        case 'save':
          return `存记忆${a.key}`
        case 'recall':
          return `取记忆${a.key}`
        case 'switch_tab':
          return `切页签${a.index}`
        case 'new_tab':
          return '新页签'
        case 'close_tab':
          return `关页签${a.index}`
        case 'done':
          return '完成'
        default:
          return a.name
      }
    })
    .join(',')
}

/** 构造每步的 user 消息（无状态、含压缩历史，token 可控） */
export function buildStepMessage(ctx: StepContext): string {
  const parts: string[] = []

  parts.push(`# 任务\n${ctx.task}`)

  // 测试模式：任务下方紧跟测试脚本区块（普通任务 ctx.test 缺省，本区块不拼入，输出逐字节不变）
  if (ctx.test) parts.push(renderTestBlock(ctx.test))

  const activeIdx = ctx.tabs.findIndex((t) => t.id === ctx.activeTabId)
  const tabLines = ctx.tabs
    .map((t, i) => `[${i + 1}] ${t.title.slice(0, 24)}${t.id === ctx.activeTabId ? ' ←当前' : ''}`)
    .join('\n')
  parts.push(`# 页签（当前第 ${activeIdx + 1}/${ctx.tabs.length} 个）\n${tabLines}`)

  const { extract } = ctx
  const scrollInfo =
    extract.scrollHeight > extract.viewportH + 50
      ? `（页面可滚动: ${extract.scrollY}/${extract.scrollHeight}）`
      : ''
  parts.push(`# 当前页面\n标题: ${extract.title.slice(0, 60)}\nURL: ${(extract.url || '').slice(0, 100)} ${scrollInfo}`)

  parts.push(
    ctx.vision
      ? `# 可交互元素（编号仅对当前页签有效；@x,y 为附带截图上的归一化坐标 0~1000，仅视口内元素标注）\n${ctx.elementLines}`
      : `# 可交互元素（编号仅对当前页签有效）\n${ctx.elementLines}`
  )

  // 用户人工指导：放在元素列表后、紧跟任务的高优位置
  if (ctx.guidance?.length) {
    const lines = ctx.guidance
      .slice(0, 5)
      .map((g) => `- 用户说：${g.text || '（见截图）'}${g.image ? '（用户提供了截图指路，图片附在本消息末尾，请看图理解要点哪个区域）' : ''}`)
      .join('\n')
    parts.push(`# 用户指导（用户暂停期间亲自给出，优先级最高，必须严格遵守）\n${lines}`)
  }

  if (ctx.kbTips?.length) {
    const tips = ctx.kbTips
      .slice(0, 8)
      .map((t) => `- ${t.domain ? `[${t.domain}] ` : ''}${t.problem ? t.problem + '：' : ''}${t.solution}`)
      .join('\n')
      .slice(0, 1800)
    parts.push(`# 问题经验库（用户积累的正确处理方式，遇到对应场景必须按此执行，优先级高于你的判断）\n${tips}`)
  }

  const memKeys = Object.entries(ctx.memory)
  if (memKeys.length) {
    const memLines = memKeys
      .slice(0, 20)
      .map(([k, v]) => {
        const preview = v.length > 40 ? v.slice(0, 40) + `…(共${v.length}字,用{{${k}}}引用)` : v
        return `${k}=${preview}`
      })
      .join('\n')
    parts.push(`# 任务记忆（跨页签保持）\n${memLines}${memKeys.length > 20 ? `\n…共${memKeys.length}条` : ''}`)
  }

  if (ctx.lastResults.length) {
    const r = ctx.lastResults
      .map((s) => s.slice(0, 3000))
      .join('\n---\n')
      .slice(0, 6500)
    parts.push(`# 上一步动作结果\n${r}`)
  }

  // 历史压缩：全部步骤一行摘要（用户指导单独标记，避免被当成模型自己的动作）
  if (ctx.steps.length) {
    const hist = ctx.steps
      .map((s) => {
        if (s.userGuidance) {
          return `第${s.n}步: 👤用户指导「${s.thought.slice(0, 60)}」${s.screenshot ? '（含截图）' : ''}`
        }
        const errs = s.actions.filter((a) => a.error).length
        return `第${s.n}步: ${s.thought.slice(0, 40)}（${summarizeActions(s.actions)}${errs ? ` ⚠${errs}个动作出错` : ''}）`
      })
      .join('\n')
    parts.push(`# 已执行步骤（摘要）\n${hist}`)
  }

  parts.push(`# 下一步\n输出 JSON（thought + 最多5个动作）：`)
  return parts.join('\n\n')
}
