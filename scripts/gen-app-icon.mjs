/**
 * 生成应用图标 build/icon.ico（Windows 多尺寸：16/24/32/48/64 BMP-DIB + 256 PNG）。
 * 纯 Node 实现（光栅化 + ICO 编码），无依赖；重跑即再生成：
 *   node scripts/gen-app-icon.mjs
 *
 * 设计与托盘图标同源（resources/tray.png，由 gen-tray-icon.mjs 生成）：
 * 蓝色圆角方底 + 白色弓（弓臂弧 + 弓弦）+ 搭弦的箭，线面结合偏 Lucide 风。
 */
import { mkdirSync, writeFileSync } from 'fs'
import { deflateSync } from 'zlib'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/* —— 设计坐标（32 单位设计空间，任意尺寸等比缩放） —— */
const DESIGN = 32
const R = 7
const BG = [46, 107, 230]
const FG = [255, 255, 255]
const CX = 15.5
const CY = 16
const ARC_IN = 8.2
const ARC_OUT = 11.2
const ARC_HALF = (78 * Math.PI) / 180
const TIP_R = (ARC_IN + ARC_OUT) / 2
const TIP_X = CX + TIP_R * Math.cos(ARC_HALF)
const TIP_DY = TIP_R * Math.sin(ARC_HALF)
const STRING_HALF_W = 0.8
const ARROW_Y = CY
const ARROW_X0 = 5
const ARROW_X1 = 26.5
const ARROW_HALF_W = 0.85
const HEAD_APEX = [28.5, ARROW_Y]
const HEAD_WING = [
  [24.2, ARROW_Y - 2.9],
  [24.2, ARROW_Y + 2.9]
]

function inRoundedRect(x, y) {
  if (x < 0 || y < 0 || x > DESIGN || y > DESIGN) return false
  const dx = x < R ? R - x : x > DESIGN - R ? x - (DESIGN - R) : 0
  const dy = y < R ? R - y : y > DESIGN - R ? y - (DESIGN - R) : 0
  return dx * dx + dy * dy <= R * R
}

function inArc(x, y) {
  const dx = x - CX
  const dy = y - CY
  const r2 = dx * dx + dy * dy
  if (r2 < ARC_IN * ARC_IN || r2 > ARC_OUT * ARC_OUT) return false
  return Math.abs(Math.atan2(dy, dx)) <= ARC_HALF
}

function inString(x, y) {
  if (y < CY - TIP_DY || y > CY + TIP_DY) return false
  return Math.abs(x - TIP_X) <= STRING_HALF_W
}

function inArrowShaft(x, y) {
  if (x < ARROW_X0 || x > ARROW_X1) return false
  return Math.abs(y - ARROW_Y) <= ARROW_HALF_W
}

function inArrowHead(x, y) {
  const [ax, ay] = HEAD_APEX
  const [bx, by] = HEAD_WING[0]
  const [cx, cy] = HEAD_WING[1]
  const s1 = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
  const s2 = (cx - bx) * (y - by) - (cy - by) * (x - bx)
  const s3 = (ax - cx) * (y - cy) - (ay - cy) * (x - cx)
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)
}

function inForeground(x, y) {
  return inArc(x, y) || inString(x, y) || inArrowShaft(x, y) || inArrowHead(x, y)
}

/** 渲染 size×size RGBA（4×4 超采样抗锯齿） */
function render(size) {
  const raw = Buffer.alloc(size * size * 4)
  const SS = 4
  const scale = size / DESIGN
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let fg = 0
      let bg = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / scale
          const y = (py + (sy + 0.5) / SS) / scale
          if (inForeground(x, y)) fg++
          else if (inRoundedRect(x, y)) bg++
        }
      }
      const total = SS * SS
      const o = (py * size + px) * 4
      const mix = (c, t) => Math.round(c * (t / total) + 255 * ((total - t) / total))
      raw[o] = fg > 0 ? mix(FG[0], fg) : mix(BG[0], bg)
      raw[o + 1] = fg > 0 ? mix(FG[1], fg) : mix(BG[1], bg)
      raw[o + 2] = fg > 0 ? mix(FG[2], fg) : mix(BG[2], bg)
      raw[o + 3] = Math.round(255 * ((fg + bg) / total))
    }
  }
  return raw
}

/* —— PNG 编码 —— */
function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = size * 4
  const scanlines = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    scanlines[y * (stride + 1)] = 0
    raw.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* —— BMP DIB（32bpp BGRA 自底向上 + AND 掩码）—— */
function encodeDib(size, raw) {
  const imgSize = size * size * 4
  const maskStride = Math.ceil(size / 32) * 4
  const maskSize = maskStride * size
  const buf = Buffer.alloc(40 + imgSize + maskSize)
  buf.writeUInt32LE(40, 0) // BITMAPINFOHEADER
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8) // 高度×2（含 AND 掩码）
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(imgSize + maskSize, 20)
  // 像素自底向上、BGRA
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4
    for (let x = 0; x < size; x++) {
      const s = src + x * 4
      const d = 40 + (y * size + x) * 4
      buf[d] = raw[s + 2]
      buf[d + 1] = raw[s + 1]
      buf[d + 2] = raw[s]
      buf[d + 3] = raw[s + 3]
    }
  }
  // AND 掩码：不透明位清 0 即可（1=透明，现代 shell 用 alpha 通道）
  return buf
}

/* —— ICO 组装 —— */
const SIZES_DIB = [16, 24, 32, 48, 64]
const SIZE_PNG = 256
const entries = []
for (const s of SIZES_DIB) entries.push({ size: s, data: encodeDib(s, render(s)), png: false })
entries.push({ size: SIZE_PNG, data: encodePng(SIZE_PNG, render(SIZE_PNG)), png: true })

const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // icon
header.writeUInt16LE(entries.length, 4)
const dir = Buffer.alloc(16 * entries.length)
let offset = 6 + dir.length
entries.forEach((e, i) => {
  const o = i * 16
  dir[o] = e.size >= 256 ? 0 : e.size
  dir[o + 1] = e.size >= 256 ? 0 : e.size
  dir[o + 2] = 0
  dir[o + 3] = 0
  dir.writeUInt16LE(1, o + 4)
  dir.writeUInt16LE(32, o + 6)
  dir.writeUInt32LE(e.data.length, o + 8)
  dir.writeUInt32LE(offset, o + 12)
  offset += e.data.length
})
const ico = Buffer.concat([header, dir, ...entries.map((e) => e.data)])

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../build')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'icon.ico')
writeFileSync(out, ico)
console.log(`已生成 ${out}（${ico.length} 字节，尺寸 ${[...SIZES_DIB, SIZE_PNG].join('/')}）`)
