// 验证：主进程内 transformers + 注入 ort-web(WASM) 完整加载/推理 int8 模型，并测速
import { pathToFileURL, fileURLToPath } from 'url'
import { dirname, join } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 1) 注入 ort-web（必须在 import transformers 之前）
const ortWeb = await import('ort-fast')
ortWeb.env.wasm.numThreads = 1 // 主进程无 Web Worker
const distDir = join(ROOT, 'node_modules', 'ort-fast', 'dist')
ortWeb.env.wasm.wasmPaths = pathToFileURL(distDir + '/').href
ortWeb.env.wasm.proxy = false

// 包一层：强制 wasm 执行器（transformers 会按 device 传 'cpu'，ort-web 不认）
const injected = {
  ...ortWeb,
  InferenceSession: {
    ...ortWeb.InferenceSession,
    create: (a, o = {}) =>
      ortWeb.InferenceSession.create(a, { ...o, executionProviders: ['wasm'] })
  }
}
globalThis[Symbol.for('onnxruntime')] = injected
console.log('[1] ort-web', ortWeb.env.versions?.web || '1.20.1', '已注入 globalThis[Symbol.for("onnxruntime")]')

// 2) 加载 transformers（node 构建会拿到注入的 ONNX）
const tf = await import('@huggingface/transformers')
console.log('[2] transformers', tf.env.version, 'backends.onnx 版本:', tf.env.backends?.onnx?.versions?.web || '(injected)')
tf.env.cacheDir = join(ROOT, 'resources', 'fastmodel') + '/'
tf.env.allowLocalModels = true

const REPO = 'onnx-community/Qwen2.5-0.5B-Instruct'
let t0 = Date.now()
const tok = await tf.AutoTokenizer.from_pretrained(REPO, { local_files_only: true })
console.log('[3] tokenizer OK', Date.now() - t0, 'ms')

t0 = Date.now()
const model = await tf.AutoModelForCausalLM.from_pretrained(REPO, {
  dtype: 'q8',
  local_files_only: true
})
console.log('[4] model(wasm q8) OK', Date.now() - t0, 'ms')

const messages = [
  { role: 'system', content: '你是浏览器自动化助手，只输出纯 JSON。' },
  { role: 'user', content: '页面有搜索框，请输出决策 JSON：{"thought":"...","actions":[{"name":"type","index":0,"text":"无线鼠标"}]}' }
]
const input = await tok.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true })

for (const n of [16, 64, 128]) {
  const t1 = Date.now()
  const out = await model.generate({ ...input, max_new_tokens: n, do_sample: false })
  const dt = Date.now() - t1
  const text = tok.batch_decode(out, { skip_special_tokens: true })[0]
  console.log(`[gen ${n} tokens] ${dt}ms → ${(n / (dt / 1000)).toFixed(1)} tok/s | 尾部: ...${text.slice(-80)}`)
  if (n === 128) break
}
console.log('DONE')
process.exit(0)
