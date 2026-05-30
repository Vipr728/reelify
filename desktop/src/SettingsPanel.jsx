/* ============ REELIFY — Tweaks panel (accent / atmosphere) ============ */
import React, { useState } from "react";

function Toggle({ value, onChange }) {
  return (
    <button className={"twk-toggle" + (value ? " on" : "")} onClick={() => onChange(!value)} aria-pressed={value}>
      <i></i>
    </button>
  );
}

export default function SettingsPanel({ accents, t, setTweak }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button className="twk-fab" onClick={() => setOpen(true)}>
        <span className="dot"></span> Tweaks
      </button>
    );
  }

  return (
    <div className="twk-panel">
      <div className="twk-head">
        <span className="twk-title">Tweaks</span>
        <button className="twk-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
      </div>

      <div className="twk-sec">Accent</div>
      <div className="twk-swatches">
        {Object.entries(accents).map(([name, a]) => (
          <button key={name} className={"twk-sw" + (t.accent === name ? " on" : "")} title={name}
            style={{ background: a.a, color: a.a }} onClick={() => setTweak("accent", name)} />
        ))}
      </div>

      <div className="twk-sec">Atmosphere</div>
      <div className="twk-row">
        <span className="lbl">Film grain</span>
        <Toggle value={t.grain} onChange={(v) => setTweak("grain", v)} />
      </div>
      <div className="twk-row">
        <span className="lbl">Ambient glow</span>
        <Toggle value={t.glow} onChange={(v) => setTweak("glow", v)} />
      </div>
    </div>
  );
}
