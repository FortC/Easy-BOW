import { TriangleAlert } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * 顶层错误边界：任何组件渲染崩溃时不再整窗白屏，
 * 显示错误信息与「恢复界面」按钮（页签与网页在主进程，不受影响）。
 */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[UI 崩溃]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="eb-root">
          <div className="eb-icon"><TriangleAlert size={28} strokeWidth={2} /></div>
          <div className="eb-title">界面渲染出错</div>
          <div className="eb-msg">{String(this.state.error?.message || this.state.error)}</div>
          <button
            className="btn primary"
            onClick={() => {
              this.setState({ error: null })
              location.reload()
            }}
          >
            恢复界面
          </button>
          <div className="eb-tip">页签与网页状态不受影响</div>
        </div>
      )
    }
    return this.props.children
  }
}