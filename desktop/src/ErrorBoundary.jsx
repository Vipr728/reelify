/* ============ REELIFY — error boundary ============ */
// Without this, any render-time throw unmounts the whole React tree and the
// window goes completely black with no clue. This catches it and shows the
// error + component stack so failures are debuggable instead of silent.
import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface in the devtools console too.
    console.error("Reelify crashed:", error, info);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          overflow: "auto",
          padding: "40px",
          background: "#0C0B09",
          color: "#F3EDDF",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          lineHeight: 1.6,
          zIndex: 9999,
        }}
      >
        <h2 style={{ color: "#FF7A52", fontFamily: "'Bricolage Grotesque', sans-serif", marginBottom: 12 }}>
          Something crashed this screen
        </h2>
        <div style={{ color: "#FF7A52", marginBottom: 16, whiteSpace: "pre-wrap" }}>
          {String(error && (error.stack || error.message || error))}
        </div>
        {info && info.componentStack && (
          <details open style={{ color: "#9C9588" }}>
            <summary style={{ cursor: "pointer", marginBottom: 8 }}>Component stack</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{info.componentStack}</pre>
          </details>
        )}
        <button
          onClick={() => this.setState({ error: null, info: null })}
          style={{
            marginTop: 20,
            background: "rgba(205,255,79,0.13)",
            border: "1px solid rgba(245,240,228,0.14)",
            color: "#F3EDDF",
            padding: "8px 16px",
            borderRadius: 8,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          Dismiss & retry render
        </button>
      </div>
    );
  }
}
