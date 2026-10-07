// 验证 onnxruntime-web (WASM) 能否在 Node 主进程创建会话（绕开原生库段错误）
import { pathToFileURL } from 'url'

const ort = await import('onnxruntime-web')
console.log('ort-web loaded, version:', ort.env.versions?.full || ort.env.versions?.web)
ort.env.wasm.numThreads = 1 // Node 无 Worker，单线程
// wasm 文件从本地 dist 目录取（默认会尝试 fetch 远端/相对路径）
const distDir = new URL('./../node_modules/onnxruntime-web/dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
ort.env.wasm.wasmPaths = pathToFileURL(distDir).href
console.log('wasmPaths:', ort.env.wasm.wasmPaths)

const model = process.argv[2] || 'G:/pjs/easybow/resources/ocr/rec.onnx'
console.log('loading:', model)
const t0 = Date.now()
const fs = await import('fs')
const buf = fs.readFileSync(model)
const s = await ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'] })
console.log('WASM SESSION OK', Date.now() - t0, 'ms →', s.inputNames)
process.exit(0)
