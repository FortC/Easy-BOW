import { BrowserWindow } from 'electron'

/**
 * 任意格式图片 → PNG（主进程侧）。
 *
 * 为什么需要它：Electron nativeImage 只解码 PNG/JPEG，而电商主图（淘宝/天猫 alicdn）
 * 常见 webp（URL 形如 xxx.jpg_.webp），nativeImage.createFromBuffer 直接返回空图 →
 * 「图片解码失败」。这里用一个一次性隐藏窗口的 Chromium 画布解码（Chromium 支持
 * webp/gif/bmp 等全部常见格式），转成 PNG 后回到 nativeImage 管线。
 */

/** 按魔数识别 MIME（dataURL 声明用；识别不出时按 png 试） */
function sniffMime(buf: Buffer): string {
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP')
    return 'image/webp'
  if (buf.length > 4 && buf.slice(0, 4).toString() === 'GIF8') return 'image/gif'
  if (buf.length > 3 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return 'image/png'
}

/** 解码总超时：防盗链/超大图可能让加载或解码永不返回，卡死 Agent 循环（复核 P2） */
const DECODE_TIMEOUT_MS = 15000

/** 用 Chromium 画布把图片解码并转 PNG Buffer（失败抛错，调用方决定占位策略） */
export async function decodeImageToPng(buf: Buffer): Promise<Buffer> {
  if (!buf.length) throw new Error('图片内容为空')
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  try {
    const decode = (async () => {
      // data: 页面无 CSP 限制，data: 图片可直入画布
      await win.loadURL('data:text/html,<meta charset="utf-8"><body></body>')
      return win.webContents.executeJavaScript(
        `(function(b64, mime){ return new Promise(function(res, rej){
            var img = new Image();
            img.onload = function(){
              try {
                var c = document.createElement('canvas');
                c.width = img.naturalWidth || img.width;
                c.height = img.naturalHeight || img.height;
                if (!c.width || !c.height) { rej(new Error('图片尺寸为 0')); return; }
                c.getContext('2d').drawImage(img, 0, 0);
                res(c.toDataURL('image/png'));
              } catch (e) { rej(e); }
            };
            img.onerror = function(){ rej(new Error('图片数据无法解码')); };
            img.src = 'data:' + mime + ';base64,' + b64;
          }); })(${JSON.stringify(buf.toString('base64'))}, ${JSON.stringify(sniffMime(buf))})`,
        true
      )
    })()
    const out = await Promise.race([
      decode,
      new Promise((_r, rej) =>
        setTimeout(() => rej(new Error(`图片解码超时(${DECODE_TIMEOUT_MS / 1000}s)`)), DECODE_TIMEOUT_MS).unref?.()
      )
    ])
    const m = /^data:image\/png;base64,(.+)$/.exec(String(out || ''))
    if (!m) throw new Error('图片转 PNG 失败')
    return Buffer.from(m[1], 'base64')
  } finally {
    try {
      win.destroy()
    } catch {}
  }
}
