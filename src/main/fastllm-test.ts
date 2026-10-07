/**
 * fastllm 诊断模式（--fastllm-test）：不依赖 UI，分阶段加载本地推理链路，
 * 精确定位打包版「下载并加载本地模型」闪退在哪一步。
 * 阶段：onnxruntime-node → sharp → @huggingface/tokenizers → @huggingface/transformers
 *      → FastLlm.init()（真实下载+加载+预热）→ decide() 基准
 * 运行：electron out/main/index.js --fastllm-test   或打包版 EasyBow.exe --fastllm-test
 */
import { app } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { FastLlm } from './fastllm'

const TRACE_FILE = join(process.cwd(), 'fastllm-test-trace.log')

function trace(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}`
  console.log(line)
  try {
    appendFileSync(TRACE_FILE, line + '\n')
  } catch {}
}

export async function runFastllmTest(exit: (code: number) => void): Promise<void> {
  trace('== fastllm-test 开始 ==')
  trace(
    `electron=${process.versions.electron} node=${process.versions.node} arch=${process.arch} ` +
      `exec=${process.execPath} cwd=${process.cwd()} resourcesPath=${process.resourcesPath}`
  )
  trace(`nodeModulesPath: ${(require('module') as any).globalPaths?.join?.(';') || ''}`)

  process.on('uncaughtException', (e) => trace(`!! uncaughtException: ${e?.message} @ ${(e?.stack || '').split('\n')[1] || ''}`))
  process.on('unhandledRejection', (r: any) => trace(`!! unhandledRejection: ${r?.message || String(r)}`))

  let failed = false
  const stage = async (name: string, fn: () => Promise<unknown>, optional = false): Promise<boolean> => {
    trace(`--> ${name}`)
    const t0 = Date.now()
    try {
      const r = await fn()
      trace(`    ${name} OK (${Date.now() - t0}ms)${r ? ` → ${String(r).slice(0, 120)}` : ''}`)
      return true
    } catch (e: any) {
      trace(`    ${name} FAIL (${Date.now() - t0}ms): ${e?.message || e}`)
      if (!optional) failed = true
      return false
    }
  }

  await stage('s1 import onnxruntime-node', async () => {
    const ort: any = await import('onnxruntime-node')
    return `ort version=${ort.env?.version || ort.default?.env?.version || '?'}`
  })

  await stage(
    's2 import sharp（可选，图像预处理用）',
    async () => {
      const sharp: any = await import('sharp')
      return `sharp ${sharp.versions ? JSON.stringify(sharp.versions) : 'loaded'}`
    },
    true
  )

  await stage(
    's3 import @huggingface/tokenizers（可选）',
    async () => {
      const tk: any = await import('@huggingface/tokenizers')
      return `tokenizers keys=${Object.keys(tk).slice(0, 8).join(',')}`
    },
    true
  )

  // 注意：不在这里单独 import @huggingface/transformers——它初始化时读取
  // globalThis[Symbol.for('onnxruntime')]（FastLlm.init 注入 WASM 后端），
  // 先 import 会让原生 onnxruntime-node 分支被模块缓存，注入失效。
  const llm = new FastLlm(() => undefined)
  await stage('s4 FastLlm.init()（注入 WASM + 内置模型加载 + 预热）', () => llm.init())

  if (llm.isReady()) {
    await stage('s5 decide() 基准', () =>
      llm.decide('测试', '请输出 {"ok":1}', 32).then((r) => `gen=${llm.genMs}ms out=${String(r).slice(-80)}`)
    )
  } else {
    trace(`!! init 未就绪：state=${llm.status.state} detail=${llm.status.detail}`)
    failed = true
  }

  trace(`== fastllm-test 结束 ${failed ? 'FAIL' : 'PASS'} ==`)
  exit(failed ? 1 : 0)
}

/** 供 index.ts 判定是否进入诊断模式 */
export const isFastllmTest = (argv: string[]): boolean => argv.includes('--fastllm-test')
