/**
 * 自测模式（--selftest）：不依赖 LLM，用本地 fixture 页面验证
 * CDP 附加 / 元素提取 / 点击 / 输入 / 同源 iframe 穿透 / 内容读取 / 验证码检测。
 * 运行：npm run selftest
 */
import { join } from 'path'
import { app } from 'electron'
import { appendFileSync } from 'fs'

/** 进度直写文件（同步无缓冲）：stdout 在 Windows 重定向下块缓冲，会掩盖真实卡点 */
const TRACE_FILE = join(process.cwd(), 'selftest-trace.log')
function trace(...args: any[]): void {
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString().slice(11, 23)} ${args.map((a) => String(a)).join(' ')}\n`)
  } catch {}
}

interface SelftestDeps {
  createWindow: () => void
  getTabManager: () => import('./tabs').TabManager
  getExecutor: () => import('./executor').Executor
  getUiWebContents?: () => Electron.WebContents | undefined
  getWin?: () => Electron.BrowserWindow | null
  exit: (code: number) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runSelftest(deps: SelftestDeps): Promise<void> {
  const results: { name: string; ok: boolean; detail?: string }[] = []
  const check = (name: string, ok: boolean, detail?: string) => {
    results.push({ name, ok, detail })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
    trace(`[check] ${ok ? 'PASS' : 'FAIL'} ${name}`)
  }

  try {
    deps.createWindow()
    const tm = deps.getTabManager()
    const ex = deps.getExecutor()
    // 等窗口与首个页签就绪
    await sleep(1500)

    const fixturePath = app.isPackaged
      ? join(process.resourcesPath, 'testpage.html')
      : join(__dirname, '../../resources/testpage.html')
    const fixture = 'file:///' + fixturePath.replace(/\\/g, '/')
    await tm.navigate(fixture)
    await sleep(1800)

    // 1. 元素提取
    const res = await ex.extract()
    const roles = res.candidates.map((c) => c.role + '|' + c.text)
    check(
      '元素提取-输入框',
      res.candidates.some((c) => c.text.includes('搜索词') || c.extra.includes('搜索')),
      `候选 ${res.candidates.length} 个`
    )
    check('元素提取-提交按钮', res.candidates.some((c) => c.text === '提交'))
    check('元素提取-链接', res.candidates.some((c) => c.role === 'link' && c.text.includes('点我试试')))

    // 2. iframe 穿透
    const hasIframeBtn = res.candidates.some((c) => c.text === 'iframe 按钮')
    const hasIframeInput = res.candidates.some((c) => c.extra.includes('iframe 内输入框'))
    check('同源iframe穿透-按钮', hasIframeBtn, hasIframeBtn ? 'iframe 元素已入列' : '未发现 iframe 按钮')
    check('同源iframe穿透-输入框', hasIframeInput)

    // 3. 输入
    const kwIdx = res.candidates.findIndex((c) => c.tag === 'INPUT' && (c.extra.includes('搜索') || c.extra.includes('kw')))
    const submitIdx = res.candidates.findIndex((c) => c.text === '提交')
    if (kwIdx >= 0 && submitIdx >= 0) {
      const batchDone = ex.executeBatch(
        [
          { name: 'type', index: kwIdx, text: '订单A1024' },
          { name: 'click', index: submitIdx }
        ],
        { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
      )
      // 批后 250ms 截图：波纹与拖尾仍在淡出期内，验证轨迹可视化效果
      if (!app.isPackaged) {
        try {
          await batchDone
          await sleep(250)
          // capturePage 拍不到原生 WebContentsView 合成，用 desktopCapturer 屏幕截图
          const { desktopCapturer } = await import('electron')
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            thumbnailSize: { width: 1480, height: 940 }
          })
          if (sources[0]) {
            const { writeFileSync } = await import('fs')
            writeFileSync(join(process.cwd(), 'overlay-demo.png'), sources[0].thumbnail.toPNG())
          }
        } catch (e: any) {
          console.log('[selftest] 轨迹截图失败:', e?.message)
        }
      } else {
        await batchDone
      }
      // 轨迹动画状态验证（必须在 overlay 700ms 自动隐藏前）：光标已移动、拖尾与波纹都产生过
      let overlayState: { moves?: number; clicks?: number } | null = null
      if (ex.overlay) {
        await sleep(300)
        overlayState = (await ex.overlay.debugState()) as { moves?: number; clicks?: number } | null
      }
      await sleep(600)
      const out = await tm.active()!.cdp.evaluate<string>(
        String(() => (document.getElementById('form-result') as HTMLElement).textContent),
        []
      )
      check('输入+点击提交', out === '已提交: 订单A1024', `表单结果: ${out}`)
      if (ex.overlay) {
        check(
          '鼠标轨迹动画',
          !!overlayState && (overlayState.moves ?? 0) > 0 && (overlayState.clicks ?? 0) > 0,
          overlayState
            ? `累计光标移动${overlayState.moves}次、点击波纹${overlayState.clicks}次（点击前后轨迹已渲染）`
            : '无法读取 overlay 状态'
        )
        // 工作光晕状态切换（含环境水波）
        ex.overlay.setWorking(true)
        await sleep(2500)
        const w1 = (await ex.overlay.debugState()) as
          | { working?: boolean; ambientCount?: number; barVisible?: boolean; hasPauseBtn?: boolean; bridgeOk?: boolean }
          | null
        check(
          '工作光晕(淡蓝遮罩+边缘呼吸+水波纹)',
          !!w1 && w1.working === true && (w1.ambientCount ?? 0) > 0,
          `working→${w1?.working} 环境水波${w1?.ambientCount ?? 0}圈`
        )
        // 顶部「AI 操作中」状态条 + 暂停按钮 + preload→IPC 链路
        if (w1) {
          let pauseIpcFired = false
          const { ipcMain } = await import('electron')
          const probe = () => {
            pauseIpcFired = true
          }
          ipcMain.on('overlay:pause', probe)
          await ex.overlay.debugClickPause()
          await sleep(250)
          ipcMain.removeListener('overlay:pause', probe)
          check(
            'AI操作顶栏(状态条+暂停按钮+IPC链路)',
            !!w1.barVisible && !!w1.hasPauseBtn && !!w1.bridgeOk && pauseIpcFired,
            `状态条=${w1.barVisible} 暂停按钮=${w1.hasPauseBtn} IPC桥=${w1.bridgeOk} 点击→主进程=${pauseIpcFired}`
          )
        }
        // 工作遮罩整体效果截图（淡蓝遮罩+水波纹+顶部状态条，供人工核对）
        if (!app.isPackaged) {
          try {
            ex.overlay.setStatusText('第 2 步：模型思考中…')
            await sleep(1500) // 等水波纹荡开、状态条滑入
            const { desktopCapturer } = await import('electron')
            const sources = await desktopCapturer.getSources({
              types: ['screen'],
              thumbnailSize: { width: 1480, height: 940 }
            })
            if (sources[0]) {
              const { writeFileSync } = await import('fs')
              writeFileSync(join(process.cwd(), 'overlay-working.png'), sources[0].thumbnail.toPNG())
            }
          } catch (e: any) {
            console.log('[selftest] 工作遮罩截图失败:', e?.message)
          }
        }
        ex.overlay.setWorking(false)
        await sleep(250)
        const w2 = await ex.overlay.debugState()
        check(
          '工作光晕关闭',
          !!w2 && w2.working === false && w2.barVisible === false,
          `working→${w2?.working} 状态条→${w2?.barVisible}`
        )
        // 终结态立即彻底拆除：setWorking(false) 同步完成，不再依赖兜底计时。
        // 关键断言是"视图已从窗口视图栈卸载"——只切可见性的透明视图残留在栈里时，
        // Chromium 输入路由仍可能把鼠标事件派发给它（任务结束后页面点不动、切页签也被拦）
        const m1 = ex.overlay.debugMainState()
        await sleep(3300) // 复核：无任何计时器/事件会把它重新挂回或重新可见
        const m2 = ex.overlay.debugMainState()
        check(
          '任务结束立即拆除遮罩(视图已卸载)',
          m1.shown === false &&
            m1.visible === false &&
            m1.isChild === false &&
            m2.shown === false &&
            m2.visible === false &&
            m2.isChild === false,
          `停止后 shown=${m1.shown} 可见=${m1.visible} 在视图栈=${m1.isChild}；3.3s复核 在视图栈=${m2.isChild}`
        )
      }
    } else {
      check('输入+点击提交', false, `kwIdx=${kwIdx} submitIdx=${submitIdx}`)
    }

    // 4. iframe 内操作
    const iframeBtnIdx = res.candidates.findIndex((c) => c.text === 'iframe 按钮')
    const iframeInputIdx = res.candidates.findIndex((c) => c.extra.includes('iframe 内输入框'))
    if (iframeBtnIdx >= 0 && iframeInputIdx >= 0) {
      await ex.executeBatch(
        [
          { name: 'type', index: iframeInputIdx, text: '跨frame输入' },
          { name: 'click', index: iframeBtnIdx }
        ],
        { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
      )
      await sleep(600)
      const iframeOut = await tm.active()!.cdp.evaluate<string>(
        String(() => {
          const f = document.getElementById('inner') as HTMLIFrameElement
          try {
            const d = f.contentDocument
            const out = d ? (d.getElementById('inner-out') as HTMLElement).textContent : '(无法访问)'
            const val = d ? (d.getElementById('inner-input') as HTMLInputElement).value : ''
            return out + ' || input=' + val
          } catch {
            return '(跨域异常)'
          }
        }),
        []
      )
      check('iframe内输入+点击', iframeOut.includes('iframe按钮已点击') && iframeOut.includes('input=跨frame输入'), iframeOut)
    } else {
      check('iframe内输入+点击', false, `btn=${iframeBtnIdx} input=${iframeInputIdx}`)
    }

    // 5. 内容读取（表格 → Markdown）
    const content = await tm.active()!.cdp.evaluate<{ text: string; bodyLen: number }>(
      String((max: number) => {
        const t = (document.body!.innerText || '').trim()
        return { text: t.slice(0, max), bodyLen: t.length }
      }),
      [3000]
    )
    check('内容读取-含表格数据', content.text.includes('A1024') && content.text.includes('张三'), `正文 ${content.bodyLen} 字`)

    // 6. 验证码检测（隐藏的预置容器不误判；显示后才命中）
    {
      const { DETECT_FRICTION_FN } = await import('./extractor')
      const fr0 = await tm.active()!.cdp.evaluate<{ hitSel: string[]; textHit: boolean }>(DETECT_FRICTION_FN, [])
      const noFalsePositive = fr0.hitSel.length === 0 && !fr0.textHit
      await tm.active()!.cdp.evaluate(String(() => (window as any).__showCaptcha()), [])
      await sleep(200)
      const fr = await tm.active()!.cdp.evaluate<{ hitSel: string[]; textHit: boolean }>(DETECT_FRICTION_FN, [])
      check(
        '验证码检测(可见性过滤)',
        noFalsePositive && (fr.hitSel.length > 0 || fr.textHit),
        `隐藏时误判=${!noFalsePositive} / 显示后命中=${fr.hitSel.length > 0 || fr.textHit} ${JSON.stringify(fr.hitSel)}`
      )
    }

    // 7. 任务记忆替换 {{key}}
    const mem = { 订单号: 'A1024' }
    const kwIdx2 = (await ex.extract()).candidates.findIndex((c) => c.tag === 'INPUT' && c.extra.includes('搜索'))
    await ex.executeBatch(
      [{ name: 'type', index: kwIdx2, text: '记忆{{订单号}}测试' }],
      { memory: mem, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
    )
    const v = await tm.active()!.cdp.evaluate<string>(String(() => (window as any).__getInputValue()), [])
    check('记忆{{key}}替换', v === '记忆A1024测试', `实际: ${v}`)

    // 7.6 输入异常如实报告（框架控制字段：input 事件强制清空，两条路径都写不进，必须报"未生效"供模型自纠错）
    try {
      const roExtract = await ex.extract()
      const roIdx = roExtract.candidates.findIndex((c) => (c.extra || '').includes('框架强制清空') || (c.extra || '').includes('框架控制'))
      if (roIdx < 0) {
        check('输入异常如实报告', false, '未找到框架控制字段元素')
      } else {
        const roOut = await ex.executeBatch(
          [{ name: 'type', index: roIdx, text: '这文字明显超过三个字' }],
          { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
        )
        check(
          '输入异常如实报告',
          !!roOut[0].error && /未生效|不完整/.test(roOut[0].error),
          `result: ${roOut[0].result}`
        )
      }
    } catch (e: any) {
      check('输入异常如实报告', false, String(e?.message || e))
    }

    // 7.5 拖动动作（自绘滑块拖到右侧 + 拖动全程可视化）
    try {
      const dragExtract = await ex.extract()
      const handleIdx = dragExtract.candidates.findIndex((c) => (c.text || '').includes('拖我') || (c.extra || '').includes('滑块手柄'))
      if (handleIdx < 0) {
        check('拖动动作(滑块)', false, '未在元素列表中找到滑块手柄')
      } else {
        const movesBefore = ex.overlay ? (((await ex.overlay.debugState()) as { moves?: number } | null)?.moves ?? 0) : 0
        const dragOut = await ex.executeBatch(
          [{ name: 'drag', index: handleIdx, direction: 'right', amount: 320 }],
          { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
        )
        const pct = await tm.active()!.cdp.evaluate<number>(
          String(() => parseInt(document.getElementById('slider-val')!.textContent || '0', 10)),
          []
        )
        const movesAfter = ex.overlay ? (((await ex.overlay.debugState()) as { moves?: number } | null)?.moves ?? 0) : 0
        check(
          '拖动动作(滑块)',
          !dragOut[0].error && pct > 70,
          `拖动后进度 ${pct}%${dragOut[0].error ? '，错误: ' + dragOut[0].error : ''}`
        )
        if (ex.overlay) {
          check(
            '拖动过程可视化(拖尾跟随)',
            movesAfter - movesBefore >= 6,
            `拖动期间光标步进 ${movesAfter - movesBefore} 次（≥6 为全程跟随）`
          )
        }
      }
    } catch (e: any) {
      check('拖动动作(滑块)', false, String(e?.message || e))
    }

    // 7.7 图片资源抓取（主图/详情图抓链接，非截图；小图标过滤；按尺寸排序）
    try {
      const imgOut = await ex.executeBatch(
        [{ name: 'extract_images' }],
        { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
      )
      const r = imgOut[0].result || ''
      check(
        '图片资源抓取(主图/详情图)',
        !imgOut[0].error && r.includes('商品主图') && r.includes('详情图') && !r.includes('alt=icon'),
        `抓到 ${Math.max(0, (r.match(/\[\d+\]/g) || []).length)} 张：${r.split('\n')[0].slice(0, 50)}`
      )
    } catch (e: any) {
      check('图片资源抓取(主图/详情图)', false, String(e?.message || e))
    }

    // 7.8 SPA 重挂载后的元素重定位：旧序号路径指向错误节点（标签不符）时，
    // 必须重提取并按 标签+文本 重定位到正确元素（防"点错元素还报成功"）
    try {
      const dynIdx = res.candidates.findIndex((c) => c.text === '动态按钮A')
      const remountIdx = res.candidates.findIndex((c) => c.text === '触发重挂载')
      if (dynIdx < 0 || remountIdx < 0) throw new Error(`元素列表缺少动态区（dyn=${dynIdx} remount=${remountIdx}）`)
      // 1) 点"触发重挂载"：dyn-wrap 内部被替换，旧快照里动态按钮的序号路径从此指向 <i>占位</i>
      await ex.executeBatch(
        [{ name: 'click', index: remountIdx }],
        { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
      )
      const remounted = await tm.active()!.cdp.evaluate<string>(
        String(() => document.getElementById('dyn-flag')!.textContent),
        []
      )
      // 2) 仍按旧快照序号点"动态按钮A"：路径失效 → 标签校验拦下 → 重提取+文本重定位 → 点中真按钮
      const clickOut = await ex.executeBatch(
        [{ name: 'click', index: dynIdx }],
        { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
      )
      await sleep(300)
      const flag = await tm.active()!.cdp.evaluate<string>(
        String(() => document.getElementById('dyn-flag')!.textContent),
        []
      )
      check(
        'SPA重挂载重定位(标签校验+文本重定位)',
        remounted === 'remounted' && flag === 'dyn-clicked' && !clickOut[0].error,
        `重挂载=${remounted} 旧序号点击后=${flag}（应点到真按钮而非占位元素）`
      )
    } catch (e: any) {
      check('SPA重挂载重定位(标签校验+文本重定位)', false, String(e?.message || e))
    }

    // 8.5 UI 挂载检查（React 界面是否渲染）
    try {
      await sleep(1500)
      const ui = deps.getUiWebContents?.()
      if (!ui) throw new Error('UI webContents 不可用')
      const uiOk = await ui.executeJavaScript('!!document.getElementById("root") && document.getElementById("root").children.length > 0 && document.querySelector(".tabbar") !== null', true)
      check('UI渲染', uiOk === true, uiOk ? 'React 界面已挂载（页签栏存在）' : 'root 为空')
    } catch (e: any) {
      check('UI渲染', false, String(e?.message || e))
    }

    // 8.6 设置弹窗：点击 ⚙ → 浏览器视图隐藏 → 关闭弹窗 → 恢复
    try {
      const ui = deps.getUiWebContents?.()
      if (!ui) throw new Error('UI webContents 不可用')
      const clickGear = await ui.executeJavaScript(
        `(() => { const btns = Array.from(document.querySelectorAll('button')); const g = btns.find(b => (b.title === '设置' || b.textContent.includes('⚙'))); if (!g) return '未找到设置按钮'; g.click(); return 'ok' })()`,
        true
      )
      if (clickGear !== 'ok') throw new Error(clickGear)
      await sleep(800)
      const hidden1 = tm.isBrowserHidden()
      const modalVisible = await ui.executeJavaScript(
        `!!document.querySelector('.modal') && !!document.querySelector('.modal input')`,
        true
      )
      const closed = await ui.executeJavaScript(
        `(() => { const x = document.querySelector('.modal .close-x'); if (!x) return '未找到关闭按钮'; x.click(); return 'ok' })()`,
        true
      )
      await sleep(600)
      const hidden2 = tm.isBrowserHidden()
      check(
        '设置弹窗(浏览器视图隐藏/恢复)',
        hidden1 === true && modalVisible === true && closed === 'ok' && hidden2 === false,
        `点击⚙后隐藏=${hidden1} 弹窗可见=${modalVisible} 关闭=${closed} 关闭后隐藏=${hidden2}`
      )
    } catch (e: any) {
      check('设置弹窗(浏览器视图隐藏/恢复)', false, String(e?.message || e))
    }

    // 8.7 问题经验库：域名匹配 + 提示词注入 + UI 弹窗 IPC 链路
    try {
      const { matchKB } = await import('./knowledge')
      const hit = matchKB('https://docs.qq.com/document/abc')
      const miss = matchKB('https://www.baidu.com/')
      const { buildStepMessage } = await import('./agent/prompts')
      const msg = buildStepMessage({
        task: '测试',
        tabs: [],
        activeTabId: 1,
        extract: { candidates: [], title: 't', url: 'u', scrollHeight: 0, viewportH: 0, scrollY: 0 } as any,
        elementLines: '',
        maxElements: 80,
        memory: {},
        steps: [],
        lastResults: [],
        kbTips: hit.map((e) => ({ domain: e.domain, problem: e.problem, solution: e.solution }))
      })
      const promptOk = msg.includes('问题经验库') && hit.length > 0 && msg.includes(hit[0].solution.slice(0, 12))
      check(
        '问题经验库(域名匹配+提示词注入)',
        hit.length > 0 && miss.length === 0 && promptOk,
        `docs.qq.com 命中${hit.length}条 / baidu 命中${miss.length}条 / 注入=${promptOk}`
      )
      // UI：打开经验库弹窗验证 IPC 读写与预置条目
      const ui = deps.getUiWebContents?.()
      if (ui) {
        await ui.executeJavaScript(`document.querySelector('.kb-entry-btn').click()`, true)
        await sleep(700)
        const kbUi = await ui.executeJavaScript(
          `!!document.querySelector('.kb-modal') && !!document.querySelector('.kb-item') && document.body.innerText.includes('docs.qq.com')`,
          true
        )
        await ui.executeJavaScript(`document.querySelector('.kb-modal .close-x').click()`, true)
        await sleep(400)
        check('问题经验库(界面+IPC)', kbUi === true, kbUi ? '弹窗/列表/预置条目正常' : String(kbUi))
      }
    } catch (e: any) {
      check('问题经验库(域名匹配+提示词注入)', false, String(e?.message || e))
    }

    // 8.8 视觉模式：多模态消息构造 / 拒图降级判定 / 元素坐标标注 / iframe 绝对坐标（均无网络请求）
    try {
      const { toOpenAiContent, toAnthropicContent, isVisionUnsupportedError, TINY_TEST_IMAGE } = await import('./agent/llm')
      const parts = [
        { type: 'text', text: '看图' },
        { type: 'image', dataUrl: TINY_TEST_IMAGE }
      ] as any[]
      const oa = toOpenAiContent(parts) as any[]
      const oaOk =
        Array.isArray(oa) && oa[0].type === 'text' && oa[1].type === 'image_url' && oa[1].image_url.url === TINY_TEST_IMAGE
      const an = toAnthropicContent(parts) as any[]
      const anOk =
        an[1].type === 'image' && an[1].source.type === 'base64' && an[1].source.media_type === 'image/png' && an[1].source.data.length > 50
      check('视觉模式(多模态消息构造)', oaOk && anOk, `OpenAI=${oaOk} / Anthropic=${anOk}`)

      const degradeOk =
        isVisionUnsupportedError({ status: 400, message: 'image content is not supported' }) === true &&
        isVisionUnsupportedError({ status: 0, message: '当前模型不支持图片输入' }) === true &&
        isVisionUnsupportedError({ status: 401, message: 'invalid api key' }) === false
      check('视觉模式(拒图降级判定)', degradeOk)

      const { formatCandidates } = await import('./extractor')
      const fakeRes: any = {
        title: 't',
        url: 'u',
        scrollY: 0,
        scrollHeight: 2000,
        viewportW: 1000,
        viewportH: 800,
        candidates: [
          { framePaths: [], path: [], tag: 'BUTTON', role: 'button', text: '在视口', extra: '', rect: { x: 100, y: 100, w: 50, h: 50 }, inViewport: true },
          { framePaths: [], path: [], tag: 'BUTTON', role: 'button', text: '在视口外', extra: '', rect: { x: 100, y: 1600, w: 50, h: 50 }, inViewport: false }
        ],
        totalFound: 2,
        imgCount: 0
      }
      const lines = formatCandidates(fakeRes, true).split('\n')
      const coordOk = /@125,156\b/.test(lines[0]) && !lines[1].includes('@') && lines[1].includes('需滚动到')
      check('视觉模式(元素坐标标注)', coordOk, `首行: ${lines[0]}`)

      // 提取结果应含视口宽度；iframe 内元素 rect 应为顶层绝对坐标（与截图对齐）
      const resV = await ex.extract()
      const geo = await tm.active()!.cdp.evaluate<{ itop: number; btop: number }>(
        String(() => {
          const f = document.getElementById('inner') as HTMLIFrameElement
          const fr = f.getBoundingClientRect()
          const d = f.contentDocument!
          const btn = Array.from(d.querySelectorAll('button')).find((b) => (b.textContent || '').includes('iframe 按钮'))!
          return { itop: fr.top, btop: btn.getBoundingClientRect().top }
        }),
        []
      )
      const ifBtn = resV.candidates.find((c) => c.text === 'iframe 按钮')
      const expectY = Math.round(geo.itop + geo.btop)
      const absOk = !!ifBtn && Math.abs(ifBtn.rect.y - expectY) <= 2
      check(
        '视觉模式(iframe绝对坐标+视口宽)',
        absOk && resV.viewportW > 0,
        `iframe按钮 y=${ifBtn?.rect.y} 期望=${expectY} viewportW=${resV.viewportW}`
      )
    } catch (e: any) {
      check('视觉模式(多模态消息构造)', false, String(e?.message || e))
    }

    // 8.9 文档写入三件套：Markdown 转换 / paste_rich 富文本粘贴 / paste_image 真实嵌图 / 剪贴板读图 IPC（附截图修复）
    try {
      const { mdToHtml } = await import('./markdown')
      const html = mdToHtml(
        '# 标题\n\n段落 **关键** 与 `code`\n\n- 要点一\n- 要点二\n\n1. 第一\n2. 第二\n\n> 引用一句\n\n---\n\n| 列A | 列B |\n| --- | --- |\n| 1 | 2 |'
      )
      const mdOk =
        html.includes('<h1>') &&
        html.includes('<strong>关键</strong>') &&
        html.includes('<li>要点一</li>') &&
        html.includes('<table>') &&
        html.includes('<blockquote>')
      check('文档写入(Markdown转换)', mdOk, `输出 ${html.length} 字符`)

      const richRes = await ex.extract()
      trace('[8.9] extract 完成，候选', richRes.candidates.length)
      const richIdx = richRes.candidates.findIndex((c) => (c.text || '').includes('点此编辑'))
      trace('[8.9] richIdx =', richIdx)
      if (richIdx < 0) {
        check('文档写入(paste_rich 富文本)', false, '未找到富文本测试区元素')
        check('文档写入(paste_image 嵌图)', false, '未找到富文本测试区元素')
      } else {
        trace('[8.9] paste_rich 开始（不设竞速超时，批次自然完成）')
        await ex.executeBatch(
          [{ name: 'paste_rich', index: richIdx, text: '# 自测标题\n\n- 甲\n- 乙\n\n**重点**数据' }],
          { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
        )
        trace('[8.9] paste_rich 结束，读取编辑区')
        await sleep(400)
        const richHtml = await tm.active()!.cdp.evaluate<string>(
          String(() => document.getElementById('rich-area')!.innerHTML),
          []
        )
        trace('[8.9] richHtml 取回', richHtml.length, '字符:', richHtml.slice(0, 60))
        check('文档写入(paste_rich 富文本)', /<h1/i.test(richHtml) && /<li/i.test(richHtml), `HTML: ${richHtml.slice(0, 70)}`)

        const { TINY_TEST_IMAGE } = await import('./agent/llm')
        trace('[8.9] paste_image 开始')
        const imgOut = await ex.executeBatch(
          [{ name: 'paste_image', index: richIdx, url: TINY_TEST_IMAGE }],
          { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
        )
        trace('[8.9] paste_image 结束', imgOut[0].error || imgOut[0].result || '')
        await sleep(400)
        const richHtml2 = await tm.active()!.cdp.evaluate<string>(
          String(() => document.getElementById('rich-area')!.innerHTML),
          []
        )
        check(
          '文档写入(paste_image 嵌图)',
          !imgOut[0].error && /<img/i.test(richHtml2),
          imgOut[0].error || '编辑区内已出现真实 <img> 标签'
        )
      }

      // 附截图修复验证：主进程写图进剪贴板 → UI 经 preload IPC 读回 dataURL（会临时占用系统剪贴板）
      {
        const { clipboard, nativeImage, ClipboardItem } = await import('electron')
        const png = await tm.active()!.cdp.screenshotPng()
        if (png) {
          await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
          const ui = deps.getUiWebContents?.()
          const dataUrl = ui ? await ui.executeJavaScript('window.easybow.readClipboardImage()', true) : null
          check(
            '附截图(剪贴板读图IPC)',
            typeof dataUrl === 'string' && dataUrl.startsWith('data:image/'),
            dataUrl ? `读回 ${dataUrl.slice(0, 24)}…（${Math.round(dataUrl.length / 1024)}KB）` : 'UI 不可用或读取为空'
          )
        } else {
          check('附截图(剪贴板读图IPC)', false, '截图失败')
        }
      }
    } catch (e: any) {
      check('文档写入(Markdown转换)', false, String(e?.message || e))
    }

    // 8.95 混合模式：本地决策校验器（纯函数）+ repeat 重放动作（确定性加速）
    try {
      const { validateLocalActions } = await import('./fastllm')
      const v1 = validateLocalActions({ thought: 't', actions: [{ name: 'click', index: 2 }] }, 10)
      const v2 = validateLocalActions({ thought: 't', actions: [{ name: 'done', result: '完成' }] }, 10)
      const v3 = validateLocalActions({ thought: 't', actions: [{ name: 'click', index: 99 }] }, 10)
      const v4 = validateLocalActions({ thought: 't', actions: [] }, 10)
      const v5 = validateLocalActions(null, 10)
      check(
        '混合模式(本地决策校验)',
        v1 === null && v2 !== null && v3 !== null && v4 !== null && v5 !== null,
        `合法click=${v1 === null} 拒done=${!!v2} 拒越界=${!!v3} 拒空=${!!v4} 拒非法JSON=${!!v5}`
      )

      // repeat：重放上一批 type 动作（输入被清空重写，值应保持一致）
      const repExtract = await ex.extract()
      const repIdx = repExtract.candidates.findIndex((c) => c.tag === 'INPUT' && (c.extra.includes('搜索') || c.extra.includes('kw')))
      if (repIdx >= 0) {
        const batch1 = await ex.executeBatch(
          [{ name: 'type', index: repIdx, text: '重复测试' }],
          { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
        )
        const prev = batch1.map(({ result: _r, error: _e, ...rest }: any) => rest)
        const repOut = await ex.executeBatch(
          [{ name: 'repeat', amount: 2 }],
          { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any, prevActions: prev }
        )
        const v = await tm.active()!.cdp.evaluate<string>(String(() => (window as any).__getInputValue()), [])
        check(
          '混合模式(repeat 重放)',
          !repOut[0].error && v === '重复测试',
          repOut[0].result || ''
        )
      } else {
        check('混合模式(repeat 重放)', false, '未找到输入框元素')
      }
    } catch (e: any) {
      check('混合模式(本地决策校验)', false, String(e?.message || e))
    }

    // 8.97 定时任务：策略计算（纯函数）+ IPC 往返（创建/更新/取消/删除）
    try {
      const { computeNextRun } = await import('./scheduler')
      const now = Date.now()
      const onceNext = computeNextRun({ type: 'once', at: now + 5000 }, now)
      const intNext = computeNextRun({ type: 'interval', intervalMin: 30 }, now)
      const d = new Date(now + 3600_000)
      d.setHours(9, 0, 0, 0)
      const baseDay = new Date(now)
      baseDay.setHours(9, 0, 0, 0)
      const dailyNext = computeNextRun({ type: 'daily', dailyMinute: 540 }, now)
      const dailyOk =
        dailyNext > now &&
        dailyNext - now <= 24 * 3600_000 &&
        new Date(dailyNext).getHours() === 9 &&
        new Date(dailyNext).getMinutes() === 0
      check(
        '定时任务(策略计算)',
        Math.abs(onceNext - (now + 5000)) < 50 && Math.abs(intNext - (now + 1_800_000)) < 50 && dailyOk,
        `once+${onceNext - now}ms interval+${intNext - now}ms daily→${new Date(dailyNext).toLocaleTimeString('zh-CN')}`
      )

      // IPC 往返（走 UI webContents 的 preload 桥，验证主进程调度器 CRUD）
      const ui = deps.getUiWebContents?.()
      if (ui) {
        const created = await ui.executeJavaScript(
          `window.easybow.saveSchedule(${JSON.stringify({
            name: '自测定时',
            task: '自测：什么都不做',
            enabled: true,
            type: 'interval',
            intervalMin: 60
          })})`,
          true
        )
        const hasIt = Array.isArray(created) && created.some((s: any) => s.name === '自测定时' && s.nextRun > Date.now())
        const sid = created.find((s: any) => s.name === '自测定时')?.id
        // 切换策略字段清理：interval → daily 后，旧策略字段（intervalMin）必须被清掉，
        // 而不是残留 undefined/旧值（JSON 序列化后字段应不存在）
        const switched = sid != null
          ? await ui.executeJavaScript(
              `window.easybow.saveSchedule(${JSON.stringify({
                name: '自测定时',
                task: '自测：什么都不做',
                enabled: true,
                type: 'daily',
                dailyMinute: 540,
                id: sid
              })})`,
              true
            )
          : null
        const sw = switched?.find?.((s: any) => s.id === sid)
        // 修复前：Object.assign 不触碰缺席键，旧策略字段残留旧值（如 intervalMin=60）
        const switchClean =
          !!sw && sw.type === 'daily' && sw.dailyMinute === 540 && sw.intervalMin === undefined && sw.at === undefined
        const cancelled = sid != null ? await ui.executeJavaScript(`window.easybow.cancelScheduledRun(${sid})`, true) : null
        const delOk = sid != null ? await ui.executeJavaScript(`window.easybow.deleteSchedule(${sid})`, true) : null
        check(
          '定时任务(IPC 创建/取消/删除)',
          hasIt && switchClean && Array.isArray(cancelled) && Array.isArray(delOk) && !delOk.some((s: any) => s.id === sid),
          `创建=${hasIt} 策略切换字段清理=${switchClean}（旧 intervalMin=${sw?.intervalMin ?? '无'}） 删除=${!delOk?.some?.((s: any) => s.id === sid)}`
        )

        // 弹窗 UI：任务描述框样式已与全局设计语言统一（真实断言 + 截图供人工核对）
        if (!app.isPackaged) {
          try {
            // 先截主界面 hero（窗口置顶防止截到其他应用；README 文档用）
            {
              const w = deps.getWin?.()
              if (w && !w.isDestroyed()) {
                w.show()
                w.focus()
                w.moveTop()
                await sleep(500)
                const { desktopCapturer } = await import('electron')
                const sources = await desktopCapturer.getSources({
                  types: ['screen'],
                  thumbnailSize: { width: 1600, height: 1000 }
                })
                if (sources[0]) {
                  const { writeFileSync } = await import('fs')
                  writeFileSync(join(process.cwd(), 'hero-screen.png'), sources[0].thumbnail.toPNG())
                }
              }
            }
            await ui.executeJavaScript(
              `(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('定时')); b && b.click(); })()`,
              true
            )
            await sleep(700) // 等弹窗弹入动画结束
            const styleInfo = await ui.executeJavaScript(
              `(() => {
                const ta = document.querySelector('.sch-task-input');
                const inp = document.querySelector('.modal .form-row input');
                if (!ta || !inp) return null;
                const a = getComputedStyle(ta), b = getComputedStyle(inp);
                return {
                  taRadius: a.borderRadius, inpRadius: b.borderRadius,
                  taBorder: a.borderColor, inpBorder: b.borderColor,
                  taFont: a.fontFamily.slice(0, 30), inpFont: b.fontFamily.slice(0, 30),
                  taPad: a.padding, sameRadius: a.borderRadius === b.borderRadius,
                  sameBorder: a.borderColor === b.borderColor, sameFont: a.fontFamily === b.fontFamily
                };
              })()`,
              true
            )
            check(
              '定时任务弹窗UI统一',
              !!styleInfo && styleInfo.sameRadius && styleInfo.sameBorder && styleInfo.sameFont && styleInfo.taRadius !== '0px',
              styleInfo
                ? `任务框 radius=${styleInfo.taRadius}/输入框=${styleInfo.inpRadius} 边框色一致=${styleInfo.sameBorder} 字体一致=${styleInfo.sameFont}`
                : '弹窗未打开或元素缺失'
            )
            const w = deps.getWin?.()
            if (w && !w.isDestroyed()) {
              const img = await w.webContents.capturePage()
              if (!img.isEmpty()) {
                const { writeFileSync } = await import('fs')
                writeFileSync(join(process.cwd(), 'schedule-modal.png'), img.toPNG())
              }
            }
            await ui.executeJavaScript(
              `(() => { const x = document.querySelector('.modal h3 .close-x'); x && x.click(); })()`,
              true
            )
          } catch (e: any) {
            check('定时任务弹窗UI统一', false, String(e?.message || e))
          }
        }
      } else {
        check('定时任务(IPC 创建/取消/删除)', false, 'UI webContents 不可用')
      }
    } catch (e: any) {
      check('定时任务(策略计算)', false, String(e?.message || e))
    }

    // 9. OCR 整页识别（模型可用时）
    try {
      const ocr = await import('./ocr')
      const st0 = await ocr.tryInitOcr()
      if (st0.enabled) {
        // 先回页顶，保证截图视口确定
        await tm.active()!.cdp.evaluate(String(() => window.scrollTo(0, 0)), [])
        await sleep(300)
        const png = await tm.active()!.cdp.screenshotPng()
        if (!png) throw new Error('整页截图失败')
        const text = await ocr.testRecognize(png)
        const hit = /A1024|订单号|张三|提交/.test(text)
        check('OCR整页识别', hit, `识别 ${text.length} 字: ${text.replace(/\n/g, ' ').slice(0, 80)}`)
      } else {
        check('OCR整页识别', true, `OCR 未启用（${st0.reason}），跳过`)
      }
    } catch (e: any) {
      check('OCR整页识别', false, String(e?.message || e))
    }

    // 9.9 页签关闭时清理提取快照（内存泄漏回归：snapshots 只增不减）
    try {
      tm.newTab('about:blank') // 显式加载，未 commit 的页面会让 CDP evaluate 挂起
      await sleep(800)
      const blank = tm.active()
      if (!blank) throw new Error('新页签不可用')
      await ex.extract(blank)
      const hadSnap = !!ex.getSnapshot(blank.id)
      tm.closeTab(blank.id)
      await sleep(200)
      const leaked = !!ex.getSnapshot(blank.id)
      check('页签关闭清理快照', hadSnap && !leaked, `关闭前有快照=${hadSnap} 关闭后残留=${leaked}`)
    } catch (e: any) {
      check('页签关闭清理快照', false, String(e?.message || e))
    }

    // 10. 浏览器仿真测试（feature/browser-test）
    try {
      const sampleMd = [
        '# TESTCASE: 示例用例',
        '',
        '## 测试数据',
        '| 变量 | 值 |',
        '|---|---|',
        '| username | test01 |',
        '| password | Test@123 |',
        '',
        '## 步骤',
        '',
        '### 步骤 1: 打开登录页',
        '- 操作: 访问 {{base_url}}/login',
        '',
        '### 步骤 2: 登录',
        '- 操作: 在用户名输入 {{username}}，点击「登录」',
        '- 预期: [文字] 页面出现「欢迎回来」',
        '- 预期: [URL] 不包含 /login',
        '- 预期: [选择器 .error-msg] 不存在',
        '- 弹窗: 取消',
        '',
        '## 清理',
        '### 步骤 1: 退出',
        '- 操作: 点击头像菜单里的退出'
      ].join('\n')

      // 10.1 用例解析：变量/步骤/断言类型/取反/弹窗/清理区块
      const { parseTestCase } = await import('./testcase/parser')
      const pr = parseTestCase(sampleMd)
      const tcOk = !!pr.tc && pr.tc.vars.username === 'test01' && pr.tc.steps.length === 3
      const a2 = pr.tc?.steps[1].assertions
      const asrtOk =
        !!a2 &&
        a2.length === 3 &&
        a2[0].kind === 'text_visible' &&
        a2[1].kind === 'url_contains' &&
        !!a2[1].negate &&
        a2[2].kind === 'selector_exists' &&
        !!a2[2].negate &&
        a2[2].selector === '.error-msg'
      const dlgOk = pr.tc?.steps[1].dialog === 'dismiss'
      const cleanOk = !!pr.tc?.steps[2].title.startsWith('清理:')
      check(
        '测试用例解析(parser)',
        tcOk && asrtOk && dlgOk && cleanOk,
        `vars/steps=${tcOk} 断言=${asrtOk} 弹窗=${dlgOk} 清理=${cleanOk}`
      )
      const bad = parseTestCase('# TESTCASE: 空用例\n\n## 测试数据\n| a | b |\n|---|---|\n| k | v |')
      check('测试用例解析-拒绝无效用例', !bad.ok && !!bad.error, bad.error || '（意外通过）')

      // 10.2 提示词逐字节回归：普通模式 buildStepMessage 与基线完全一致（防意外改动破坏普通任务）；
      // 测试区块/追加段只在测试模式出现
      const { buildStepMessage, SYSTEM_PROMPT, TEST_MODE_ADDON } = await import('./agent/prompts')
      const fixedCtx: any = {
        task: '测试任务',
        tabs: [{ id: 1, title: '页签一', url: 'https://example.com', loading: false, canGoBack: false, canGoForward: false }],
        activeTabId: 1,
        extract: {
          title: '示例页',
          url: 'https://example.com/page',
          scrollY: 0,
          scrollHeight: 600,
          viewportW: 1000,
          viewportH: 600,
          candidates: [],
          totalFound: 0,
          imgCount: 0
        },
        elementLines: '[1] <button> "确定"',
        maxElements: 80,
        memory: {},
        steps: [],
        lastResults: [],
        kbTips: []
      }
      const baseline = [
        '# 任务\n测试任务',
        '# 页签（当前第 1/1 个）\n[1] 页签一 ←当前',
        '# 当前页面\n标题: 示例页\nURL: https://example.com/page ', // URL 后有一个空格（scrollInfo 为空时的模板产物，属既有行为）
        '# 可交互元素（编号仅对当前页签有效）\n[1] <button> "确定"',
        '# 下一步\n输出 JSON（thought + 最多5个动作）：'
      ].join('\n\n')
      const msgNormal = buildStepMessage(fixedCtx)
      const byteOk = msgNormal === baseline
      check(
        '提示词逐字节回归(非测试模式)',
        byteOk,
        byteOk ? `${msgNormal.length} 字节一致` : `长度 ${msgNormal.length} vs 基线 ${baseline.length}`
      )
      const msgTest = buildStepMessage({
        ...fixedCtx,
        test: {
          dataLines: 'username=test01',
          progressLines: '',
          stepNo: 1,
          totalSteps: 2,
          currentBlock: '### 步骤 1: 打开\n- 操作: 访问 {{base_url}}/login'
        }
      })
      check(
        '提示词测试区块仅测试模式注入',
        msgTest.includes('# 测试脚本') && !msgNormal.includes('# 测试脚本') && TEST_MODE_ADDON.includes('test_step_done') && !SYSTEM_PROMPT.includes('测试模式'),
        `普通模式含测试区块=${msgNormal.includes('# 测试脚本')} 测试模式含=${msgTest.includes('# 测试脚本')}`
      )

      // 回到自测 fixture 页（此前 9.9 开关过页签）
      await tm.navigate(fixture)
      await sleep(900)

      // 10.3 表单字段深提取：label 关联 / 无 label 仅 placeholder / select 选项 / required / checkbox
      const { FORM_FIELDS_FN } = await import('./testcase/fields')
      const ftab = tm.active()
      if (!ftab) throw new Error('fixture 页签不可用')
      const fields = await ftab.cdp.evaluate<any[]>(FORM_FIELDS_FN, [])
      const fu = fields.find((f) => f.id === 'reg-user')
      const fp = fields.find((f) => f.id === 'reg-phone')
      const fc = fields.find((f) => f.id === 'reg-city')
      const fa = fields.find((f) => f.id === 'reg-agree')
      check(
        '表单字段深提取',
        !!fu && fu.label.includes('用户名') && fu.required === true && !!fp && fp.placeholder.includes('11位手机号') && !!fc && Array.isArray(fc.options) && fc.options.some((o: any) => o.value === 'hz') && !!fa && fa.inputType === 'checkbox',
        `字段数=${fields.length} 用户名label=${fu?.label || '无'} phone占位=${fp?.placeholder || '无'} 城市选项=${fc?.options?.length}`
      )

      // 10.4 expect 断言：通过路径（文字/选择器/URL/取值）+ 失败路径不中断批次
      await ftab.cdp.evaluate(String(function setVal() { (document.getElementById('reg-user') as HTMLInputElement).value = 'tester01' }), [])
      const passCtx = { memory: {}, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
      const b1 = await ex.executeBatch(
        [
          { name: 'expect', kind: 'text_visible', value: '注册表单' },
          { name: 'expect', kind: 'selector_exists', selector: '#reg-phone' },
          { name: 'expect', kind: 'url_contains', value: 'testpage.html' },
          { name: 'expect', kind: 'selector_value', selector: '#reg-user', value: 'tester01' }
        ] as any,
        passCtx
      )
      const passOk = b1.length === 4 && b1.every((a: any) => a.name === 'expect' && !a.error)
      check('expect断言-通过路径', passOk, b1.map((a: any) => a.error || 'ok').join(' | '))
      const b2 = await ex.executeBatch(
        [
          { name: 'expect', kind: 'text_visible', value: '根本不存在的文字xyzq' },
          { name: 'expect', kind: 'selector_exists', selector: '.no-such-cls-xyz', negate: true },
          { name: 'expect', kind: 'text_visible', value: '注册表单' }
        ] as any,
        passCtx
      )
      const failOk = b2.length === 3 && !!b2[0].error && !b2[1].error && !b2[2].error
      check('expect断言-失败不中断批次', failOk, `首条失败=${!!b2[0].error} 取反通过=${!b2[1].error} 后续继续=${!b2[2].error}`)

      // 10.5 智能填充规划：本地契约校验（越界 index 过滤、值保留）
      const { planFormFill } = await import('./testcase/fields')
      const stubPlanner: any = {
        chat: async () => ({
          text: '[{"index":0,"value":"13800138000","reason":"手机号按占位符"},{"index":99,"value":"x"}]',
          usage: { inputTokens: 1, outputTokens: 1 }
        })
      }
      const plan = await planFormFill(
        stubPlanner,
        [
          {
            tag: 'INPUT', inputType: 'tel', name: 'phone', id: '', placeholder: '请输入11位手机号', label: '', aria: '',
            autoComplete: '', required: true, pattern: '', min: '', max: '', maxLength: 11, value: '', checked: false,
            adjacent: '', options: [], hint: 'placeholder=请输入11位手机号 name=phone 必填'
          }
        ] as any,
        { vars: {}, constraints: '', onlyRequired: false }
      )
      check('智能填充规划(契约校验)', plan.length === 1 && plan[0].value === '13800138000', JSON.stringify(plan))

      // 10.6 fill_form 端到端：stub 规划器 + 真实填充管线（文本键入回读 / 下拉 / 勾选）
      const fieldsForIdx = await ftab.cdp.evaluate<any[]>(FORM_FIELDS_FN, [])
      const idxUser = fieldsForIdx.findIndex((f) => f.id === 'reg-user')
      const idxPhone = fieldsForIdx.findIndex((f) => f.id === 'reg-phone')
      const idxCity = fieldsForIdx.findIndex((f) => f.id === 'reg-city')
      const idxAgree = fieldsForIdx.findIndex((f) => f.id === 'reg-agree')
      const savedPlanner = ex.formFillPlanner
      ex.formFillPlanner = async () => [
        { index: idxUser, value: 'tester02', reason: '自测' },
        { index: idxPhone, value: '13800138000', reason: '自测' },
        { index: idxCity, value: 'hz', reason: '自测' },
        { index: idxAgree, value: '', check: true, reason: '自测' }
      ]
      let ff: any[] = []
      try {
        ff = await ex.executeBatch([{ name: 'fill_form' }] as any, passCtx)
      } finally {
        ex.formFillPlanner = savedPlanner
      }
      const regState = await ftab.cdp.evaluate<any>(
        String(function readReg() {
          return {
            u: (document.getElementById('reg-user') as HTMLInputElement).value,
            p: (document.getElementById('reg-phone') as HTMLInputElement).value,
            c: (document.getElementById('reg-city') as HTMLSelectElement).value,
            a: (document.getElementById('reg-agree') as HTMLInputElement).checked
          }
        }),
        []
      )
      check(
        'fill_form智能填充(端到端)',
        !ff[0]?.error && regState.u === 'tester02' && regState.p === '13800138000' && regState.c === 'hz' && regState.a === true,
        `error=${ff[0]?.error || '无'} 实际=${JSON.stringify(regState)}`
      )

      // 10.7 JS 原生弹窗自动应答（仅启用 policy 时接管；应答后 evaluate 不再被阻塞）
      ftab.cdp.setDialogPolicy('accept')
      await sleep(300) // 等 Page.enable 生效
      const snapDlg = await ex.extract(ftab)
      const dlgIdx = snapDlg.candidates.findIndex((c) => c.text.includes('删除记录'))
      const dlgBatch = await ex.executeBatch([{ name: 'click', index: dlgIdx }] as any, passCtx)
      await sleep(500)
      const dlgLog = ftab.cdp.consumeDialogs()
      const dlgResult = await ftab.cdp.evaluate<string>(
        String(function readDlg() { return document.getElementById('confirm-result')!.textContent || '' }),
        []
      )
      check(
        'JS弹窗自动应答',
        !!dlgLog && dlgLog.includes('确定要删除') && dlgLog.includes('已确认') && dlgResult === '已删除' && !dlgBatch[0]?.error,
        `记录=${dlgLog || '无'} 页面结果=${dlgResult}（注：CDP 派发输入触发的 confirm 上报类型可能是 alert，以文案与应答结果判定为准）`
      )
      ftab.cdp.setDialogPolicy(null)

      // 10.8 测试页签独立分区：ensureTestTab 幂等复用同一页签
      const t1 = tm.ensureTestTab()
      await sleep(500)
      const t2 = tm.ensureTestTab()
      const partOk = t1.id === t2.id && t1.partition === 'persist:easybow-test'
      tm.closeTab(t1.id)
      await sleep(200)
      check('测试页签独立分区复用', partOk, `id=${t1.id}/${t2.id} partition=${t1.partition}`)

      // 10.9 用例转换器：坏输出自动带错误重试一次后成功
      const { convertRequirement } = await import('./testcase/converter')
      let chatCall = 0
      const stubConv: any = {
        chat: async () => {
          chatCall++
          return {
            text: chatCall === 1 ? '这不是用例 markdown' : sampleMd,
            usage: { inputTokens: 1, outputTokens: 1 }
          }
        }
      }
      const cv = await convertRequirement(stubConv, '打开后台，登录，新建客户', 'rough')
      check('用例转换器(重试与校验)', cv.ok && cv.steps === 3 && cv.attempts === 2, `ok=${cv.ok} steps=${cv.steps} attempts=${cv.attempts} err=${cv.error || '无'}`)

      // 10.10 测试报告生成：判定/步骤表/断言明细/失败截图落盘
      const { writeTestReport } = await import('./testcase/report')
      const { readFileSync, existsSync } = await import('fs')
      const { dirname, join: joinP } = await import('path')
      const fakeRun: any = {
        state: 'failed', caseName: '自测报告用例', envName: '测试环境', totalSteps: 2, currentStep: 2,
        steps: [
          { index: 1, title: '步骤一', status: 'passed', assertions: [{ raw: '[文字] x', kind: 'text_visible', passed: true }], modelSteps: 1 },
          { index: 2, title: '步骤二', status: 'failed', assertions: [{ raw: '[URL] y', kind: 'url_contains', passed: false, actual: '/z' }], modelSteps: 2, error: '断言失败' }
        ],
        passed: 1, failed: 1, startedAt: Date.now() - 5000, endedAt: Date.now(), tokens: { input: 100, output: 50 }
      }
      const reportPath = writeTestReport(
        fakeRun,
        { name: '自测报告用例', vars: { a: '1' }, steps: [{ title: '步骤一', action: 'op1', assertions: [] }, { title: '步骤二', action: 'op2', assertions: [] }] } as any,
        new Map([[2, 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg').toString('base64')]])
      )
      const rc = readFileSync(reportPath, 'utf-8')
      const htmlOk = existsSync(joinP(dirname(reportPath), 'report.html'))
      const htmlContent = htmlOk ? readFileSync(joinP(dirname(reportPath), 'report.html'), 'utf-8') : ''
      check(
        '测试报告生成',
        reportPath.endsWith('report.md') && rc.includes('❌ 失败') && rc.includes('步骤二') && rc.includes('实际: /z') && existsSync(joinP(dirname(reportPath), 'shots', 'step-2.jpg')) && htmlOk && htmlContent.includes('❌ 失败') && htmlContent.includes('step-2.jpg'),
        `${reportPath}（HTML ${htmlOk ? '✓' : '缺失'}）`
      )

      // 10.11 文件上传：{{变量}}路径解析 + DOM.setFileInputFiles 真实喂文件
      {
        const { writeFileSync: wf } = await import('fs')
        const tmpFile = join(process.cwd(), 'selftest-upload-tmp.txt')
        wf(tmpFile, 'easybow upload selftest\n', 'utf-8')
        // 给文件框一个可识别的 title（提取器对空值 input 的 text 回退到 title）
        await ftab.cdp.evaluate(String(function markUp() { (document.getElementById('up-file') as HTMLInputElement).title = '自测上传框' }), [])
        const snapUp = await ex.extract(ftab)
        const upIdx = snapUp.candidates.findIndex((c) => c.text === '自测上传框')
        const upCtx = { memory: { 合同: tmpFile }, signal: new AbortController().signal, settings: { speed: 'normal' } as any }
        const upBatch = await ex.executeBatch([{ name: 'upload', index: upIdx, path: '{{合同}}' }] as any, upCtx)
        const upState = await ftab.cdp.evaluate<string>(
          String(function readUp() { const f = (document.getElementById('up-file') as HTMLInputElement).files?.[0]; return f ? f.name : '' }),
          []
        )
        check(
          '文件上传(DOM.setFileInputFiles+{{变量}}路径)',
          upIdx >= 0 && !upBatch[0]?.error && upState === 'selftest-upload-tmp.txt',
          `idx=${upIdx} error=${upBatch[0]?.error || '无'} 已选=${upState || '无'}`
        )
      }

      // 10.12 hover 悬停展开（CDP 无按键 mouseMoved → mouseenter/CSS :hover）
      {
        await ftab.cdp.evaluate(String(function scrollHover() { (document.getElementById('hover-trigger') as HTMLElement).scrollIntoView({ block: 'center' }) }), [])
        await sleep(300)
        const snapHv = await ex.extract(ftab)
        const hvIdx = snapHv.candidates.findIndex((c) => c.text.includes('更多操作'))
        const hvBatch = await ex.executeBatch([{ name: 'hover', index: hvIdx }] as any, passCtx)
        const hvFlag = await ftab.cdp.evaluate<string>(String(function readHv() { return document.getElementById('hover-flag')!.textContent || '' }), [])
        check('hover悬停展开', hvIdx >= 0 && !hvBatch[0]?.error && hvFlag === 'hovered', `idx=${hvIdx} error=${hvBatch[0]?.error || '无'} flag=${hvFlag}`)
      }

      // 10.13 提交后软断言：提交类点击后发现「可见的」校验错误提示（用例没写断言也能兜住）
      {
        // 上一项 hover 展开的菜单是 absolute+z-index，会盖住下方的保存按钮——先收起再点
        await ftab.cdp.evaluate(
          String(function closeMenu() { (document.getElementById('hover-menu') as HTMLElement).style.display = 'none' }),
          []
        )
        await ftab.cdp.evaluate(String(function scrollSave() { (document.getElementById('save-btn') as HTMLElement).scrollIntoView({ block: 'center' }) }), [])
        await sleep(300)
        const snapSv = await ex.extract(ftab)
        const svIdx = snapSv.candidates.findIndex((c) => c.text.trim() === '保存设置')
        const softErrors: string[] = []
        const svBatch = await ex.executeBatch(
          [{ name: 'click', index: svIdx }] as any,
          { ...passCtx, softAssert: true, softErrors }
        )
        check(
          '提交后软断言(校验错误兜底)',
          svIdx >= 0 && !svBatch[0]?.error && softErrors.length === 1 && softErrors[0].includes('名称重复') && (svBatch[0]?.result || '').includes('⚠'),
          `idx=${svIdx} soft=${JSON.stringify(softErrors)} result=${(svBatch[0]?.result || '').slice(0, 60)}`
        )
      }

      // 10.14 多组数据解析（数据驱动）：### 组名 小节 → groups
      {
        const groupMd = [
          '# TESTCASE: 登录多组',
          '## 测试数据',
          '### 组1: 正确凭据',
          '| password | Right@1 |',
          '### 组2: 错误密码',
          '| password | wrong |',
          '## 步骤',
          '### 步骤 1: 登录',
          '- 操作: 输入 {{password}} 提交',
          '- 预期: [URL] 包含 /home'
        ].join('\n')
        const gr = parseTestCase(groupMd)
        const gOk =
          !!gr.tc?.groups && gr.tc.groups.length === 2 && gr.tc.groups[0].name === '组1: 正确凭据' && gr.tc.groups[0].vars.password === 'Right@1' && gr.tc.groups[1].vars.password === 'wrong'
        const single = parseTestCase(sampleMd)
        const sOk = single.tc?.groups === undefined && single.tc?.vars.username === 'test01'
        check('多组数据解析(数据驱动)', gOk && sOk, `双组=${gOk} 单组兼容=${sOk}`)
      }
    } catch (e: any) {
      check('仿真测试功能', false, String(e?.stack || e))
    }
  } catch (e: any) {
    check('自测流程', false, String(e?.stack || e))
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n========== 自测结果: ${results.length - failed.length}/${results.length} 通过 ==========`)
  if (failed.length) {
    console.log('失败项: ' + failed.map((f) => f.name).join(', '))
  }
  await sleep(500)
  app.exit(failed.length ? 1 : 0)
}
