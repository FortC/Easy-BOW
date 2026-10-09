/**
 * 本地快速决策模型 worker（Electron utilityProcess 子进程入口）。
 *
 * 为什么必须是独立进程：Qwen2.5-0.5B int8 用 onnxruntime-web（WASM 单线程）推理，
 * 每个 token 都是一次同步 CPU 前向计算。此前直接在主进程推理，一次语义初筛/本地决策
 * 就把主线程整个卡住数秒——窗口「未响应」、点击无效，极端情况下退出时连强制退出的
 * 保险丝定时器都跑不动（进程残留）。挪进 utilityProcess 后主进程事件循环零阻塞；
 * worker 崩溃的最坏后果也只是本地模型不可用（runner 自动回退云端），应用无感。
 *
 * WASM 而非原生 onnxruntime-node 的原因不变：原生库在部分 Windows 机器上创建推理
 * 会话即段错误（v1.1.0 闪退根因），WASM 全平台稳定。注入方式与加载逻辑从原
 * fastllm.ts 主进程实现原样迁移（含 transformers.node.mjs 的 postinstall 补丁契约）。
 *
 * 协议（parentPort JSON 消息）：
 *   main → worker: {t:'init', modelDir, cacheDir, repo, dtype, mirror}  加载/下载模型
 *                  {t:'decide', id, prompt, maxNewTokens}               文本生成
 *                  {t:'dispose'}                                        释放并退出
 *   worker → main: {t:'status', status}   下载/加载进度、ready/error
 *                  {t:'result', id, ok, text?, genMs?, error?}
 */
import { join } from 'path'

interface InitMsg {
  t: 'init'
  /** 内置模型根目录（resources/fastmodel）；null=走 cacheDir 在线下载 */
  modelDir: string | null
  /** 在线下载缓存目录（userData/models） */
  cacheDir: string
  repo: string
  dtype: string
  mirror: string
}

type AnyPipeline = any

let model: AnyPipeline | null = null
let tokenizer: any = null
let lastGenMs = 0

function post(msg: unknown): void {
  ;(process as any).parentPort.postMessage(msg)
}

/**
 * 注入 WASM 版 ORT（必须在 import @huggingface/transformers 之前）。
 * ort-fast = 与 transformers 配套的 onnxruntime-web 精确版本（别名安装）；
 * globalThis[Symbol.for('onnxruntime')] 官方后门 + postinstall 补丁（supportedDevices）。
 */
async function injectWasmOrt(): Promise<any> {
  const ortWeb = (await import('ort-fast')) as any
  ortWeb.env.wasm.numThreads = 1 // 无 Web Worker 环境，单线程推理（与原主进程实现一致）
  ortWeb.env.wasm.proxy = false
  // wasm 二进制从包内 dist 目录取（打包后为 asar.unpacked 的真实文件）；
  // 打包判定与原主进程实现同语义：utilityProcess 里没有 app.isPackaged，用 __dirname 判
  const packed = __dirname.includes('app.asar')
  const distDir = packed
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ort-fast', 'dist')
    : join(__dirname, '../../node_modules/ort-fast/dist')
  ortWeb.env.wasm.wasmPaths = 'file:///' + distDir.replace(/\\/g, '/') + '/'
  ;(globalThis as Record<symbol, unknown>)[Symbol.for('onnxruntime')] = {
    ...ortWeb,
    InferenceSession: {
      ...ortWeb.InferenceSession,
      create: (a: unknown, o: Record<string, unknown> = {}) =>
        ortWeb.InferenceSession.create(a, { ...o, executionProviders: ['wasm'] })
    }
  }
  return ortWeb
}

async function init(msg: InitMsg): Promise<void> {
  if (model && tokenizer) {
    post({ t: 'status', status: { state: 'ready', detail: '本地快速决策模型就绪（Qwen2.5-0.5B int8）' } })
    return
  }
  await injectWasmOrt()
  const tf = await import('@huggingface/transformers')
  let localOnly = false
  if (msg.modelDir) {
    // 内置模型：纯离线加载，不碰网络
    tf.env.cacheDir = join(msg.modelDir, '/')
    tf.env.allowLocalModels = true
    localOnly = true
    post({ t: 'status', status: { state: 'loading', progress: 0, detail: '加载内置快速决策模型（Qwen2.5-0.5B int8）…' } })
  } else {
    tf.env.cacheDir = join(msg.cacheDir, '/')
    tf.env.remoteHost = msg.mirror
    post({ t: 'status', status: { state: 'downloading', progress: 0, detail: `准备下载 ${msg.repo}（int8，约 500MB，来源 hf-mirror）` } })
  }
  const progress = (p: any) => {
    if (p?.status === 'progress' && p.total) {
      post({
        t: 'status',
        status: {
          state: 'downloading',
          progress: p.loaded / p.total,
          detail: `下载 ${p.file || ''} ${(p.loaded / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(0)}MB`
        }
      })
    } else if (p?.status === 'ready' || p?.status === 'done') {
      post({ t: 'status', status: { state: 'loading', progress: 1, detail: '模型下载完成，加载中…' } })
    }
  }
  tokenizer = await tf.AutoTokenizer.from_pretrained(msg.repo, {
    progress_callback: progress,
    ...(localOnly ? { local_files_only: true } : {})
  })
  post({ t: 'status', status: { state: 'loading', progress: 1, detail: '加载模型权重到内存…' } })
  model = await tf.AutoModelForCausalLM.from_pretrained(msg.repo, {
    dtype: msg.dtype as any,
    device: 'wasm',
    progress_callback: progress,
    ...(localOnly ? { local_files_only: true } : {})
  })
  // 预热一次，避免首个决策承担图优化耗时
  post({ t: 'status', status: { state: 'loading', progress: 1, detail: '预热中…' } })
  await generate('输出 {"ok":1}', 16)
  post({ t: 'status', status: { state: 'ready', detail: '本地快速决策模型就绪（Qwen2.5-0.5B int8，独立进程推理）' } })
}

/** chat 模板 + 贪心解码；解码结果含提示词回声，由 runner 的宽松 JSON 解析截取 */
async function generate(prompt: string, maxNewTokens: number): Promise<string | null> {
  if (!model || !tokenizer) return null
  const messages = [
    { role: 'system', content: '你是浏览器自动化助手，只输出纯 JSON。' },
    { role: 'user', content: prompt }
  ]
  const input = await tokenizer.apply_chat_template(messages, {
    add_generation_prompt: true,
    return_dict: true
  })
  const t0 = Date.now()
  const out = await model.generate({
    ...input,
    max_new_tokens: maxNewTokens,
    do_sample: false
  })
  const text = tokenizer.batch_decode(out, { skip_special_tokens: true })[0] || ''
  lastGenMs = Date.now() - t0
  return text
}

// 作业串行化：模型推理不可并发（避免显存/中间张量争用），依次排队执行
let chain: Promise<void> = Promise.resolve()

;(process as any).parentPort.on('message', (e: { data: any }) => {
  const msg = e?.data
  if (!msg || typeof msg !== 'object') return
  if (msg.t === 'init') {
    chain = chain.then(() =>
      init(msg as InitMsg).catch((err: any) =>
        post({
          t: 'status',
          status: { state: 'error', detail: `本地模型加载失败: ${err?.message || err}` }
        })
      )
    )
  } else if (msg.t === 'decide') {
    const id = Number(msg.id)
    chain = chain.then(async () => {
      try {
        const text = await generate(String(msg.prompt || ''), Number(msg.maxNewTokens) || 96)
        post({ t: 'result', id, ok: true, text, genMs: lastGenMs })
      } catch (err: any) {
        post({ t: 'result', id, ok: false, error: String(err?.message || err) })
      }
    })
  } else if (msg.t === 'dispose') {
    try {
      ;(model as AnyPipeline)?.dispose?.()
    } catch {}
    model = null
    tokenizer = null
    process.exit(0)
  }
})
