import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 延迟卸载：为「进场有动画、退出也要有动画」的组件提供退场窗口。
 *
 * 用法：
 *   const [mounted, closing] = useDelayedUnmount(open, 160)
 *   return mounted ? <div className={closing ? 'x is-closing' : 'x'} /> : null
 *
 * @param open 是否处于打开状态
 * @param ms  退场动画时长（与 CSS 中 fadeOut / popOut 的时长一致）
 */
export function useDelayedUnmount(open: boolean, ms = 160): [boolean, boolean] {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    let timer: number | undefined
    if (open) {
      setMounted(true)
      setClosing(false)
    } else if (mounted) {
      setClosing(true)
      timer = window.setTimeout(() => {
        setMounted(false)
        setClosing(false)
      }, ms)
    }
    return () => window.clearTimeout(timer)
  }, [open, ms, mounted])

  return [mounted, closing]
}

interface ModalFocusOptions {
  /** 点击遮罩是否关闭（设置弹窗传 false，避免误触丢失正在编辑的配置） */
  closeOnBackdrop?: boolean
  /** Esc 是否关闭 */
  closeOnEsc?: boolean
}

interface ModalFocus {
  /** 是否处于退场阶段（给容器加 is-closing 类） */
  closing: boolean
  /** 统一的关闭入口：先播退场动画，再通知外部卸载 */
  requestClose: () => void
  /** 遮罩点击处理（已按closeOnBackdrop 语义判好，可直接挂到 onClick） */
  onBackdropClick: (e: React.MouseEvent<HTMLDivElement>) => void
}

/**
 * 弹窗焦点管理：打开时聚焦容器、Tab 循环锁在弹窗内、关闭时把焦点归还给触发元素，
 * 并统一接管 Esc 关闭。5 个弹窗共用，保证键盘行为完全一致。
 */
export function useModalFocus(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
  options: ModalFocusOptions = {}
): ModalFocus {
  const { closeOnBackdrop = true, closeOnEsc = true } = options
  const [closing, setClosing] = useState(false)
  const restoreRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  const requestClose = useCallback(() => {
    setClosing((c) => {
      if (c) return c
      window.setTimeout(() => {
        setClosing(false)
        closeRef.current()
      }, 150)
      return true
    })
  }, [])

  useEffect(() => {
    if (!active) return
    // 记住打开前的焦点，关闭后归还（否则焦点会丢到 body，键盘用户失去位置）
    restoreRef.current = document.activeElement as HTMLElement | null
    const t = window.setTimeout(() => ref.current?.focus(), 0)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && closeOnEsc) {
        e.stopPropagation()
        requestClose()
        return
      }
      if (e.key !== 'Tab') return
      const root = ref.current
      if (!root) return
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null)
      if (!items.length) {
        e.preventDefault()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || cur === root)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey, true)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey, true)
      restoreRef.current?.focus?.()
    }
  }, [active, closeOnEsc, requestClose])

  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (closeOnBackdrop && e.target === e.currentTarget) requestClose()
    },
    [closeOnBackdrop, requestClose]
  )

  return { closing, requestClose, onBackdropClick }
}