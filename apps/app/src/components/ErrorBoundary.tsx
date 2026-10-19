import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="app-loading"><p className="error" role="alert">畫面載入失敗，請重新整理。</p><button className="secondary" onClick={() => location.reload()}>重新整理</button></main>;
    return this.props.children;
  }
}
