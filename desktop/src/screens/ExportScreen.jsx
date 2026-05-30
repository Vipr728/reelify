/* ============ REELIFY — 6 · EXPORT ============ */
import React, { useState, useEffect } from "react";
import { Icon, initials } from "../ui.jsx";

export default function ExportScreen({ data, chosen, onRestart, onBack }) {
  const creator = data.creators.find(c => c.id === chosen) || data.creators[0];
  const dna = data.styleDNA[creator.id];
  const [prog, setProg] = useState(0);
  const [rendering, setRendering] = useState(true);
  useEffect(() => {
    const iv = setInterval(() => setProg(p => {
      const nx = p + Math.random() * 13 + 5;
      if (nx >= 100) { clearInterval(iv); setTimeout(() => setRendering(false), 380); return 100; }
      return nx;
    }), 220);
    return () => clearInterval(iv);
  }, []);

  if (rendering) {
    return (
      <div className="render-overlay">
        <div className="render-box">
          <div className="proc-orbit"><div className="ring"></div><div className="ring r2"></div><div className="core"></div></div>
          <h1 className="h1" style={{ fontSize: 24 }}>Rendering your reel</h1>
          <div className="render-bar"><i style={{ width: prog + "%" }}></i></div>
          <p className="mono" style={{ fontSize: 11.5, color: "var(--text2)" }}>
            {prog < 35 ? "Conforming clips" : prog < 70 ? "Baking captions" : prog < 95 ? "Color grade · " + dna.gradeName : "Finalizing"} · {Math.round(prog)}%
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <h1 className="h1 rise">Your reel is <em>ready</em></h1>
      <p className="lede rise" style={{ animationDelay: ".08s" }}>Cut from your Box footage in the style of {creator.handle}.</p>

      <div className="final-player rise" style={{ animationDelay: ".14s", background: data.grads[2] }}>
        <div className="vignette" style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at center,transparent 52%,rgba(0,0,0,.5))" }}></div>
        <div className="badge"><span className="d"></span>READY · 1:28</div>
        <div className="ui-top" style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "11px 13px", display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9.5, color: "rgba(255,255,255,.85)" }}><span>REELIFY</span><span>9:16</span></div>
        <div className="cap-overlay" style={{ position: "absolute", left: 16, right: 16, bottom: 56, textAlign: "center", fontFamily: "var(--display)", fontWeight: 800, fontSize: 22, textTransform: "uppercase", color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,.6)" }}>
          transparency became<br /><span style={{ color: "var(--accent)" }}>THE MOAT</span>
        </div>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <button className="tp-btn main" style={{ width: 56, height: 56 }}><Icon name="play" size={20} /></button>
        </div>
      </div>

      <div className="recap-line rise" style={{ animationDelay: ".2s" }}>
        <span><b>1:28</b> runtime</span><span className="dot">·</span>
        <span><b>{dna.cutsMin.split("/")[0]}</b> cuts</span><span className="dot">·</span>
        <span><b>14</b> captions</span><span className="dot">·</span>
        <span><b>9:16</b></span>
      </div>

      <div className="applied rise" style={{ animationDelay: ".24s" }}>
        <span className="av" style={{ background: creator.grad }}>{initials(creator.name)}</span>
        <span className="tx"><span className="k">Edited in the style of</span><br /><span className="v">{creator.handle} · {dna.gradeName}</span></span>
      </div>

      <div className="export-actions rise" style={{ animationDelay: ".28s" }}>
        <button className="btn btn-primary"><Icon name="download" size={17} /> Download MP4 · 1080×1920</button>
        <div className="exp-links">
          <button className="exp-link"><Icon name="share" size={15} /> Post to socials</button>
          <button className="exp-link"><Icon name="link" size={15} /> Copy link</button>
          <button className="exp-link" onClick={onRestart}><Icon name="plus" size={15} /> New reel</button>
        </div>
      </div>
    </div>
  );
}
