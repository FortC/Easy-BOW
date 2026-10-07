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
        // 终结态 3s 硬兜底：setWorking(false) 后无论内部时序，覆盖层必须彻底拆除（输入拦截归零）
        const m1 = ex.overlay.debugMainState()
        await sleep(3300)
        const m2 = ex.overlay.debugMainState()
        check(
          '任务结束3秒硬解除遮罩',
          m1.hasHardTimer && m2.shown === false && m2.visible === false,
          `停止工作后已安排硬释放=${m1.hasHardTimer}，3.3s后 shown=${m2.shown} 视图可见=${m2.visible}`
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
        const cancelled = sid != null ? await ui.executeJavaScript(`window.easybow.cancelScheduledRun(${sid})`, true) : null
        const delOk = sid != null ? await ui.executeJavaScript(`window.easybow.deleteSchedule(${sid})`, true) : null
        check(
          '定时任务(IPC 创建/取消/删除)',
          hasIt && Array.isArray(cancelled) && Array.isArray(delOk) && !delOk.some((s: any) => s.id === sid),
          `创建=${hasIt} 取消后顺延nextRun=${!!cancelled?.find?.((s: any) => s.id === sid)} 删除=${!delOk?.some?.((s: any) => s.id === sid)}`
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
