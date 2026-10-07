/**
 * 幂等补丁：@huggingface/transformers node 构建的 ORT 注入分支不初始化 supportedDevices，
 * 注入 globalThis[Symbol.for('onnxruntime')]（WASM 后端）时会抛 "Unsupported device"。
 * 该分支补上 wasm/webgpu/cpu 并把默认设备设为 wasm（原生 onnxruntime-node 在部分
 * Windows 机器上会话创建即段错误，WASM 是兜底可靠路径）。
 * 运行时机：postinstall（npm 重装依赖后需重跑）。
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../node_modules/@huggingface/transformers/dist/transformers.node.mjs'
)

const ORIGINAL = `if (ORT_SYMBOL in globalThis) {
  ONNX = globalThis[ORT_SYMBOL];
} else if (apis.IS_NODE_ENV) {`

const PATCHED = `if (ORT_SYMBOL in globalThis) {
  ONNX = globalThis[ORT_SYMBOL];
  supportedDevices.push("wasm", "webgpu", "cpu");
  defaultDevices = ["wasm"];
} else if (apis.IS_NODE_ENV) {`

let src = readFileSync(FILE, 'utf8')
if (src.includes('supportedDevices.push("wasm", "webgpu", "cpu");\n  defaultDevices = ["wasm"];')) {
  console.log('transformers 补丁已存在，跳过')
  process.exit(0)
}
if (!src.includes(ORIGINAL)) {
  console.error('补丁锚点未找到（transformers 版本变了？），请检查 scripts/patch-transformers.mjs')
  process.exit(1)
}
src = src.replace(ORIGINAL, PATCHED)
writeFileSync(FILE, src)
console.log('transformers.node.mjs 已打 WASM 注入补丁')
