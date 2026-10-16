/**
 * 从设计稿导出图生成干净 logo 母版 assets/logo.png。
 *   node scripts/build-logo.mjs <设计稿导出.png>
 *
 * 设计稿为 2048×2048 圆角方阵（右下角带「豆包AI生成」半透明水印、四周白色画布）：
 *   1. 水印区背景重建——水印 bbox 内：圆角方阵内按二次曲面拟合外推补回暗红扇面，方阵外补白；
 *   2. 紧裁圆角方阵（去白边）；
 *   3. 等比缩放 1024²；
 *   4. 按设计圆角做 alpha 蒙版（圆角外透明、向内偏 2px 防白边）。
 *
 * 几何常量按 2048 设计空间标定：方阵 (35,34)-(2013,2013)，圆角 R=262；
 * 水印 bbox (1660,1885)-(2048,2048)，L 形干净采样窗见 WIN。
 * 换新设计稿时重新标定这些常量即可。
 *
 * 依赖 sharp（@huggingface/transformers 的传递依赖，node_modules 内已有）。
 */
import sharp from 'sharp'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const srcPath = process.argv[2]
if (!srcPath) {
  console.error('用法：node scripts/build-logo.mjs <设计稿导出.png>')
  process.exit(1)
}

/* —— 设计稿几何（2048 设计空间） —— */
const DESIGN_SPACE = 2048
const RECT = { x0: 35, y0: 34, x1: 2013, y1: 2013 } // 圆角方阵外接矩形
const CORNER_R = 262 // 圆角半径
const WM = { x0: 1660, y0: 1885 } // 水印 bbox（到画布右下角）
const OUT = 1024 // 母版输出边长
const MASK_INSET = 2 // alpha 蒙版向内偏移（输出像素），防白边

/** 圆角方阵成员判定（设计空间坐标） */
function inDesign(x, y) {
  const { x0, y0, x1, y1 } = RECT
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const dx = x < x0 + CORNER_R ? x0 + CORNER_R - x : x > x1 - CORNER_R ? x - (x1 - CORNER_R) : 0
  const dy = y < y0 + CORNER_R ? y0 + CORNER_R - y : y > y1 - CORNER_R ? y - (y1 - CORNER_R) : 0
  return dx * dx + dy * dy <= CORNER_R * CORNER_R
}

/** 圆角方阵成员判定（输出空间坐标，蒙版用） */
function inMask(x, y) {
  const x0 = MASK_INSET
  const y0 = MASK_INSET
  const x1 = OUT - MASK_INSET
  const y1 = OUT - MASK_INSET
  const r = (CORNER_R / (RECT.x1 - RECT.x0)) * OUT - MASK_INSET
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0
  const dy = y < y0 + r ? y0 + r - y : y > y1 - r ? y - (y1 - r) : 0
  return dx * dx + dy * dy <= r * r
}

const { data: raw, info } = await sharp(srcPath).raw().toBuffer({ resolveWithObject: true })
const W = info.width
const H = info.height
const CH = info.channels
if (CH < 3) throw new Error(`仅支持 RGB/RGBA 设计稿，实际 channels=${CH}`)
const k = W / DESIGN_SPACE // 设计空间 → 实际像素比例
const at = (x, y, c) => raw[(y * W + x) * CH + c]

/* —— 1. 水印区背景重建 ——
 * 扇面是平滑但带曲率的渐变：用「左窗 + 上窗」L 形采样做二次曲面最小二乘
 * （双向约束斜率，长距外推不漂移），补区左缘/上缘 48px smoothstep 羽化衔接。
 * 方阵外像素补白（蒙版阶段会变透明，白色仅为过渡一致）。 */
const wmX0 = Math.round(WM.x0 * k)
const wmY0 = Math.round(WM.y0 * k)
const FEATHER = Math.round(48 * k)
const WIN = [
  { x0: 1520, x1: 1655, y0: 1885, y1: 2012 }, // 左窗：水印左侧同扇面
  { x0: 1660, x1: 1990, y0: 1815, y1: 1880 } // 上窗：水印上方同扇面
].map((w) => ({
  x0: Math.round(w.x0 * k),
  x1: Math.round(w.x1 * k),
  y0: Math.round(w.y0 * k),
  y1: Math.round(w.y1 * k)
}))

// 二次曲面 v = c0 + c1·u + c2·w + c3·u² + c4·u·w + c5·w²
// 坐标中心化/尺度化（u=(x-cx)/s, w=(y-cy)/s）保证正规方程良态
const CX = 1830 * k
const CY = 1910 * k
const SC = 300 * k
const basis = (x, y) => {
  const u = (x - CX) / SC
  const w = (y - CY) / SC
  return [1, u, w, u * u, u * w, w * w]
}

const coef = []
{
  const N = 6
  const ATA = Array.from({ length: N }, () => new Array(N).fill(0))
  const ATb = Array.from({ length: N }, () => [0, 0, 0])
  for (const win of WIN) {
    for (let y = win.y0; y <= win.y1; y++) {
      for (let x = win.x0; x <= win.x1; x++) {
        if (!inDesign(x, y)) continue
        const f = basis(x, y)
        for (let i = 0; i < N; i++) {
          for (let j = 0; j < N; j++) ATA[i][j] += f[i] * f[j]
          for (let c = 0; c < 3; c++) ATb[i][c] += f[i] * at(x, y, c)
        }
      }
    }
  }
  for (let c = 0; c < 3; c++) {
    // 高斯消元解 ATA·coef = ATb
    const M = ATA.map((row, i) => [...row, ATb[i][c]])
    for (let i = 0; i < N; i++) {
      let p = i
      for (let j = i + 1; j < N; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j
      ;[M[i], M[p]] = [M[p], M[i]]
      for (let j = 0; j < N; j++) {
        if (j === i) continue
        const f = M[j][i] / M[i][i]
        for (let q = i; q <= N; q++) M[j][q] -= f * M[i][q]
      }
    }
    coef.push(M.map((row, i) => row[N] / row[i]).slice(0, N))
  }
}
const fitAt = (x, y, c) => {
  const f = basis(x, y)
  let v = 0
  for (let i = 0; i < 6; i++) v += coef[c][i] * f[i]
  return Math.max(0, Math.min(255, Math.round(v)))
}

const smoothstep = (t) => {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}

for (let y = wmY0 - FEATHER; y < H; y++) {
  if (y < 0) continue
  for (let x = wmX0 - FEATHER; x < W; x++) {
    const o = (y * W + x) * CH
    if (inDesign(x, y)) {
      // 左缘、上缘羽化带内渐变混合真实像素与曲面外推值（取较大权重，双轴无接缝）
      const wx = smoothstep((x - (wmX0 - FEATHER)) / FEATHER)
      const wy = smoothstep((y - (wmY0 - FEATHER)) / FEATHER)
      const w = Math.max(wx, wy)
      for (let c = 0; c < 3; c++) {
        raw[o + c] = Math.round(at(x, y, c) * (1 - w) + fitAt(x, y, c) * w)
      }
    } else {
      raw[o] = 255
      raw[o + 1] = 255
      raw[o + 2] = 255
    }
    if (CH >= 4) raw[o + 3] = 255
  }
}

/* —— 2~3. 紧裁圆角方阵 → 等比缩放 —— */
const crop = {
  left: Math.round(RECT.x0 * k),
  top: Math.round(RECT.y0 * k),
  width: Math.round((RECT.x1 - RECT.x0) * k),
  height: Math.round((RECT.y1 - RECT.y0) * k)
}
const rgb = await sharp(raw, { raw: { width: W, height: H, channels: CH } })
  .extract(crop)
  .resize(OUT, OUT, { kernel: 'lanczos3' })
  .removeAlpha()
  .raw()
  .toBuffer()

/* —— 4. 圆角 alpha 蒙版（4×4 超采样抗锯齿） —— */
const alpha = Buffer.alloc(OUT * OUT)
const SS = 4
for (let py = 0; py < OUT; py++) {
  for (let px = 0; px < OUT; px++) {
    let hit = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        if (inMask(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS)) hit++
      }
    }
    alpha[py * OUT + px] = Math.round((255 * hit) / (SS * SS))
  }
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '../assets')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'logo.png')
await sharp(rgb, { raw: { width: OUT, height: OUT, channels: 3 } })
  .joinChannel(alpha, { raw: { width: OUT, height: OUT, channels: 1 } })
  .png({ compressionLevel: 9 })
  .toFile(out)
console.log(`已生成 ${out}（${OUT}×${OUT} RGBA，源 ${srcPath}）`)
