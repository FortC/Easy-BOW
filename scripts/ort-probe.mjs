// 最小 ORT 探针：直接用 onnxruntime-node 创建会话，隔离崩溃层（模型文件经参数指定）
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const ort = require('onnxruntime-node')

const modelPath = process.argv[2] || process.env.APPDATA + '\\EasyBow\\models\\onnx-community\\Qwen2.5-0.5B-Instruct\\onnx\\model_q4.onnx'
console.log('ort version:', ort.env.version)
console.log('loading:', modelPath)

const opts = {}
if (process.argv.includes('--noopt')) opts.graphOptimizationLevel = 'disable_all'
if (process.argv.includes('--t1')) {
  opts.intraOpNumThreads = 1
  opts.interOpNumThreads = 1
  opts.executionMode = 'sequential'
}

const t0 = Date.now()
const session = await ort.InferenceSession.create(modelPath, opts)
console.log('session OK', Date.now() - t0, 'ms, inputs:', session.inputNames, 'outputs:', session.outputNames)
process.exit(0)
