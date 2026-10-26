import type { AgentAction, GuidanceMessage, PlanNode, StepRecord, TabInfo } from '@shared/types'
import type { ExtractResult as FullExtractResult } from '../extractor'
import { renderPlanBlock } from './plan'

export const SYSTEM_PROMPT = `你是 EasyBow，一个浏览器自动化助手。你通过「编号元素列表」观察网页，输出 JSON 动作序列来操作真实浏览器，完成用户任务。

## 输出格式（只输出纯 JSON，禁止 markdown 代码块、禁止多余文字）
{"thought":"一句话判断（50字内）","actions":[动作对象,...],"node_done":false,"node_evidence":"..."}

node_done=true 表示「当前节点的预期已达成」。声明它时**必须**同时给出 node_evidence（50字内，写你观察到的页面变化/已填入的值/已拿到的数据，如"列表出现了3条结果""收货人字段已填张三"）——没有证据的完成声明不会通过系统复核。

## 动作对象
- {"name":"click","index":元素编号,"expect_text":"目标预期文字"}   expect_text 强烈建议带：写目标按钮/链接文字；页面有同名按钮时必须再带行标识（如 "SO20261012-001 删除"），系统点击前会核验实际元素文案，不符一律拒绝点击
- {"name":"type","index":元素编号,"text":"要输入的文本"}   （输入框会先清空再输入）
- 元素编号后的 #xxxx 是**元素指纹**：4 位十六进制，跨步骤不变（页面重排后编号会变、指纹不变）。
  click/type/drag/hover 都可写 {"name":"click","fp":"a3f2"} 代替 index——上一步记住的元素这一步仍然指得到，
  同名密集控件页用 fp 能精确锁定「哪一行」，这是 index 做不到的。fp 不在当前页面时系统会明确报错，不会静默改点别的元素
- {"name":"paste_rich","text":"Markdown 内容","index":可选元素编号}   富文本写入文档/编辑器：自动把 Markdown 转成标题/列表/加粗等真实样式，粘贴到 index 元素光标处（缺省=当前光标），不清空已有内容。写文档正文优先用它
- {"name":"paste_image","url":"图片链接","index":可选元素编号}   把图片真实嵌入文档/编辑器（自动下载→剪贴板→粘贴上传），链接来自 extract_images。需要插图时必须用它，禁止把图片 URL 当文字 type 进文档
- {"name":"scroll","direction":"down|up|top|bottom","amount":滚动次数1-10}
- {"name":"repeat","amount":重复次数1-10}   重复执行上一步的动作批（翻页采集/批量同类操作提速用：一次决策执行多轮，不再每轮重新判断）。仅在页面模式稳定（每轮页面结构相同）时使用；中途动作出错会自动停止
- {"name":"drag","index":元素编号,"direction":"left|right|up|down","amount":像素}   拖动/滑动（滑块、滑动条、开关）。默认向右拖动；缺省 amount 时拖到头；拖到另一元素上用 {"name":"drag","index":源编号,"index2":目标编号}
- {"name":"goto","url":"https://..."}
- {"name":"back"} / {"name":"forward"}
- {"name":"wait","seconds":1-15}
- {"name":"observe","query":"订单号或目标字段关键字"}   按需查找局部元素（含行锚），返回新快照；下一轮用返回的编号操作。可给元素动作带 snapshotId，过期会拒绝。\n- {"name":"read_content"}   读取当前页正文与表格（Markdown），结果在下一步反馈给你
- {"name":"extract_images"}   抓取当前页的图片资源链接（仿图片助手插件：DOM+网络嗅探合并，覆盖 img/srcset/懒加载/背景图/XHR 动态加载的图，按真实尺寸排序），结果在下一步反馈。需要商品主图、详情图、图片素材时必须用这个抓原始资源链接，禁止用截图代替。哪张是主图、哪些是详情图/规格图由你按尺寸、alt、URL 特征判断对应关系（列表头有判读提示）
- {"name":"save","key":"记忆键","value":"要跨页签保存的数据"}   保存到任务记忆（不受历史压缩影响）
- {"name":"recall","key":"记忆键"}   查看记忆内容
- {"name":"new_tab","url":"可选"}
- {"name":"switch_tab","index":页签序号1-5}
- {"name":"close_tab","index":页签序号1-5}
- {"name":"clarify","query":"要问用户的问题"}   不确定时向用户提问：任务会暂停等待人工回复（每任务最多 3 次），问题里带上最像的候选编号与文字
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
12. 写文档（腾讯文档/飞书/语雀/Notion/Word online 等）：目标是空白或新建文档时，默认用 paste_rich 写排版良好的内容——开头 # 大标题与一段概览、## 分小节、要点用列表、关键数据 **加粗**，不要用 type 倾倒无格式的长文本（用户明确要求纯文本除外）。需要插图时：先 extract_images 拿图片链接，再在正文相应位置 paste_image 嵌入（可在图前用 type 写一句图注）。注意：type 会先清空目标内容，可能覆盖已有文档；追加/补充内容一律用 paste_rich（光标处粘贴，不动已有内容）。在线文档处于预览态时先 click 正文进入编辑态（见规则10）
13. 页面弹出的浏览器原生确认框（confirm/alert/prompt，不在元素列表里）由系统自动确认，其文案会出现在下一步的「上一步动作结果」中：据此判断刚才的操作是否达到预期，若该确认并非任务期望（如误触删除），如实说明并纠正；页面内的 DOM 弹窗/遮罩（自定义 Modal/对话框）是普通元素，其按钮就在元素列表里，直接按编号点击即可
14. 批量填表/写文档必须按 1、2、3…顺序逐段完成：一段写完、核对好，再写下一段，禁止回头在已写内容前面/中间补插文字；某个字段数据获取失败（如图片打不开、内容读不到）时，在该位置写「（xx获取失败）」占位后继续后续字段，全部完成后再统一重试失败项；禁止因单项失败反复回头改动，导致整体内容错乱
15. 不确定时不要硬选：列表里没有把握的目标时，输出 {"name":"clarify","query":"你指的是哪个字段？候选：[3]xx [7]xx [12]xx"}，禁止猜一个凑数（clarify 会暂停任务等人工回复）
16. 多候选优先：能缩小到 2-3 个但无法定夺时，输出 "candidates":[3,7,12]（与 click/type 同用、不填 index），系统会结合语义相似度自动裁决，比你硬选更准
17. 元素列表末尾的「语义匹配提示」段列出了与任务描述语义相关的元素（含同义词与相似度）：字段名与任务用词不一致时（如任务说"商品名称"而页面叫"品名"）优先从中选择；提示只是参考，仍要结合 role 与页面实际语义确认
18. 密集控件页（ERP/淘宝/小红书类：表格里几十个同名「编辑/删除/查看」按钮）：点错一行就是重大失误，宁可不点不可点错。click 必须带 expect_text 且内容包含该行的 (行:…) 标识；看不准是哪一行时用 {"name":"clarify","query":"哪一行？候选：[3](行:SO123 删除) [7](行:SO456 删除)"} 问用户，禁止猜`

/**
 * canvas 文档编辑器追加段：仅当提取检测到 canvasEditor（WPS/金山/腾讯文档等正文 canvas 渲染）时拼入。
 * 豁免视觉模式「禁止坐标点击」的禁令——正文不在元素列表，click_xy 是唯一能点到正文的通道；
 * 写入走 paste_rich/paste_image（光标处粘贴，无需 index）。
 */
export const CANVAS_EDITOR_ADDON = `

## Canvas 文档编辑器（本页正文由 canvas 渲染，优先级高于视觉模式通用规则）
元素列表里只有工具栏控件，文档正文和光标不在其中、也搜不到，但截图里能看见：
1. 移动光标/点击正文：用 {"name":"click_xy","x":横坐标,"y":纵坐标}（截图归一化 0~1000；本页豁免「禁止坐标点击」规则）
2. 写入正文：用 {"name":"paste_rich","text":"Markdown 内容"}（当前光标处粘贴富文本，无需 index）；嵌入图片用 {"name":"paste_image","url":"…"}（无需 index）
3. 禁止对正文使用 type（canvas 里没有输入元素，必然失败）、禁止点工具栏按钮"找正文"
4. 本页元素列表变化不能反映正文内容变化（canvas 不进 DOM）——写入是否生效请看截图确认，不要因"页面无变化"提示而重复写入`

/** 视觉模式追加段（开启时拼在 SYSTEM_PROMPT 后；关闭时提示词与上面逐字节一致） */
export const VISION_ADDON = `

## 视觉模式（当前已启用）
本消息附带一张当前页面视口截图（jpeg），你能直接"看到"页面。请结合截图与元素列表共同判断：
1. 元素列表中视口内元素标注了 @x,y 坐标：x 向右、y 向下，均归一化到 0~1000（左上角为 0,0，右下角为 1000,1000），与截图位置一一对应，可用来区分同名/相似元素。归一化含义：x、y 各自按截图宽/高独立换算（不是等比坐标）；坐标值必须在 0~1000 之间，禁止输出像素坐标（如 1600）——那会被当作错误坐标点错位置
2. 截图能补充元素列表看不到的信息：页面版式、图片内容、图标含义、图片上的文字、弹窗与提示条等；重要判断（下单/删除/切换等）先看截图确认。截图上的编号标注（边框+角标）与元素列表编号严格对应，选编号时以标注为准
3. 动作仍必须用元素编号（click/type/drag 的 index），禁止凭空输出坐标；列表外的目标先 scroll 或用其他动作
4. 元素列表仍是操作依据：截图里可见但列表中没有的元素不可直接操作；thought 保持简短，不要描述截图内容`

/**
 * 视觉兜底追加段：仅当「元素列表连续定位不到目标」时临时拼入（替代 VISION_ADDON）。
 * 与视觉模式的区别：额外放行按截图归一化坐标点击，解决列表里根本没有目标元素的情况。
 */
export const VISION_FALLBACK_ADDON = `

## 视觉兜底（元素列表定位不到目标，已临时开启截图）
本消息附带一张当前页面视口截图（jpeg），元素列表里找不到目标时改用「看图定位」：
1. 先在截图上确认目标所在位置，再输出动作；能确定元素编号时仍优先用 {"name":"click","index":n,"expect_text":"目标文字"}
2. 列表里没有的目标（canvas/自定义控件/图标按钮/被遮挡元素等）用坐标点击：
   {"name":"click_xy","x":横坐标,"y":纵坐标,"expect_text":"目标文字"}
   x/y 均为截图上的归一化值 0~1000（左上角 0,0，右下角 1000,1000）；x、y 各自按图宽/图高独立换算，必须在 0~1000 之间，禁止输出像素坐标
   例：截图中间偏右的按钮 → {"name":"click_xy","x":720,"y":480,"expect_text":"提交"}
   expect_text 写目标控件的文字（密集页同名控件必须带行标识）：系统点击前会核验，不符拒绝点击
3. 目标不在当前视口时先 scroll，再在下一步的截图上定位点击
4. 坐标点击后必须看下一步的结果确认是否点中；没点中则按新截图修正坐标重试
5. thought 简短，不要描述截图内容`

/**
 * 任务描述增强器（✨ AI 增强按钮）：把用户的粗糙描述增强为清晰、具体的任务指令。
 * 只做「格式 + 内容」增强，不启动任务；输出纯文本任务描述。
 */
export const ENHANCE_SYSTEM_PROMPT = `你是浏览器自动化任务的「任务描述增强器」。用户给你一段粗糙的任务描述，你把它增强为清晰、具体、可直接交给浏览器自动化 AI 执行的任务指令。
要求：
1. 保留用户原意与全部关键信息（网址、账号、字段名、数值、数量、时间等），禁止虚构用户没提到的具体数据
2. 结构化表达：多步骤用 1. 2. 3. 编号；数据字段用列表；关键要求（如"不要提交""等我确认""只要前3条"）显式写出
3. 补全执行必需的细节：明确在哪个页签/页面操作、读取哪些字段、数据存任务记忆还是直接填写、完成后用 done 说明什么结果
4. 可合理补充通用约束：遇登录/验证码等待人工处理、失败如实报告、填写后核对
5. 只输出增强后的任务描述纯文本；禁止解释、禁止 markdown 代码块、禁止"增强后："之类前后缀
6. 长度控制在原文 1~3 倍，禁止注水`

/**
 * 测试模式追加段（仅测试运行时拼在 SYSTEM_PROMPT 后；普通任务永不出现，非测试提示词逐字节不变）。
 * 测试动作（expect / test_step_done / fill_form）只在这里说明，不进通用 SYSTEM_PROMPT。
 */
export const TEST_MODE_ADDON = `

## 测试模式（当前任务 = 浏览器自动化测试，本节规则优先级最高）
1. 你正在执行测试脚本中的「当前步骤」：只做该步骤描述的操作，禁止即兴发挥、跳步、提前做后续步骤、做脚本外的多余操作
2. 预期由测试引擎按原脚本独立执行；禁止输出 expect，禁止修改预期或自行宣布通过。
3. 即使预期可能失败，也只如实完成脚本操作；不要为了让断言通过而补救、重复提交或改写数据。
4. 当前步骤操作完成后输出 {"name":"test_step_done"}；不要继续执行后续步骤，系统检查断言并推进。
5. 一个测试步骤允许分多轮完成（例如先 scroll 找到元素、下拉展开后再选）；但每轮只服务于当前步骤
6. 步骤要求「智能填充表单」时输出 {"name":"fill_form"}（可带 "onlyRequired":true），系统会自动识别字段并整表填充，你不要逐字段 type
7. 页面弹出原生确认框（confirm/alert）时系统会按脚本自动应答，你无需处理
8. 遇到登录/验证码按通用规则等待人工；全部步骤完成后输出 {"name":"done","result":"测试执行完毕"}
9. 文件上传（input[type=file]）：{"name":"upload","index":文件选择框编号,"path":"{{变量名}}"}（变量值=本地文件绝对路径，来自测试数据）；禁止用 type 往文件框输文字
10. hover 展开的菜单（导航下拉等）：{"name":"hover","index":菜单触发元素编号} 悬停展开后，下一步再点击出现的选项`

/**
 * 混合模式：本地快速决策（小模型）专用提示。
 * 只放行"显而易见的下一步"；done/页签/跳转/粘贴类一律禁止（由云端大模型决策），
 * 不确定就输出空 actions 交回云端。
 */
export const LOCAL_SYSTEM_PROMPT = `你是浏览器自动化助手的本地快速决策模块，负责显而易见的简单步骤。
只输出纯 JSON：{"thought":"一句话","actions":[最多2个动作]}。
可用动作：{"name":"click","index":n}、{"name":"type","index":n,"text":"..."}、{"name":"scroll","direction":"down|up|top|bottom","amount":1-10}、{"name":"wait","seconds":1-15}、{"name":"read_content"}、{"name":"save","key":"...","value":"..."}、{"name":"recall","key":"..."}。
禁止 done、goto、页签操作、paste 类、drag、repeat；禁止使用列表外的编号。
上一步动作失败时：从当前元素列表重新挑最匹配的编号重试同一目标；仍无把握就输出空 actions 交回云端。
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

/**
 * v4.6 C1：模式说明后缀。vision/canvas/test 四段附加描述原先拼进 system——任一开关变化
 * 都会击穿 Anthropic cache_control 断点与 OpenAI 自动前缀缓存的公共前缀（整任务缓存全冷）。
 * 现在统一作为独立段落拼在 user 消息末尾（动态后缀区、# 下一步之前），system 恒等于
 * SYSTEM_PROMPT（跨任务/跨模式逐字节稳定）。文本正文与原附加段逐字一致，仅落点变化；
 * stableSystemPrompt=false 时 runner 仍走旧的 system 拼接路径（回滚开关）。
 */
export function buildModeSuffix(ctx: {
  vision?: 'on' | 'fallback'
  canvas?: boolean
  test?: boolean
}): string {
  let s = ''
  if (ctx.vision === 'on') s += VISION_ADDON
  else if (ctx.vision === 'fallback') s += VISION_FALLBACK_ADDON
  if (ctx.canvas) s += CANVAS_EDITOR_ADDON
  if (ctx.test) s += TEST_MODE_ADDON
  // 各常量自带前导 \n\n（历史拼接格式）；作为独立段落拼入时去掉首尾空白，段落间距由 join 补
  return s.trim()
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
  /** S5 自动经验库：AI 此前任务自动沉淀的经验行（当前页+任务匹配项），优先级高于模型直觉 */
  expTips?: string[]
  /** 节点链计划（普通任务复核模式；缺省时提示词与无计划模式逐字节一致） */
  plan?: { nodes: PlanNode[]; current: number }
  /** 测试模式：测试脚本上下文（仅测试运行时存在；缺省时提示词与普通任务逐字节一致） */
  test?: TestScriptContext
  /** T8 反思：失败尝试清单（W7；注入动态后缀区，守 prompt cache 布局；缺省不拼入） */
  tried?: string[]
  /** T7 动作后核验反馈（W10；注入动态后缀区；缺省不拼入） */
  deltaHint?: string
  /** v4.6 C1 模式说明后缀（vision/canvas/test 附加段，buildModeSuffix 产物；拼在动态后缀区尾部、# 下一步之前） */
  modeSuffix?: string
  /** v4.6 C2a 历史折叠：true 且步数 >12 时把早期步骤折叠为聚合行（缺省 false=全量逐行，v4.5 行为） */
  historyFold?: boolean
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

/** 单步历史行（C2a 从 buildStepMessage 内联逻辑抽出，折叠与全量共用同一渲染） */
function renderOneHistoryLine(s: StepRecord): string {
  if (s.userGuidance) {
    return `第${s.n}步: 👤用户指导「${s.thought.slice(0, 60)}」${s.screenshot ? '（含截图）' : ''}`
  }
  const errs = s.actions.filter((a) => a.error).length
  return `第${s.n}步: ${s.thought.slice(0, 40)}（${summarizeActions(s.actions)}${errs ? ` ⚠${errs}个动作出错` : ''}）`
}

/**
 * v4.6 C2a 历史折叠（纯函数，selftest 直测）：
 * - fold=false 或步数 ≤12：全量逐行（v4.5 行为，追加式对前缀缓存最友好）；
 * - fold=true 且 >12 步：早期步骤折叠为 1 行聚合；用户指导行是最高优先指令**永不折叠**；
 *   早期出错行保留最近 2 条供反思；最近 6 步始终逐行。
 */
export function renderHistoryLines(steps: StepRecord[], fold: boolean): string[] {
  if (!fold || steps.length <= 12) return steps.map(renderOneHistoryLine)
  const KEEP = 6
  const head = steps.slice(0, steps.length - KEEP)
  const tail = steps.slice(-KEEP)
  const headErrs = head.filter((s) => s.actions.some((a) => a.error))
  const agg = `第1~${head.length}步: 已执行 ${head.length} 步${headErrs.length ? `（⚠${headErrs.length} 步有动作出错）` : ''}`
  const kept: string[] = [agg]
  for (const s of head) if (s.userGuidance) kept.push(renderOneHistoryLine(s))
  for (const s of headErrs.slice(-2)) kept.push(renderOneHistoryLine(s))
  return [...kept, ...tail.map(renderOneHistoryLine)]
}

/**
 * 构造每步的 user 消息（无状态、含压缩历史，token 可控）。
 * 段落顺序=「稳定前缀在前（任务/记忆/经验库/历史），易变内容在后（页签/页面/元素/上一步）」：
 * 让 OpenAI/DeepSeek 自动前缀缓存与 Anthropic 缓存尽量命中，多步任务输入 token 显著变便宜、首字更快。
 */
export function buildStepMessage(ctx: StepContext): string {
  const parts: string[] = []

  parts.push(`# 任务\n${ctx.task}`)

  // 测试模式：任务下方紧跟测试脚本区块（普通任务 ctx.test 缺省，本区块不拼入，输出逐字节不变）
  if (ctx.test) parts.push(renderTestBlock(ctx.test))

  // —— 稳定区（跨步基本不变，前缀缓存命中区） ——

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

  if (ctx.kbTips?.length) {
    const tips = ctx.kbTips
      .slice(0, 8)
      .map((t) => `- ${t.domain ? `[${t.domain}] ` : ''}${t.problem ? t.problem + '：' : ''}${t.solution}`)
      .join('\n')
      .slice(0, 1800)
    parts.push(`# 问题经验库（用户积累的正确处理方式，遇到对应场景必须按此执行，优先级高于你的判断）\n${tips}`)
  }

  // S5 自动经验库：AI 自己踩坑沉淀的经验（同站点/同字段意图命中时注入）
  if (ctx.expTips?.length) {
    parts.push(`# 历史经验（此前任务自动积累，优先级高于你的判断）\n${ctx.expTips.slice(0, 6).join('\n').slice(0, 1200)}`)
  }

  // 历史压缩：全部步骤一行摘要（只追加不改写，前缀缓存友好；用户指导单独标记，避免被当成模型自己的动作）
  // v4.6 C2a：fold=true 且步数 >12 时折叠早期步骤（追加式历史在前缀缓存命中时近乎免费，
  // 折叠只服务无缓存端点与超长任务——短任务保持逐字节不变）
  if (ctx.steps.length) {
    const hist = renderHistoryLines(ctx.steps, ctx.historyFold === true).join('\n')
    parts.push(`# 已执行步骤（摘要）\n${hist}`)
  }

  // —— 易变区（每步都不同，放在后面以保护前缀缓存） ——

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
  if (extract.snapshotId) parts.push(`当前快照: ${extract.snapshotId}。仅使用本次快照编号；历史 observe 结果中的编号不再有效。`)

  parts.push(
    ctx.vision
      ? `# 可交互元素（编号仅对当前页签有效；@x,y 为附带截图上的归一化坐标 0~1000，仅视口内元素标注）\n${ctx.elementLines}`
      : `# 可交互元素（编号仅对当前页签有效）\n${ctx.elementLines}`
  )

  if (ctx.lastResults.length) {
    const r = ctx.lastResults
      .map((s) => s.slice(0, 3000))
      .join('\n---\n')
      .slice(0, 6500)
    parts.push(`# 上一步动作结果\n${r}`)
  }

  // —— 以下为 v3 动态后缀区（反思/核验/重规划注入；全部只放这里，缓存断点之后） ——

  // T7 动作后核验（W10）：delta 反馈文案
  if (ctx.deltaHint) parts.push(`# 操作核验\n${ctx.deltaHint.slice(0, 600)}`)

  // T8 反思（W7）：失败尝试清单 + 禁止重复同一失败方式（执行前拦截的依据）
  if (ctx.tried?.length) {
    parts.push(
      `# 失败尝试清单（以下是已失败的做法；同一目标同一方式已失败 2 次的，禁止再重复，必须换一种没试过的方式）\n${ctx.tried
        .slice(0, 10)
        .join('\n')
        .slice(0, 1200)}`
    )
  }

  // 用户人工指导：放在消息末尾的高优位置（模型对末尾内容注意力最强）
  if (ctx.guidance?.length) {
    const lines = ctx.guidance
      .slice(0, 5)
      .map((g) => `- 用户说：${g.text || '（见截图）'}${g.image ? '（用户提供了截图指路，图片附在本消息末尾，请看图理解要点哪个区域）' : ''}`)
      .join('\n')
    parts.push(`# 用户指导（用户暂停期间亲自给出，优先级最高，必须严格遵守）\n${lines}`)
  }

  // 节点链进度（复核模式；仅普通任务且计划生成成功时拼入）
  if (ctx.plan?.nodes?.length) parts.push(renderPlanBlock(ctx.plan.nodes, ctx.plan.current))

  // v4.6 C1：模式说明区块（vision/canvas/test）拼在动态后缀区尾部——system 恒等于 SYSTEM_PROMPT，
  // 缓存断点不被开关变化击穿；放末尾不截断「system+任务+记忆+历史」的公共前缀
  if (ctx.modeSuffix) parts.push(ctx.modeSuffix)

  parts.push(
    ctx.plan?.nodes?.length
      ? `# 下一步\n输出 JSON（thought + 最多5个动作；当前节点预期达成时加 "node_done":true 与 "node_evidence":"观察到的页面变化"）：`
      : `# 下一步\n输出 JSON（thought + 最多5个动作）：`
  )
  return parts.join('\n\n')
}
