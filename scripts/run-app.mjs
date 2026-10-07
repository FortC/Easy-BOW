/**
 * Electron 应用启动器：剥离 ELECTRON_RUN_AS_NODE 等环境干扰后启动。
 * 外层 shell（CI/代理工具）可能带着 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化为纯
 * Node 运行（app.setAboutPanelOptions 等 API 全部缺失，自测必挂）。
 * 用法：node scripts/run-app.mjs <args…>（如 out/main/index.js --selftest）
 */
import { spawn } from 'child_process'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const electronPath = require('electron') // 普通 Node 下解析为 Electron 可执行文件路径

delete process.env.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: process.env
})
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (e) => {
  console.error('[run-app] 启动失败:', e.message)
  process.exit(1)
})
