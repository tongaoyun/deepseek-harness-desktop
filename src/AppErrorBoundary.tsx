import { Component, type ErrorInfo, type ReactNode } from 'react'
import { XiaoyinMascot } from './XiaoyinMascot'

interface Props { children: ReactNode }
interface State { failed: boolean }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not surface exception details that may include local paths or business context.
  }

  render() {
    if (!this.state.failed) return this.props.children
    return <main className="fatal-state">
      <XiaoyinMascot size={104} variant="hero" />
      <h1>小胤暂时没有正常加载</h1>
      <p>重新加载会恢复工作台，不会提交当前页面中尚未发送的内容。</p>
      <button onClick={() => window.location.reload()} type="button">重新加载工作台</button>
    </main>
  }
}
