/**
 * 原子写盘（复核 P1-10）：直写 writeFileSync 在崩溃/断电/磁盘满时会留下半成品 JSON，
 * 下次读取 JSON.parse 失败静默回退默认值——用户全部设置/定时任务/经验库就此丢失。
 * 统一「写同目录 .tmp → rename 原子替换」；Windows 上 rename 对被占用目标可能 EPERM，短暂重试。
 */
import { writeFileSync, renameSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

let tmpSeq = 0

export function writeFileAtomic(target: string, data: string | Buffer): void {
  const tmp = join(dirname(target), `.${target.split(/[\\/]/).pop() || 'file'}.tmp${process.pid}-${++tmpSeq}`)
  try {
    writeFileSync(tmp, data)
    try {
      renameSync(tmp, target)
    } catch (e: any) {
      if (String(e?.code) === 'EPERM' || String(e?.code) === 'EACCES') {
        // 目标被杀毒/索引器短暂占用：等 60ms 重试一次，仍失败则回退直写（不丢数据优于不原子）
        const t0 = Date.now()
        while (Date.now() - t0 < 300) {
          try {
            renameSync(tmp, target)
            return
          } catch {
            /* spin */
          }
          const wait = Date.now() + 60
          while (Date.now() < wait) {
            /* busy wait 60ms */
          }
        }
        writeFileSync(target, data)
        try {
          unlinkSync(tmp)
        } catch {}
      } else {
        throw e
      }
    }
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw e
  }
}

/** JSON 落盘快捷方式（2 空格缩进，与既有文件格式一致） */
export function writeJsonAtomic(target: string, value: unknown): void {
  writeFileAtomic(target, JSON.stringify(value, null, 2))
}
