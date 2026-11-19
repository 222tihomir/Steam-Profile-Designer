import { Component, type ErrorInfo, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Last-resort UI boundary.
//
// When something throws while React renders, React tries to build its own
// component stack. If that fails (it does on some Steam pages), the console and
// the error panel only show "Error generating stack: …" and the real message is
// lost. Catching the error here keeps the message and the stack readable and
// shows them instead of leaving a blank panel.
// ---------------------------------------------------------------------------

interface Props {
  children: ReactNode
}

interface State {
  error: unknown
  componentStack: string
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown }
    const name = typeof value.name === 'string' ? value.name : 'Ошибка'
    const message = typeof value.message === 'string' ? value.message : ''
    if (message) return `${name}: ${message}`
  }
  return String(error)
}

export class Boundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { error, componentStack: '' }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Log the raw values: they are what the browser console can print reliably,
    // even when React cannot build a stack for them.
    console.error('[SPD] ошибка интерфейса:', error)
    if (error instanceof Error && error.stack) console.error(error.stack)
    if (info.componentStack) console.error(info.componentStack)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  render() {
    if (this.state.error === null) return this.props.children
    const error = this.state.error
    const stack = error instanceof Error ? error.stack ?? '' : ''
    return (
      <div className="spd-root">
        <div className="spd-boundary" role="alert">
          <div className="spd-boundary-title">Steam Profile Designer: ошибка</div>
          <div className="spd-boundary-message">{describe(error)}</div>
          <pre className="spd-boundary-stack">{[stack, this.state.componentStack].filter(Boolean).join('\n')}</pre>
          <div className="spd-row" style={{ gap: 8 }}>
            <button className="primary" type="button" onClick={() => window.location.reload()}>
              Перезагрузить страницу
            </button>
            <button type="button" onClick={() => this.setState({ error: null, componentStack: '' })}>
              Вернуться в редактор
            </button>
          </div>
        </div>
      </div>
    )
  }
}
