// 截图质检：验证图片含 EasyBow 特征色（主蓝 #3370ff 一带）且尺寸合理，防止截到别的窗口
import sharp from 'sharp'

const files = process.argv.slice(2)
const okAll = []
for (const f of files) {
  const img = sharp(f)
  const meta = await img.metadata()
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true })
  let accentBlue = 0 // 主题蓝（±40 距离内）像素数
  let nonWhite = 0
  const target = [0x33, 0x70, 0xff]
  for (let i = 0; i < data.length; i += info.channels * 7) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (Math.abs(r - target[0]) < 45 && Math.abs(g - target[1]) < 45 && Math.abs(b - target[2]) < 45) accentBlue++
    if (r < 235 || g < 235 || b < 235) nonWhite++
  }
  const total = Math.round(data.length / (info.channels * 7))
  const pct = (n) => ((n / total) * 100).toFixed(2) + '%'
  const ok = meta.width >= 900 && accentBlue > total * 0.0005 && nonWhite > total * 0.15
  okAll.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${f} ${meta.width}x${meta.height} 主题蓝=${pct(accentBlue)} 非白=${pct(nonWhite)}`)
}
process.exit(okAll.every(Boolean) ? 0 : 1)
