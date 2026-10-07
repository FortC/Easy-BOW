/**
 * 同步 onnxruntime-web 运行时（ort.min.js + *.wasm + *.mjs）到 resources/ocr/ort/
 * 在 build 前运行，保证渲染进程 OCR worker 可离线加载 WASM。
 */
import { copyFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const distDir = join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist')
const outDir = join(__dirname, '..', 'resources', 'ocr', 'ort')

if (!existsSync(distDir)) {
  console.error('未找到 onnxruntime-web/dist，请先 npm install')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

let n = 0
for (const f of readdirSync(distDir)) {
  if (f === 'ort.min.js' || f.endsWith('.wasm') || (f.startsWith('ort-wasm') && f.endsWith('.mjs'))) {
    copyFileSync(join(distDir, f), join(outDir, f))
    n++
  }
}
console.log(`已同步 ${n} 个 onnxruntime-web 文件到 resources/ocr/ort/`)
