import { Component, type ReactNode } from "react";
import { Brand } from "./components.tsx";
export class Boundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    if (this.state.failed)
      return (
        <main className="loading-page">
          <Brand />
          <h1 style={{ fontSize: 24, marginTop: 35 }}>
            This page could not open.
          </h1>
          <p>
            Reload the extension page to try again. Your archive stays stored in
            this browser.
          </p>
          <button className="primary" onClick={() => location.reload()}>
            Reload page
          </button>
        </main>
      );
    return this.props.children;
  }
}
