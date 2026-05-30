import React, { useState, useEffect, useRef } from "react";

// Estimate-driven multi-step loader.
//
// The long-running pipeline (scrape -> quantify -> aggregate -> synthesize) is a
// single blocking request with no progress events, so we can't show TRUE per-
// stage completion. Instead each step advances on an estimated duration (`est`,
// in seconds) and the bar is asymptotic + explicitly labelled "est." — it
// approaches but never claims 100% before the real work finishes and this
// component unmounts. The final step keeps "working" past its estimate rather
// than falsely completing.
//
// Styles are scoped here (injected <style>) and only lean on CSS variables the
// app already defines (--accent, --accent-deep, --muted, --line), so dropping
// this in can't disturb the global stylesheet.

// Uses the app's real design tokens (app.css :root): --text / --text2 / --text3
// for foreground tiers, --line for hairlines, --accent (bright lime) with
// --accent-ink (dark) for the checkmark, --display / --mono for fonts. Every
// var() carries a fallback so the loader still renders if a token is missing.
const LOADER_CSS = `
@keyframes sl-pulse { 0%,100% { opacity:.3; transform:scale(.8);} 50% { opacity:1; transform:scale(1);} }
.sl-wrap { width:100%; max-width:460px; margin:0 auto; text-align:left; }
.sl-head { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:24px; }
.sl-title { font-family:var(--display,'Bricolage Grotesque',sans-serif); font-weight:600; font-size:26px; letter-spacing:-.03em; margin:0; color:var(--text,#F3EDDF); }
.sl-timer { font-family:var(--mono,'JetBrains Mono',monospace); font-variant-numeric:tabular-nums; font-size:13px; color:var(--text2,#9C9588); letter-spacing:.06em; }
.sl-steps { list-style:none; margin:0 0 22px; padding:0; display:flex; flex-direction:column; gap:15px; }
.sl-step { display:flex; align-items:center; gap:12px; font-size:15px; color:var(--text,#F3EDDF); transition:color .35s ease, opacity .35s ease; }
.sl-step.pending { color:var(--text3,#615C51); }
.sl-step.done { color:var(--text2,#9C9588); }
.sl-dot { width:18px; height:18px; flex:0 0 18px; border-radius:50%; border:1.5px solid var(--line2,rgba(245,240,228,0.14));
          display:flex; align-items:center; justify-content:center; color:var(--accent-ink,#0C0B09); }
.sl-step.done .sl-dot { background:var(--accent,#CDFF4F); border-color:var(--accent,#CDFF4F); }
.sl-step.active .sl-dot { border-color:var(--accent,#CDFF4F); }
.sl-step.active .sl-dot::after { content:""; width:8px; height:8px; border-radius:50%;
          background:var(--accent,#CDFF4F); animation:sl-pulse 1.1s ease-in-out infinite; }
.sl-sub { margin-left:auto; font-family:var(--mono,'JetBrains Mono',monospace); font-size:11px; letter-spacing:.04em; color:var(--text3,#615C51); font-variant-numeric:tabular-nums; }
.sl-bar { height:5px; border-radius:99px; background:var(--bg2,#141209); overflow:hidden; }
.sl-fill { height:100%; border-radius:99px; transition:width .45s ease;
           background:linear-gradient(90deg, var(--accent-deep,#A6E000), var(--accent,#CDFF4F)); }
.sl-note { margin-top:11px; font-family:var(--mono,'JetBrains Mono',monospace); font-size:12px; color:var(--text2,#9C9588); text-align:center; }
`;

const fmt = (s) =>
  `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function StagedLoader({ title, steps, footnote }) {
  const [elapsed, setElapsed] = useState(0); // seconds since mount
  const start = useRef(null);
  if (start.current === null) start.current = Date.now();

  useEffect(() => {
    const id = setInterval(() => setElapsed((Date.now() - start.current) / 1000), 250);
    return () => clearInterval(id);
  }, []);

  const totalEst = steps.reduce((a, s) => a + s.est, 0) || 1;

  // Current step = first whose cumulative estimate we haven't passed yet.
  // Clamp to the last step so it keeps spinning instead of "finishing" early.
  let acc = 0;
  let current = steps.length - 1;
  for (let i = 0; i < steps.length; i++) {
    if (elapsed < acc + steps[i].est) {
      current = i;
      break;
    }
    acc += steps[i].est;
  }

  // Asymptotic fill: fast at first, easing toward (but never hitting) 100%.
  const pct = Math.min(96, (1 - Math.exp(-elapsed / (totalEst * 0.65))) * 100);
  const estMin = Math.max(1, Math.round(totalEst / 60));

  return (
    <div className="state-wrap">
      <style>{LOADER_CSS}</style>
      <div className="sl-wrap">
        <div className="sl-head">
          <h1 className="sl-title">{title}</h1>
          <span className="sl-timer">{fmt(elapsed)}</span>
        </div>

        <ul className="sl-steps">
          {steps.map((s, i) => {
            const state = i < current ? "done" : i === current ? "active" : "pending";
            return (
              <li key={i} className={`sl-step ${state}`}>
                <span className="sl-dot">
                  {state === "done" && (
                    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M2.5 6.5 5 9l4.5-5.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
                <span>
                  {s.label}
                  {state === "active" ? "…" : ""}
                </span>
                {state === "done" && <span className="sl-sub">done</span>}
                {state === "active" && <span className="sl-sub">working</span>}
              </li>
            );
          })}
        </ul>

        <div className="sl-bar">
          <div className="sl-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="sl-note">
          {footnote || `est. ~${estMin} min · running on your real footage, so it's not instant`}
        </div>
      </div>
    </div>
  );
}
