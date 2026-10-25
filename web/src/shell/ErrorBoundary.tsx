import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "../i18n";

/** An error while drawing the interface shows this, with a way back, instead
 *  of a blank window. Notes are saved as they are typed, so reloading loses
 *  nothing but the open tabs' scroll positions. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("interface error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>{i18n.t("crash.title")}</h1>
        <p>{i18n.t("crash.text")}</p>
        <pre>{String(error.stack ?? error)}</pre>
        <button className="button primary" onClick={() => window.location.reload()}>
          {i18n.t("crash.reload")}
        </button>
      </div>
    );
  }
}
