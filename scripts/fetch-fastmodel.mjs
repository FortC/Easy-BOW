/**
 * 拉取本地快速决策模型到 resources/fastmodel/（随安装包打包，用户免下载）。
 * 布局与 transformers.js 的 cacheDir 约定一致：
 *   resources/fastmodel/onnx-community/Qwen2.5-0.5B-Instruct/{config,tokenizer…}.json + onnx/model_quantized.onnx
 * 幂等：文件已存在且大小一致则跳过；支持断点续传（Range）。
 * 运行：node scripts/fetch-fastmodel.mjs（npm run dist 会自动先跑）
 */
import { mkdirSync, existsSync, statSync, appendFileSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'resources', 'fastmodel', 'onnx-community', 'Qwen2.5-0.5B-Instruct')
const MIRROR = process.env.EASYBOW_HF_MIRROR || 'https://hf-mirror.com'
const REPO = 'onnx-community/Qwen2.5-0.5B-Instruct'

// int8 动态量化（q8 → model_quantized.onnx）。q4 在 onnxruntime-node 1.30+ Windows 会段错误，禁用。
const FILES = [
  ['config.json', 678],
  ['generation_config.json', 242],
  ['tokenizer_config.json', 7306],
  ['tokenizer.json', 7031673],
  ['onnx/model_quantized.onnx', 512096557]
]

async function fetchFile(rel, expectedSize) {
  const dest = join(OUT_DIR, rel)
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest) && statSync(dest).size === expectedSize) {
    console.log(`  ✓ ${rel} 已存在（${expectedSize} 字节），跳过`)
    return
  }
  const url = `${MIRROR}/${REPO}/resolve/main/${rel}`
  let startAt = existsSync(dest) ? statSync(dest).size : 0
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const headers = startAt > 0 ? { Range: `bytes=${startAt}-` } : {}
      const res = await fetch(url, { headers, redirect: 'follow' })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const viaRange = res.status === 206
      if (!viaRange) startAt = 0 // 服务器不支持续传，从头来
      const total = parseInt(res.headers.get('content-length') || '0', 10) + startAt
      const tmp = dest + '.part'
      if (!viaRange && existsSync(tmp)) (await import('fs')).rmSync(tmp)
      let loaded = startAt
      const t0 = Date.now()
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        appendFileSync(tmp, value)
        loaded += value.length
        if (total && Date.now() - t0 > 3000) {
          process.stdout.write(`\r  ↓ ${rel} ${(loaded / 1048576).toFixed(1)}/${(total / 1048576).toFixed(0)}MB   `)
        }
      }
      process.stdout.write('\n')
      if (total && loaded !== total) throw new Error(`大小不符：${loaded} ≠ ${total}`)
      renameSync(tmp, dest)
      console.log(`  ✓ ${rel} 完成（${loaded} 字节）`)
      return
    } catch (e) {
      console.log(`  ✗ ${rel} 第 ${attempt} 次失败：${e.message}，${
        existsSync(dest + '.part') ? '3 秒后续传' : '3 秒后重试'}`)
      if (existsSync(dest + '.part')) startAt = statSync(dest + '.part').size
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  throw new Error(`${rel} 多次重试后仍失败`)
}

console.log(`拉取快速决策模型 → ${OUT_DIR}`)
for (const [rel, size] of FILES) await fetchFile(rel, size)
console.log('模型文件就绪（将随安装包打包）')
