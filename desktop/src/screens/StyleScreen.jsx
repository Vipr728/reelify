import React from "react";
import { Icon, RadarChart } from "../ui.jsx";
import StagedLoader from "./StagedLoader.jsx";

export default function StyleScreen({ style, axes, loading, error, demo, onRetry, onNext, onBack }) {
  // Show the processing state while loading OR before the loader has kicked in
  // (first render after entering the step, style is still null with no error).
  if (loading || (!style && !error)) {
    return (
      <div className="screen style-screen">
        <StagedLoader
          title="Synthesizing your master style"
          steps={[
            { label: "Scraping creator reels", est: 120 },
            { label: "Quantifying pacing & captions", est: 90 },
            { label: "Aggregating creator styles", est: 20 },
            { label: "Synthesizing your recipe", est: 25 },
          ]}
        />
      </div>
    );
  }

  if (error && (!style || !style.recipe)) {
    return (
      <div className="screen style-screen">
        <div className="state-wrap">
          <div className="state-err">{error}</div>
          <button className="retry-btn" onClick={onRetry}>Retry</button>
        </div>
      </div>
    );
  }

  if (style && !style.recipe) {
    return (
      <div className="screen style-screen">
        <div className="state-wrap">
          <div className="state-msg">{style.error || "No analyzable creator videos were found, so no master style could be synthesized."}</div>
          <button className="retry-btn" onClick={onRetry}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen style-screen">
      <h1 className="h1 rise">Your <em>master style</em></h1>
      <p className="lede">
        Synthesized from {style.creatorsAnalyzed} creators · {style.videosAnalyzed} reels analyzed · target ~{style.targetDuration}s
      </p>
      {demo && <div className="demo-badge">Demo data · backend unreachable</div>}

      <div className="dna-stack">
        <div className="radar-box">
          <RadarChart axes={axes} values={style.styleDNA} size={300} animate labels />
        </div>

        <div className="traits">
          {style.traits.map((tr, i) => (
            <span className="trait" key={i}>
              <span className="ic"><Icon name={tr.ic} size={14} /></span>
              <span className="k">{tr.k}</span>
              <span className="v">{tr.v}</span>
              {tr.sw && <span className="sw" style={{ background: tr.sw }}></span>}
            </span>
          ))}
        </div>
      </div>

      <div
        className="style-summary"
        style={{
          padding: "16px 18px",
          color: "var(--muted)",
          maxWidth: 720,
          lineHeight: 1.6,
          borderRadius: 12,
          border: "1px solid var(--line)",
        }}
      >
        {style.summary}
      </div>

      <div className="navfoot">
        <button className="btn-text" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" onClick={onNext}>Apply to my footage <span className="ar"><Icon name="arrow" size={17} /></span></button>
      </div>
    </div>
  );
}
