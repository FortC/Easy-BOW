/**
 * 纯 Node PNG/ICO 光栅工具（无外部依赖）：8bit RGB/RGBA 非隔行 PNG 解码、
 * 面积平均等比缩放（预乘 alpha 防白边）、PNG/ICO 编码。
 * 供 gen-app-icon.mjs / gen-tray-icon.mjs 生成图标使用。
 */
import { deflateSync, inflateSync } from 'zlib'

/* —— PNG 解码（color type 2=RGB / 6=RGBA，bit depth 8，非隔行） —— */
export function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('不是 PNG 文件')
  let off = 8
  let ihdr = null
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.slice(off + 4, off + 8).toString('ascii')
    const body = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') ihdr = body
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (!ihdr) throw new Error('缺少 IHDR')
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error(`不支持的 PNG 格式：bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`)
  }
  const ch = colorType === 6 ? 4 : 3
  const bpp = ch
  const stride = width * ch
  const raw = inflateSync(Buffer.concat(idat))
  // 反滤波（filter 0~4）
  const pix = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const out = pix.subarray(y * stride, (y + 1) * stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0
      const b = y > 0 ? pix[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? pix[(y - 1) * stride + x - bpp] : 0
      let v
      switch (filter) {
        case 0: v = row[x]; break
        case 1: v = row[x] + a; break
        case 2: v = row[x] + b; break
        case 3: v = row[x] + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v = row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`未知 PNG filter=${filter}`)
      }
      out[x] = v & 0xff
    }
  }
  // 归一到 RGBA
  if (ch === 4) return { width, height, data: pix }
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = pix[i * 3]
    rgba[i * 4 + 1] = pix[i * 3 + 1]
    rgba[i * 4 + 2] = pix[i * 3 + 2]
    rgba[i * 4 + 3] = 255
  }
  return { width, height, data: rgba }
}

/* —— 面积平均缩放（预乘 alpha，杜绝透明边白边） —— */
export function resizeRgba(src, sw, sh, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = (dy * sh) / dh
    const sy1 = ((dy + 1) * sh) / dh
    const y0 = Math.floor(sy0)
    const y1 = Math.min(sh, Math.ceil(sy1))
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = (dx * sw) / dw
      const sx1 = ((dx + 1) * sw) / dw
      const x0 = Math.floor(sx0)
      const x1 = Math.min(sw, Math.ceil(sx1))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let wsum = 0
      for (let sy = y0; sy < y1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0)
        for (let sx = x0; sx < x1; sx++) {
          const w = (Math.min(sx + 1, sx1) - Math.max(sx, sx0)) * wy
          const o = (sy * sw + sx) * 4
          const al = src[o + 3]
          r += src[o] * al * w
          g += src[o + 1] * al * w
          b += src[o + 2] * al * w
          a += al * w
          wsum += w
        }
      }
      const d = (dy * dw + dx) * 4
      if (a > 0) {
        dst[d] = Math.round(r / a)
        dst[d + 1] = Math.round(g / a)
        dst[d + 2] = Math.round(b / a)
      }
      dst[d + 3] = Math.round(a / wsum)
    }
  }
  return dst
}

/* —— PNG 编码（color type 6 RGBA，filter 0） —— */
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

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const stride = width * 4
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    scanlines[y * (stride + 1)] = 0
    rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* —— BMP DIB（32bpp BGRA 自底向上 + AND 掩码）—— */
export function encodeDib(size, rgba) {
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
      buf[d] = rgba[s + 2]
      buf[d + 1] = rgba[s + 1]
      buf[d + 2] = rgba[s]
      buf[d + 3] = rgba[s + 3]
    }
  }
  // AND 掩码：不透明位清 0 即可（1=透明，现代 shell 用 alpha 通道）
  return buf
}

/* —— ICO 组装（entries: { size, data, png }[]） —— */
export function encodeIco(entries) {
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
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)])
}
