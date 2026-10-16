/**
 * 生成应用图标 build/icon.ico（Windows 多尺寸：16/24/32/48/64 BMP-DIB + 256 PNG）
 * 与窗口图标 resources/app-icon.png（256²）。纯 Node 实现（scripts/lib/png-raster.mjs），
 * 无外部依赖；重跑即再生成：
 *   node scripts/gen-app-icon.mjs
 *
 * 设计与托盘图标同源：assets/logo.png（1024² RGBA 母版，由 build-logo.mjs 从
 * 设计稿生成——橙红几何扇面 + 黑色圆角方块「EB」字标，圆角外透明）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { decodePng, encodeDib, encodeIco, encodePng, resizeRgba } from './lib/png-raster.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const logo = decodePng(readFileSync(join(root, 'assets/logo.png')))

/* —— ICO：小尺寸 BMP-DIB + 256 PNG —— */
const SIZES_DIB = [16, 24, 32, 48, 64]
const SIZE_PNG = 256
const entries = []
for (const s of SIZES_DIB) entries.push({ size: s, data: encodeDib(s, resizeRgba(logo.data, logo.width, logo.height, s, s)), png: false })
const png256 = encodePng(SIZE_PNG, SIZE_PNG, resizeRgba(logo.data, logo.width, logo.height, SIZE_PNG, SIZE_PNG))
entries.push({ size: SIZE_PNG, data: png256, png: true })

mkdirSync(join(root, 'build'), { recursive: true })
const ico = encodeIco(entries)
const outIco = join(root, 'build/icon.ico')
writeFileSync(outIco, ico)
console.log(`已生成 ${outIco}（${ico.length} 字节，尺寸 ${[...SIZES_DIB, SIZE_PNG].join('/')}）`)

/* —— 窗口图标（dev/打包窗口标题栏与任务栏，PNG 保留圆角 alpha） —— */
mkdirSync(join(root, 'resources'), { recursive: true })
const outPng = join(root, 'resources/app-icon.png')
writeFileSync(outPng, png256)
console.log(`已生成 ${outPng}（${png256.length} 字节，${SIZE_PNG}×${SIZE_PNG} RGBA）`)
