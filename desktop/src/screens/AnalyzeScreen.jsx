/* ============ REELIFY — 2 · ANALYZE ============ */
import React from "react";
import { Icon } from "../ui.jsx";

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export default function AnalyzeScreen({ analysis, loading, error, demo, onRetry, onNext, onBack }) {
  // build a dynamic highlighter from topic labels + niche keywords
  function makeHl(a) {
    const words = [
      ...(a.topics || []).map(t => t.label),
      ...((a.niche && a.niche.keywords) || []),
    ]
      .filter(w => typeof w === "string" && w.trim().length >= 3)
      .map(w => esc(w.trim()));
    if (!words.length) return (text) => text;
    const re = new RegExp("(" + words.join("|") + ")", "gi");
    return (text) => text.replace(re, "<mark>$1</mark>");
  }

  // 1 · processing
  if (loading || (!analysis && !error)) {
    return (
      <div className="screen">
        <div className="proc-orbit fadeIn"><div className="ring"></div><div className="ring r2"></div><div className="core"></div></div>
        <h1 className="h1 fadeIn" style={{ fontSize: 26 }}>Reading your footage</h1>
        <div className="proc-line fadeIn" style={{ marginTop: 18 }}>Transcribing audio &amp; detecting topics…</div>
        <div className="proc-bar"><i style={{ width: "60%" }}></i></div>
      </div>
    );
  }

  // 2 · error
  if (error && !analysis) {
    return (
      <div className="state-wrap">
        <div className="state-err">{error}</div>
        <button className="retry-btn" onClick={onRetry}>Retry</button>
      </div>
    );
  }

  // 3 · results
  const hl = makeHl(analysis);
  const niche = analysis.niche || {};

  let keylines;
  if (analysis.segments && analysis.segments.length > 0) {
    keylines = analysis.segments.slice(0, 3).map((s, i) => (
      <div key={i} className="keyline">
        <span className="tc">{s.t}</span>
        <span className="tx" dangerouslySetInnerHTML={{ __html: hl(s.text) }}></span>
      </div>
    ));
  } else {
    const sentences = (analysis.transcript?.text || "")
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    keylines = sentences.map((text, i) => (
      <div key={i} className="keyline">
        <span className="tx" dangerouslySetInnerHTML={{ __html: hl(text) }}></span>
      </div>
    ));
  }

  return (
    <div className="screen">
      <h1 className="h1 rise">What it's <em>about</em></h1>
      <p className="lede rise" style={{ animationDelay: ".08s" }}>Niche: {niche.label} · audience: {niche.audience}</p>

      {demo && <div className="demo-badge">Demo data · backend unreachable</div>}

      <div className="throughline rise" style={{ animationDelay: ".14s", marginTop: 30 }}>
        <span className="q">“</span>{analysis.throughline.replace(/\.$/, "")}<span className="q">”</span>
      </div>

      <div className="topics rise" style={{ animationDelay: ".2s" }}>
        {analysis.topics.map((t, i) => (
          <span key={i} className="topic">{t.label}<span className="pc">{t.w}</span></span>
        ))}
      </div>

      <div className="keylines rise" style={{ animationDelay: ".26s" }}>
        {keylines}
      </div>

      <div className="navfoot rise" style={{ animationDelay: ".32s" }}>
        <button className="btn-text" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" onClick={onNext}>Find my creators <span className="ar"><Icon name="arrow" size={17} /></span></button>
      </div>
    </div>
  );
}
