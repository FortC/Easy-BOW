/**
 * 幂等补丁：electron-builder 解压 electron 发行包后立即 rename tmpDir → appOutDir，
 * Windows 上杀毒/索引（Defender 实时扫描刚写出的 electron.exe 等）间歇性持有句柄，
 * rename 直接 EPERM 且构建失败（实测同代码 3 轮 1 败，非代码性泄漏）。
 * 补丁给该 rename 加 EPERM 重试（最多 10 次 × 1s，等扫描放行）。
 * 运行时机：postinstall（npm 重装依赖后需重跑）。
 */
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../node_modules/app-builder-lib/out/util/electronGet.js'
)

const ORIGINAL = `        await fs.rm(dir, { recursive: true, force: true });
        await fs.rename(tmpDir, dir);`

const PATCHED = `        await fs.rm(dir, { recursive: true, force: true });
        // EASYBOW-PATCH: 刚解压完的文件可能仍被杀毒/索引持有句柄，rename 间歇性 EPERM；重试等扫描放行
        for (let ebAttempt = 0; ; ebAttempt++) {
            try {
                await fs.rename(tmpDir, dir);
                break;
            }
            catch (e) {
                if ((e === null || e === void 0 ? void 0 : e.code) !== "EPERM" || ebAttempt >= 10) {
                    throw e;
                }
                builder_util_1.log.warn({ attempt: ebAttempt + 1 }, "rename EPERM (antivirus holding handle?), retrying in 1s");
                await new Promise(r => setTimeout(r, 1000));
            }
        }`

let src = readFileSync(FILE, 'utf8')
if (src.includes('EASYBOW-PATCH')) {
  console.log('electronGet 补丁已存在，跳过')
  process.exit(0)
}
if (!src.includes(ORIGINAL)) {
  console.error('electronGet.js 中未找到目标片段（electron-builder 版本可能已变），补丁未写入')
  process.exit(1)
}
src = src.replace(ORIGINAL, PATCHED)
writeFileSync(FILE, src, 'utf8')
console.log('electronGet.js rename EPERM 重试补丁已写入')
