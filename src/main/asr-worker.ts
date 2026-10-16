/**
 * 本地语音识别 worker（Electron utilityProcess 子进程入口）——v4.4 语音输入。
 *
 * 与 fastllm-worker 同构：whisper-base int8 用 onnxruntime-web（WASM 单线程）推理，
 * 推理是同步 CPU 前向计算，必须挪出主进程（否则转写几秒钟整个应用假死）。
 * WASM 而非原生 onnxruntime-node 的原因不变：原生库在部分 Windows 机器上创建推理
 * 会话即段错误（v1.1.0 闪退根因）。注入方式与 fastllm-worker 原样一致
 * （含 transformers.node.mjs 的 postinstall 补丁契约）。
 *
 * 协议（parentPort JSON 消息）：
 *   main → worker: {t:'init', modelDir}                        加载本地模型（纯离线）
 *                  {t:'transcribe', id, pcm, sampleRate}       转写一段 PCM（Float32Array）
 *                  {t:'dispose'}                               释放并退出
 *   worker → main: {t:'status', status}   加载进度、ready/error
 *                  {t:'result', id, ok, text?, ms?, error?}
 */
import { join } from 'path'

interface InitMsg {
  t: 'init'
  /** 内置模型目录（resources/asr/whisper-base） */
  modelDir: string
}

type AnyPipeline = any

let asr: AnyPipeline | null = null
let lastMs = 0

function post(msg: unknown): void {
  ;(process as any).parentPort.postMessage(msg)
}

/**
 * 注入 WASM 版 ORT（必须在 import @huggingface/transformers 之前）。
 * 与 fastllm-worker.injectWasmOrt 同一实现：ort-fast = 与 transformers 配套的
 * onnxruntime-web 精确版本（别名安装）；globalThis[Symbol.for('onnxruntime')] 官方后门
 * + postinstall 补丁（supportedDevices）。
 */
async function injectWasmOrt(): Promise<any> {
  const ortWeb = (await import('ort-fast')) as any
  ortWeb.env.wasm.numThreads = 1 // 无 Web Worker 环境，单线程推理
  ortWeb.env.wasm.proxy = false
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
  if (asr) {
    post({ t: 'status', status: { state: 'ready', detail: '语音识别模型就绪（whisper-base int8）' } })
    return
  }
  await injectWasmOrt()
  const tf = await import('@huggingface/transformers')
  // 内置模型：纯离线加载，不碰网络
  tf.env.cacheDir = join(msg.modelDir, '/')
  tf.env.allowLocalModels = true
  post({ t: 'status', status: { state: 'loading', progress: 0, detail: '加载语音识别模型（whisper-base int8）…' } })
  const t0 = Date.now()
  asr = await tf.pipeline('automatic-speech-recognition', msg.modelDir, {
    dtype: 'q8',
    device: 'wasm',
    local_files_only: true
  })
  post({
    t: 'status',
    status: { state: 'ready', detail: `语音识别模型就绪（whisper-base int8，${Date.now() - t0}ms）` }
  })
}

/** 转写一段 PCM（Float32Array，约定 16kHz 单声道——whisper 特征提取器的原生采样率）；
 *  pipeline 直接收 Float32Array（prepareAudios 透传），30s 窗口分块+重叠消除 */
async function transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
  if (!asr) return ''
  if (sampleRate && sampleRate !== 16000) {
    // 防御：调用方承诺 16k（渲染层已重采样）；真传别的采样率就地线性重采样
    const outLen = Math.floor((pcm.length * 16000) / sampleRate)
    const out = new Float32Array(outLen)
    const step = sampleRate / 16000
    for (let i = 0; i < outLen; i++) {
      const pos = i * step
      const i0 = Math.floor(pos)
      const i1 = Math.min(pcm.length - 1, i0 + 1)
      const f = pos - i0
      out[i] = pcm[i0] * (1 - f) + pcm[i1] * f
    }
    pcm = out
  }
  // 静音短路：峰值过低直接返回空（whisper 对纯静音/噪声会幻觉出几百 token，又慢又错）
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i] < 0 ? -pcm[i] : pcm[i]
    if (v > peak) peak = v
  }
  if (peak < 0.008) return ''
  const t0 = Date.now()
  const out = await asr(pcm, {
    chunk_length_s: 30,
    stride_length_s: 5,
    language: 'zh',
    task: 'transcribe',
    // 幻觉抑制：静音段不再反复续写（whisper 对噪声的典型病灶）
    condition_on_prev_tokens: false
  })
  lastMs = Date.now() - t0
  return String((out && out.text) || '')
}

// 作业串行化：模型推理不可并发，依次排队执行
let chain: Promise<void> = Promise.resolve()

;(process as any).parentPort.on('message', (e: { data: any }) => {
  const msg = e?.data
  if (!msg || typeof msg !== 'object') return
  if (msg.t === 'init') {
    chain = chain.then(() =>
      init(msg as InitMsg).catch((err: any) =>
        post({ t: 'status', status: { state: 'error', detail: `语音模型加载失败: ${err?.message || err}` } })
      )
    )
  } else if (msg.t === 'transcribe') {
    const id = Number(msg.id)
    chain = chain.then(async () => {
      try {
        // IPC 结构化克隆保留 TypedArray；防御性转一遍（消息经 JSON 边界时可能退化为对象/数组）
        const raw = msg.pcm
        const pcm: Float32Array = raw instanceof Float32Array ? raw : Float32Array.from(raw || [])
        if (!pcm.length) throw new Error('音频数据为空')
        const text = await transcribe(pcm, Number(msg.sampleRate) || 16000)
        post({ t: 'result', id, ok: true, text, ms: lastMs })
      } catch (err: any) {
        post({ t: 'result', id, ok: false, error: String(err?.message || err) })
      }
    })
  } else if (msg.t === 'dispose') {
    try {
      ;(asr as AnyPipeline)?.dispose?.()
    } catch {}
    asr = null
    process.exit(0)
  }
})
