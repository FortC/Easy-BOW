/**
 * 生成托盘图标 resources/tray.png（32×32，Windows 托盘标准尺寸）。
 * 纯 Node 实现（光栅化 + PNG 编码），无任何依赖；重跑即再生成：
 *   node scripts/gen-tray-icon.mjs
 *
 * 设计：蓝色圆角底 + 白色「弓」（弓臂弧 + 弓弦）+ 搭弦的箭（呼应 EasyBow 产品名）。
 * 背景 #2E6BE6，前景纯白，小尺寸下轮廓清晰。
 */
import { writeFileSync } from 'fs'
import { deflateSync } from 'zlib'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const SIZE = 32
const SS = 4 // 超采样倍率（抗锯齿）
const BG = [46, 107, 230] // #2E6BE6
const FG = [255, 255, 255]

// —— 几何（32 坐标系） ——
const R = 7 // 圆角半径
const CX = 15.5
const CY = 16
const ARC_IN = 8.2 // 弓臂环内径
const ARC_OUT = 11.2 // 弓臂环外径
const ARC_HALF = (78 * Math.PI) / 180 // 弓臂半张角（0°=+x 向右）
const TIP_R = (ARC_IN + ARC_OUT) / 2
const TIP_X = CX + TIP_R * Math.cos(ARC_HALF)
const TIP_DY = TIP_R * Math.sin(ARC_HALF)
const STRING_HALF_W = 0.8 // 弓弦半宽
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
  if (x < 0 || y < 0 || x > SIZE || y > SIZE) return false
  const dx = x < R ? R - x : x > SIZE - R ? x - (SIZE - R) : 0
  const dy = y < R ? R - y : y > SIZE - R ? y - (SIZE - R) : 0
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
  // 三角形：顶点 HEAD_APEX + 两翼 HEAD_WING（重心坐标同侧判定）
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

// —— 光栅化（RGBA） ——
const raw = Buffer.alloc(SIZE * SIZE * 4)
for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let fg = 0
    let bg = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS
        const y = py + (sy + 0.5) / SS
        if (inForeground(x, y)) fg++
        else if (inRoundedRect(x, y)) bg++
      }
    }
    const total = SS * SS
    const o = (py * SIZE + px) * 4
    const mix = (c, t) => Math.round(c * (t / total) + 255 * ((total - t) / total))
    raw[o] = fg > 0 ? mix(FG[0], fg) : mix(BG[0], bg)
    raw[o + 1] = fg > 0 ? mix(FG[1], fg) : mix(BG[1], bg)
    raw[o + 2] = fg > 0 ? mix(FG[2], fg) : mix(BG[2], bg)
    raw[o + 3] = Math.round(255 * ((fg + bg) / total))
  }
}

// —— PNG 编码（color type 6 RGBA，filter 0） ——
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

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const stride = SIZE * 4
const scanlines = Buffer.alloc((stride + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  scanlines[y * (stride + 1)] = 0
  raw.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(scanlines, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const out = join(dirname(fileURLToPath(import.meta.url)), '../resources/tray.png')
writeFileSync(out, png)
console.log(`已生成 ${out}（${png.length} 字节，${SIZE}x${SIZE} RGBA）`)
