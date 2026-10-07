/**
 * 下载 PP-OCRv4 ONNX 模型到 resources/ocr/
 * 用法: node scripts/download-ocr-models.mjs
 * 源: hf-mirror.com（国内可达的 HuggingFace 镜像） + GitHub API（字典文件）
 */
import { mkdirSync, writeFileSync, existsSync, statSync, renameSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'resources', 'ocr')

const FILES = [
  {
    name: 'det.onnx',
    urls: [
      'https://hf-mirror.com/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx',
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx'
    ],
    minSize: 4_000_000
  },
  {
    name: 'rec.onnx',
    urls: [
      'https://hf-mirror.com/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx',
      'https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx'
    ],
    minSize: 9_000_000
  }
]

const KEYS_API = 'https://api.github.com/repos/PaddlePaddle/PaddleOCR/contents/ppocr/utils/ppocr_keys_v1.txt'

async function download(name, urls, minSize) {
  for (const url of urls) {
    try {
      console.log(`下载 ${name} ← ${url}`)
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length < minSize) throw new Error(`文件过小(${buf.length})，可能是错误页`)
      writeFileSync(join(outDir, name), buf)
      console.log(`  ✓ ${name} ${(buf.length / 1024 / 1024).toFixed(1)}MB`)
      return true
    } catch (e) {
      console.log(`  ✗ ${e.message}`)
    }
  }
  return false
}

async function downloadKeys() {
  console.log('下载 keys.txt ← GitHub API')
  const res = await fetch(KEYS_API)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  const buf = Buffer.from(j.content, 'base64')
  if (buf.toString('utf8').split('\n').length < 6000) throw new Error('字典行数异常')
  writeFileSync(join(outDir, 'keys.txt'), buf)
  console.log(`  ✓ keys.txt ${buf.length} bytes`)
}

mkdirSync(outDir, { recursive: true })
let fail = false
for (const f of FILES) {
  if (existsSync(join(outDir, f.name)) && statSync(join(outDir, f.name)).size >= f.minSize) {
    console.log(`${f.name} 已存在，跳过`)
    continue
  }
  if (!(await download(f.name, f.urls, f.minSize))) fail = true
}
if (!existsSync(join(outDir, 'keys.txt'))) {
  try {
    await downloadKeys()
  } catch (e) {
    console.log(`  ✗ ${e.message}`)
    fail = true
  }
} else {
  console.log('keys.txt 已存在，跳过')
}
if (fail) {
  console.error('\n部分文件下载失败。可将其他机器上下载好的 det.onnx / rec.onnx / keys.txt 放入 resources/ocr/')
  process.exit(1)
}
console.log('\nOCR 模型就绪。')
