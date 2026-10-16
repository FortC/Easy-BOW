/**
 * 生成托盘图标 resources/tray.png（32×32，Windows 托盘标准尺寸）。
 * 纯 Node 实现（scripts/lib/png-raster.mjs），无外部依赖；重跑即再生成：
 *   node scripts/gen-tray-icon.mjs
 *
 * 设计与应用图标同源：assets/logo.png（1024² RGBA 母版，由 build-logo.mjs 从
 * 设计稿生成——橙红几何扇面 + 黑色圆角方块「EB」字标，圆角外透明）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { decodePng, encodePng, resizeRgba } from './lib/png-raster.mjs'

const SIZE = 32
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const logo = decodePng(readFileSync(join(root, 'assets/logo.png')))
const png = encodePng(SIZE, SIZE, resizeRgba(logo.data, logo.width, logo.height, SIZE, SIZE))

mkdirSync(join(root, 'resources'), { recursive: true })
const out = join(root, 'resources/tray.png')
writeFileSync(out, png)
console.log(`已生成 ${out}（${png.length} 字节，${SIZE}×${SIZE} RGBA）`)
