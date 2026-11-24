import { Component, type ReactNode, type ErrorInfo } from 'react'

/** A dev hot reload or Operations render failure must not take the Library down. */
export class OperationsBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Operations] ${error.stack ?? error.message}\n${info.componentStack}`)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <div role="alert" className="rounded p-2 text-sm text-destructive">
      Operations could not be displayed. Your recordings are still available.
      <button type="button" className="ms-2 rounded px-2 py-1 underline focus-visible:ring-2" onClick={() => this.setState({ failed: false })}>Try again</button>
    </div>
  }
}
