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
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 14,
            background: '#f5f6f8',
            color: '#333',
            fontFamily: 'system-ui, sans-serif',
            padding: 40,
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: 40 }}>⚠</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>界面渲染出错</div>
          <div style={{ fontSize: 12, color: '#888', maxWidth: 520, wordBreak: 'break-all' }}>
            {String(this.state.error?.message || this.state.error)}
          </div>
          <button
            style={{
              padding: '8px 22px',
              borderRadius: 8,
              border: '1px solid #4f86da',
              background: '#4f86da',
              color: '#fff',
              fontSize: 13,
              cursor: 'pointer'
            }}
            onClick={() => {
              this.setState({ error: null })
              location.reload()
            }}
          >
            恢复界面
          </button>
          <div style={{ fontSize: 11, color: '#aaa' }}>页签与网页状态不受影响</div>
        </div>
      )
    }
    return this.props.children
  }
}
