/* ============ REELIFY — shared UI ============ */
import React, { useState, useEffect } from "react";

/* ---- inline icons (stroke, currentColor) ---- */
export function Icon({ name, size = 18, sw = 2 }) {
  const p = {
    check: <polyline points="4 12 9 17 20 6" />,
    arrow: <g><line x1="4" y1="12" x2="20" y2="12" /><polyline points="14 6 20 12 14 18" /></g>,
    play: <polygon points="7 4 19 12 7 20" fill="currentColor" stroke="none" />,
    pause: <g><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/></g>,
    skipback: <g><polygon points="11 6 4 12 11 18" fill="currentColor" stroke="none"/><polygon points="20 6 13 12 20 18" fill="currentColor" stroke="none"/></g>,
    skipfwd: <g><polygon points="13 6 20 12 13 18" fill="currentColor" stroke="none"/><polygon points="4 6 11 12 4 18" fill="currentColor" stroke="none"/></g>,
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
    scissors: <g><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.5" y2="15.5"/><line x1="14" y1="14" x2="20" y2="20"/><line x1="8.5" y1="8.5" x2="11" y2="11"/></g>,
    type: <g><polyline points="4 7 4 4 20 4 20 7"/><line x1="12" y1="4" x2="12" y2="20"/><line x1="9" y1="20" x2="15" y2="20"/></g>,
    palette: <g><circle cx="12" cy="12" r="9"/><circle cx="8" cy="9" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="16" cy="9" r="1.2" fill="currentColor" stroke="none"/><path d="M12 21a3 3 0 0 1 0-6 2 2 0 0 0 0-4"/></g>,
    music: <g><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></g>,
    zap: <polygon points="13 2 4 14 11 14 10 22 20 9 13 9" />,
    film: <g><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="8" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="16" y2="20"/><line x1="3" y1="12" x2="21" y2="12"/></g>,
    download: <g><path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><line x1="5" y1="20" x2="19" y2="20"/></g>,
    share: <g><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></g>,
    link: <g><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></g>,
    sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
    mic: <g><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/></g>,
    users: <g><circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 5"/><path d="M18 20a6 6 0 0 0-3-5.2"/></g>,
    wave: <path d="M2 12h2l2-6 3 14 3-18 3 14 2-4h3" />,
    plus: <g><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></g>,
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round">{p}</svg>
  );
}

/* ---- radar / fingerprint chart ----
   Defensive: tolerates missing/odd axes or values (real synthesized styleDNA
   may omit a key or send a non-number) instead of crashing the whole screen. */
export function RadarChart({ axes, values, size = 240, animate = true, labels = false }) {
  const safeAxes = Array.isArray(axes) ? axes : [];
  const vals = values || {};
  const val = (key) => {
    const v = Number(vals[key]);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  };
  const cx = size / 2, cy = size / 2, R = size * 0.38;
  const n = safeAxes.length || 1;
  const [t, setT] = useState(animate ? 0 : 1);
  useEffect(() => {
    if (!animate) { setT(1); return; }
    let raf, start, done = false;
    const finish = () => { if (!done) { done = true; setT(1); } };
    const step = (ts) => {
      if (!start) start = ts;
      const k = Math.min(1, (ts - start) / 800);
      setT(k < 1 ? 1 - Math.pow(1 - k, 3) : 1);
      if (k < 1) raf = requestAnimationFrame(step); else finish();
    };
    raf = requestAnimationFrame(step);
    const safety = setTimeout(finish, 1100);
    return () => { cancelAnimationFrame(raf); clearTimeout(safety); };
  }, [values, animate]);

  const pt = (i, r) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };

  if (!safeAxes.length) return <svg width={size} height={size} />;

  const rings = [0.25, 0.5, 0.75, 1];
  const poly = safeAxes.map((ax, i) => pt(i, R * (val(ax.key) / 100) * t).join(",")).join(" ");
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: "visible" }}>
      {rings.map((r, i) => (
        <polygon key={i} points={safeAxes.map((_, j) => pt(j, R * r).join(",")).join(" ")}
          fill="none" stroke="var(--line)" strokeWidth="1" />
      ))}
      {safeAxes.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line)" strokeWidth="1" />;
      })}
      <polygon points={poly} fill="var(--accent-soft)" stroke="var(--accent)" strokeWidth="2"
        style={{ filter: "drop-shadow(0 0 10px var(--accent-soft))" }} />
      {safeAxes.map((ax, i) => {
        const [x, y] = pt(i, R * (val(ax.key) / 100) * t);
        return <circle key={i} cx={x} cy={y} r="3.5" fill="var(--accent)" />;
      })}
      {labels && safeAxes.map((ax, i) => {
        const [x, y] = pt(i, R + 16);
        const anchor = Math.abs(x - cx) < 14 ? "middle" : x > cx ? "start" : "end";
        return (
          <text key={"l" + i} x={x} y={y} textAnchor={anchor} dominantBaseline="middle"
            fontFamily="var(--mono)" fontSize="9" letterSpacing=".08em" fill="var(--text3)"
            style={{ textTransform: "uppercase" }}>
            {ax.label}
          </text>
        );
      })}
    </svg>
  );
}

/* ---- animated count (with timer fallback so the final value ALWAYS lands,
       even if the rAF clock is throttled/frozen) ---- */
export function Counter({ to, dur = 900, suffix = "" }) {
  const [v, setV] = useState(to);
  useEffect(() => {
    setV(0);
    let raf, start, done = false;
    const finish = () => { if (!done) { done = true; setV(to); } };
    const step = (ts) => {
      if (!start) start = ts;
      const k = Math.min(1, (ts - start) / dur);
      setV(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step); else finish();
    };
    raf = requestAnimationFrame(step);
    const safety = setTimeout(finish, dur + 400);
    return () => { cancelAnimationFrame(raf); clearTimeout(safety); };
  }, [to]);
  return <>{v}{suffix}</>;
}

/* ---- shared helper ---- */
export function initials(name) {
  return String(name || "").split(/[\s&]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}
