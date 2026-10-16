/**
 * 拉取本地语音识别模型（whisper-base int8）到 resources/asr/whisper-base/（随安装包打包，用户免下载）。
 * 布局与 transformers.js 的本地模型目录约定一致（config.json + onnx/ 平铺）：
 *   resources/asr/whisper-base/{config,tokenizer,preprocessor…}.json
 *   resources/asr/whisper-base/onnx/{encoder_model_quantized,decoder_model_merged_quantized}.onnx
 * 转写走 automatic-speech-recognition pipeline（transformers.js 自带），WASM 单线程推理，
 * 与「本地免费」产品定位一致；q8 动态量化约 80MB。
 * 幂等：文件已存在且大小一致则跳过；支持断点续传（Range）。
 * 运行：node scripts/fetch-asr-model.mjs（npm run dist 会自动先跑）
 */
import { mkdirSync, existsSync, statSync, appendFileSync, renameSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'resources', 'asr', 'whisper-base')
const MIRROR = process.env.EASYBOW_HF_MIRROR || 'https://hf-mirror.com'
const REPO = 'onnx-community/whisper-base'

// q8 动态量化（*_quantized.onnx）：transformers.js 的 dtype:'q8' 对应文件名。
// 大小为「上次校验时」的上游快照；上游更新导致 416 时有整包重下兜底
const FILES = [
  ['config.json', 2243],
  ['generation_config.json', 3832],
  ['preprocessor_config.json', 339],
  ['tokenizer.json', 2480466],
  ['tokenizer_config.json', 282682],
  ['special_tokens_map.json', 2194],
  ['added_tokens.json', 34604],
  ['normalizer.json', 52666],
  ['vocab.json', 1036584],
  ['onnx/encoder_model_quantized.onnx', 23201314],
  ['onnx/decoder_model_merged_quantized.onnx', 53693315]
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
      let res = await fetch(url, startAt > 0 ? { headers: { Range: `bytes=${startAt}-` } } : {})
      if (res.status === 416 && startAt > 0) {
        // 本地起点已越过远端文件尾（上游文件被更新/回滚过）：放弃续传，整包重下
        startAt = 0
        res = await fetch(url, {})
      }
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const viaRange = res.status === 206
      if (!viaRange) startAt = 0
      const total = parseInt(res.headers.get('content-length') || '0', 10) + startAt
      const tmp = dest + '.part'
      if (!viaRange && existsSync(tmp)) rmSync(tmp)
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

console.log(`拉取语音识别模型（whisper-base int8） → ${OUT_DIR}`)
for (const [rel, size] of FILES) await fetchFile(rel, size)
console.log('语音模型文件就绪（将随安装包打包）')
