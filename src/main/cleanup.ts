/**
 * 退出清理中心。
 *
 * 背景（用户反馈「关闭后无法再打开」）：Electron 窗口关了 ≠ 进程真的干净退出 ——
 * CDP debugger 会话、覆盖层/页签的 WebContentsView、OCR 隐藏窗口、定时任务 interval、
 * 心跳看门狗都会各自拽着事件循环，留下残留在后台的 EasyBow.exe（下次启动撞单实例锁/缓存锁）。
 *
 * 做法：所有长生命周期资源在这里登记，app 退出前统一释放，并给一个强制退出的保险丝。
 */
type CleanupFn = () => void | Promise<void>

const fns: CleanupFn[] = []
let running = false

/** 登记一个清理动作（后登记的先执行：外层资源先卸） */
export function onCleanup(fn: CleanupFn): void {
  fns.push(fn)
}

/** 执行全部清理（幂等；单项抛错不影响其它项） */
export async function runCleanup(): Promise<void> {
  if (running) return
  running = true
  for (let i = fns.length - 1; i >= 0; i--) {
    try {
      await fns[i]()
    } catch (e) {
      console.error('[easybow] 清理项失败:', e)
    }
  }
  fns.length = 0
}

/**
 * 强制退出保险丝：清理跑完（或超时）后无条件结束进程。
 * 只针对「用户已明确关闭窗口」的场景——避免残留句柄让应用假退出。
 */
export function forceExitAfter(ms: number, code = 0): void {
  const t = setTimeout(() => {
    try {
      process.exit(code)
    } catch {
      // 忽略
    }
  }, ms)
  try {
    ;(t as unknown as { unref?: () => void }).unref?.()
  } catch {}
}
