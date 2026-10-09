# EasyBow 代码复核报告

- **日期**：2026-10-09
- **范围**：`E:/clb-pjs/Easy-BOW`（Electron AI 浏览器，62 源文件 / 约 17.7k 行）
- **视角**：第一性原则（界定系统不可妥协的正确性行为）+ e2e 自测基线（质量标尺）
- **方法**：5 路并行子系统精读（e2e 基线 / 浏览器内核 / Agent 循环+LLM / 本地推理+OCR / 渲染进程+IPC 安全），关键高严重度结论由主线程二次核验源码确认。

---

## 0. 第一性原则：这个系统"必须保证什么"

EasyBow 的本质目标是：**让 AI 大模型安全、可控、可验证地驱动真实 Chromium 完成跨页签任务**。由此推导出 6 条不可妥协的正确性契约，它们也是本次复核的判定基准：

| # | 契约 | 失败后果 |
|---|---|---|
| C1 | **元素编号契约**："编号→真实元素"在单批动作内恒定一致 | AI 点错 / 填错字段 |
| C2 | **trusted 事件**：动作走浏览器级真实输入，不被 CSP/反爬拦截、React 受控组件可感知 | 操作无效或站点识别为机器人 |
| C3 | **决策闭环终止性**：不无限循环、token 可控、失败可归因自愈、人工可接管、停止信号可靠 | 失控烧 token / 卡死 |
| C4 | **本地推理零崩溃**：严格门控 + 失败安全回退云端，绝不在任意 Windows 机器段错误/挂死 | 招牌特性变砖 |
| C5 | **安全边界**：渲染进程不可信、所有 IPC 入参主进程校验、凭据非明文落盘 | RCE / 凭据泄露 |
| C6 | **可验证**：e2e 自测做真断言、有 CI 门禁、与文档一致 | 回归静默漏过 |

---

## 1. 项目结构与契约映射（第一性视角）

```
主进程 main/
  cdp.ts         CDP 会话封装（trusted 输入管线，C2 支撑）✅
  extractor.ts   元素提取 + 同源 iframe 穿透 + 视口排序 + 验证码检测
  executor.ts    动作执行（真实事件 / 拟人化 / {{记忆}} 替换）← C1 关键
  agent/         runner(决策循环) / llm(双协议) / prompts / verify(复核) / plan
  fastllm.*      本地快速决策模型（Qwen2.5-0.5B WASM）← C4 关键
  ocr/           PP-OCRv4 离线识别（WASM）← C4 关键
  testcase/      浏览器仿真测试子系统（与 selftest 互为动静两层）
  index.ts       全部 IPC 注册（C5 关键边界）
preload/         contextBridge 白名单（C5 已做对 ✅）
renderer/        React UI（页签/时间线/设置/测试面板）
shared/types.ts  主/渲染共享类型（IPC 契约定义）
resources/       OCR 模型+runtime / 快速决策模型 / overlay / testpage fixture
scripts/         sync-ocr / fetch-fastmodel / patch-transformers / patch-electronget / run-app
```

**结构评价**：分层清晰，主进程持页签状态、UI 崩溃由心跳看门狗重建（设计正确）。但 **C1（编号契约）在执行侧出现漂移**、**C4（本地推理门控/超时）与文档和代码不一致**、**C5（IPC/持久化）存在纵深缺口**——这三类是本报告的硬性发现。

---

## 2. 复核发现总览（按严重度）

> 严重度：P0=正确性硬伤（会直接导致 AI 做错事）｜P1=高（可靠性/安全/一致性风险）｜P2=中｜P3=低/优化

### P0 — 正确性硬伤（必须修）

**P0-1 元素编号漂移：重提取后"点击元素"与"路径定位元素"分裂**
- 位置：`src/main/executor.ts:399-416`（`resolveIndex`）+ `:574-575`（`type` 的 `focusTarget` 与 `pathsFor`）
- 现象：`resolveIndex` 在 DOM 变动导致旧 `path` 解析失败时，重提取并按 `tag+text` 找首个匹配（或回退 `fresh.candidates[index]`）。但随后 `type` 动作里 `focusTarget` 点的是重定位元素 `c2`，而 `pathsFor(t, a.index)` 却从**已被替换的快照**按**原始 `a.index`** 取 `framePaths/path`。二者指向不同元素时：真实键入进对了框，但 `SET_VALUE_FN` 兜底与回读作用在错元素 → **误报失败或对错误字段赋值**。重复文案（"确定/下一页"、列表同名项）与空文本控件（`?? fresh.candidates[index]`）会放大该错位。
- 第一性后果：直接违反 C1，是"填错字段"的根因路径。
- 建议：`resolveIndex` 返回**已解析候选的完整 `{framePaths,path,tag}`**，并让 `focusTarget`/`pathsFor`/`click` 的 submitish 判定**全部消费同一解析结果**，彻底消除分裂；重定位增加"坐标+位置"仲裁而非仅 `tag+text`。

**P0-2 OCR 全页识别行合并索引错位**
- 位置：`resources/ocr/worker.js:271-279`（`recognizeFullPage` 的行合并循环）
- 现象：`lines` 仅在 `t` 非空时 `push`（`:266` `if(t) lines.push(t)`），但合并循环用 `Math.min(boxes.length, lines.length)` 取 `k`，并以 `boxes[k]` 取 y、`lines[k]` 取文本。任一框识别为空后，`lines` 索引被压实，后续 `lines[k]` 与 `boxes[k]` 不再对齐 → 整页 OCR 文本顺序/行分组错乱。
- 第一性后果：OCR 是招牌离线特性（C4），输出错乱会污染图片型页面的字段读取。
- 建议：用 `{box, text}` 成对结构承载，`lines` 与 `boxes` 始终等长（空识别存 `''`），合并循环只遍历 `boxes.length`。

### P1 — 高严重度

**P1-1 e2e 基线"跨页签任务"零覆盖（产品立身之本未验证）**
- 位置：`src/main/selftest.ts`（全流程仅 `:1123`/`:1637` 两处 `newTab`，无"A 取数→切 B 填入"端到端校验）
- 第一性后果：违反 C6。核心卖点（跨页签数据搬运）在自测中不可见，回归静默漏过风险最高。

**P1-2 安全关键遮罩检查可整体静默跳过**
- 位置：`selftest.ts:129-217`，整段 `if (ex.overlay) {…}` 含 5 项（轨迹/光晕/顶栏/拆除）。`overlay` 为 null 时这些项**既不 PASS 也不 FAIL，完全不计入**。任务结束遮罩未彻底拆除会导致 Chromium 输入路由仍派发给隐藏视图（页面点不动）——这是 C2/C6 硬底线，却可在无提示下被跳过。

**P1-3 OCR 禁用时无条件 PASS（打印即过）**
- 位置：`selftest.ts:1115` `check('OCR整页识别', true, …)` 在 OCR 未启用时恒 PASS。应改为 skipped 不计通过。

**P1-4 本地决策超时与文档/门控不符，且慢推理结果仍被采纳**
- 位置：`src/main/fastllm.ts:210` 超时 `300000ms`（5 分钟），但 README 宣称"超过 10s 自动放弃"；且 `runner.ts:1610` 在 `genMs>10000` 仅置 `localDisabled`（禁用**后续**步），**当前已完成慢结果在 `:1606` 已赋值并仍被采纳**。慢机上单步可软阻塞最多 5 分钟，与"秒出"招牌相悖（C4）。

**P1-5 `ort-fast` 依赖未发布 dev 构件**
- 位置：`package.json:28` `ort-fast: npm:onnxruntime-web@^1.31.0-dev.20260914-8d85527a0`。该 dev 构件若从 npm 删除或 `^` 预发布解析失败，`npm install`/`dist` 直接失败，破坏"下载即跑"（C4）。

**P1-6 构建期补丁对依赖源码强假设、失败即 exit(1)**
- 位置：`scripts/patch-transformers.mjs:17-25`、`scripts/patch-electronget.mjs:17-18`。`@huggingface/transformers`(`^4.3.1`)/`electron-builder`(`^26.15.3`) 任一次要版本改动锚点即 `process.exit(1)`，且 `patch-electronget` 用 `readFileSync` 无 try → `postinstall` 失败 → 整条 `npm install` 失败（C4）。

**P1-7 Agent 循环陈旧 abort signal（恢复后浪费/误 abort 一轮）**
- 位置：`runner.ts:1398` 每轮捕获 `const signal = this.abortCtrl!.signal`；而 `checkpoint`(`:317-321`) 恢复时 `new AbortController()`。中途重建后，局部 `signal` 仍指向旧（已 abort）信号 → 模型调用立即中止 → 走 abort 分支 `continue` 浪费一轮（下一轮自愈）。调用点应统一 `this.abortCtrl!.signal`（C3）。

**P1-8 settings:set 不校验入参**
- 位置：`src/main/index.ts:377` `saveSettings(s)` 直接 `{...getSettings(), ...patch}` 写入。渲染进程可注入任意字段（`homepage:'file:///…'`、`maxSteps:NaN`）。主进程必须把每个 IPC 入参当不可信（C5）。

**P1-9 API Key 明文落盘**
- 位置：`src/main/settings.ts` + `shared/types.ts:21`。`apiKey` 以明文存 `%APPDATA%/easybow/settings.json`，同机其他进程可读。应改用 `safeStorage.encryptString/decryptString`（DPAPI/Keychain）（C5）。

**P1-10 多处置非原子写盘**
- 位置：`settings.ts:29`、`scheduler.ts:74-79`、`templates.ts`、`knowledge.ts`、`experience.ts`、`testcase/store.ts`、`history.ts` 全部 `writeFileSync` 直写。崩溃/断电可写半成品，下次 `JSON.parse` 失败回退默认 → **静默丢失用户全部设置**（C5）。应统一 `写 .tmp → rename` 原子替换。

**P1-11 定时回归绕过"生产保护"门禁**
- 位置：`scheduler.ts` 定时触发走 `runner.startTestRun(entry.md, {failFast:true, caseId})` **未传 env** → `env.protected` 恒 `undefined`，即便用例指向生产 URL，到点也无人确认自动执行提交/删除（C5/C6）。生产保护应在执行层对 URL 强制，不因触发来源失效。

**P1-12 复核"假通过" + 经验负反馈不可达**
- 位置：`verify.ts:112/114/120` 在 L2 解析不出/报错/均不可判时一律 `passed:true/skip`；`experience.ts:199-201` 的 `score--`/`≤-2 停用` 分支因 `feedbackExperience` 仅以 `ok=true` 调用而**不可达**——错误/陈旧经验只增不减，污染下次同站点决策（C3）。

### P2 — 中严重度（节选，完整 150+ 条见各子系统 agent 报告）

- `cdp.ts:110-119` 20s 超时仅 reject Promise，未取消底层 `debugger.sendCommand`；大页 `evaluate/screenshot` 20s 偏短会制造虚假超时。
- `imgdec.ts:24-55` 每图 `new BrowserWindow()` 解码，**无超时** → 防盗链挂起时 `paste_image`/`type` 动作无限挂起，卡死 Agent 循环。
- `extractor.ts:289` iframe 穿透深度 `depth<2`，支付/滑块/广告第 3 层 iframe 内元素永不入列表。
- `ocr/index.ts:65-79` + `worker.js:298-330` OCR worker 单 handler 顺序处理，**无并发互斥**，并发 `ocrPageText`/`ocrEnhanceExtract` 可能结果错乱。
- `ocr/index.ts:104-152` OCR init 失败缓存为 `disabled` promise，**无重试入口**，后台话期间永久禁用。
- `selftest.ts` 重度 `sleep` 耦合 + 单点采样（`:205` 遮罩拆除只测 3.3s 单点，未证明"之后不复发"）；UI 像素级断言对 DPI/125% 缩放敏感（`:533-540` `bottomDiff<1.5`）。
- `selftest.ts` 项数与文档漂移：README 称 **59 项**，实际约 **90+ 处 `check()`**（含 catch 兜底/同名重复），且 `:1217-1226` 把"URL 尾随空格"错误固化为 baseline。
- `tabs.ts:316` 地址栏允许 `file:` 协议（站点页签不可信，多余攻击面；与弹窗 `setWindowOpenHandler` 仅限 https 不一致）；`newTab`/主页 `loadURL` 未统一下沉 scheme 校验。
- `experience.save()` 每次 `upsert/feedback` 同步全文件 `writeFileSync` 无节流，长任务多次阻塞主进程。

### P3 — 低/优化（节选）
- 死代码/误用：`executor.ts:1169-1184` `clarify/test_step_done` no-op；`fastllm-test.ts:54-70` 多余 `sharp`/`tokenizers` 探针；`TestPanel.tsx:189-206` `setInterval` 却 `clearTimeout` 清理；`overlay.ts:207-210`/`index.ts:590-599` 调试残留 `debugClickPause`/`debugExtract` 常驻 IPC。
- `history.ts:59` 重复访问计数 bug（`top===existing` 恒真）；`telemetry.end` 可能多次结算；`index.ts:46` 模块顶层在 `app ready` 前调用 `getSettings()`。
- `ELECTRON_DISABLE_SECURITY_WARNINGS='true'`（`index.ts:41`）建议仅 dev 生效。

---

## 3. e2e 基线专项（质量标尺）

**覆盖率矩阵（约数，主路径去重）：**

| 能力 | 覆盖 | 备注 |
|---|---|---|
| CDP 附加/元素提取 | ✅ ~5 项 | |
| iframe 穿透/操作 | ✅ ~3 项 | |
| 输入/点击/记忆替换/异常上报/拖动 | ✅ ~6 项 | |
| 表格→Markdown 读取 | ✅ 1 项 | |
| 验证码/摩擦检测 | ✅ 1 项 | 漏报风险高 |
| 遮罩/轨迹/输入路由（安全关键） | ⚠️ 5 项 | **可静默跳过（P1-2）** |
| 视觉构造/多模态/坐标/AX | ✅ ~5 项 | |
| 文档粘贴（MD/rich/image） | ✅ 4 项 | |
| 混合模式/本地决策/repeat | ✅ 2 项 | |
| 定时任务 | ✅ ~3 项 | **绕过生产保护(P1-11)** |
| 语义/诊断/经验/埋点/UA | ✅ ~10 项 | |
| OCR | ⚠️ 1 项 | **禁用即假 PASS(P1-3)** |
| 仿真测试子系统（parser/convert/report/store/fields） | ✅ ~30 项 | 仅静态层 |
| **跨页签任务（A取数→切B填入）** | ❌ **0** | **最大缺口(P1-1)** |

**结论**：绝大多数 `check()` 确为布尔断言（非假阳性），但有两类更危险的"静默"——① overlay 为 null 时 5 项安全检查不计入（P1-2）；② OCR 禁用恒 PASS（P1-3）。另有：无 `.github` CI workflow、`package.json` 无 `test` 脚本，junit.xml 生成却无门禁管线（C6 缺口）；`edit.ts`/`assertions.ts` 在 selftest 中无直接单测。

---

## 4. 修复优先级路线图

| 序 | 动作 | 对应 | 预估影响 |
|---|---|---|---|
| 1 | `resolveIndex` 返回完整解析候选、统一消费 | P0-1 | 消除"填错字段"根因 |
| 2 | OCR 行合并改为 `{box,text}` 等长对齐 | P0-2 | 修复离线识别错乱 |
| 3 | 把跨页签搬运补进 selftest（A→B 端到端） | P1-1 | 补齐核心卖点回归 |
| 4 | 遮罩 5 项改为"无 overlay 即 FAIL 或显式 skip 不计通过" | P1-2 | 关闭静默跳过 |
| 5 | 钉死 `ort-fast` 到已发布稳定版或 vendor 本地副本；构建补丁改为"缺失即 warn" | P1-5/P1-6 | 守住"下载即跑" |
| 6 | fastllm 单步超时降到 ~10–12s 且超时即**丢弃**本步回退云端 | P1-4 | 对齐招牌"秒出" |
| 7 | 关键 IPC（settings:set / schedules:save / cases:save）加字段白名单+类型/范围校验；scheme 校验下沉 `loadURL` | P1-8/P2 | 堵 IPC 纵深缺口 |
| 8 | 设置/调度/模板/经验等全改 `.tmp→rename` 原子写；`apiKey` 改 `safeStorage` | P1-9/P1-10 | 防损坏+防泄露 |
| 9 | 定时回归补 `env.protected` 门禁；verify 复核失败不应无条件 skip | P1-11/P1-12 | 关生产误执行/假通过 |
| 10 | runner 模型调用统一 `this.abortCtrl!.signal`；补 OCR worker 并发互斥 + init 重试；imgdec/cdp 加超时 | P1-7/P2 | 可靠性 |

---

## 5. 总体结论

**结构层面**：分层清晰、主进程持状态 + 心跳看门狗重建 UI 的设计正确，preload 白名单与 contextIsolation 搭得对（C5 基础良好），Agent 闭环的终止性由 `maxSteps+done+stop+nodeFails` 四重保障基本可靠（C3）。

**但存在三类硬性缺陷**：
1. **C1 契约在执行侧漂移**（P0-1）——这是最该优先修的正确性硬伤，直接导致"填错字段"。
2. **C4 本地推理与文档/代码自相矛盾**（P0-2/P1-4/P1-5/P1-6）——OCR 输出错乱 + 门控/超时/依赖三处脆弱，招牌特性在边缘场景会变砖或静默失效。
3. **C6 可验证性不足**（P1-1/P1-2/P1-3 + 无 CI）——核心卖点跨页签任务零回归、安全关键检查可静默跳过、文档项数漂移。

**IS_PASS 一致性检查**
- ✅ 第一性原则契约已显式界定（C1–C6）
- ✅ e2e 基线作为质量标尺已完成覆盖度矩阵
- ✅ 所有 P0/P1 结论均带 `file:line` 且关键项经二次源码核验
- ⚠️ 以下项**未通过**，须在合并前修复：**P0-1、P0-2、P1-1、P1-2、P1-3、P1-8、P1-9、P1-10、P1-11**
- 📋 建议补充：`.github` CI 门禁 + `npm test` 脚本，使 selftest/junit 真正门禁回归

**复核结论：IS_PASS = 否（存在 P0 级正确性硬伤，须修复后复核通过）。**
