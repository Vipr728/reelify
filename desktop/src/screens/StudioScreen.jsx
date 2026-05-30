/* ============ REELIFY — 6 · STUDIO (real timeline from an edit plan) ============ */
// Loads a JSON edit plan (EditPlan or project format), resolves each asset to a
// Box file, and renders a real, playable timeline. Sources video straight from
// Box via the server's range-enabled stream endpoint. Visual language matches
// the original Studio timeline (same .studio/.player/.tl/.lane/.clip classes).
import React, { useState, useEffect, useRef, useCallback } from "react";
import { Icon } from "../ui.jsx";
import { gradFor, resolveBoxAsset, boxFileUrl } from "../api.js";
import { normalizeEditPlan, SAMPLE_PLAN } from "../editplan.js";

const mmss = (s) =>
  `${String(Math.floor((s || 0) / 60)).padStart(2, "0")}:${String(Math.floor((s || 0) % 60)).padStart(2, "0")}`;

function activeItem(lane, t) {
  if (!lane) return null;
  return lane.items.find((it) => t >= it.tlIn && t < it.tlOut) || null;
}

export default function StudioScreen({ onNext, onBack }) {
  const [plan, setPlan] = useState(null);
  const [fileName, setFileName] = useState("");
  const [loadError, setLoadError] = useState(null);
  const [srcByAsset, setSrcByAsset] = useState({}); // assetId -> url | null (null = unresolved)
  const [resolving, setResolving] = useState(false);

  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);

  const mainRef = useRef(null);
  const overlayRef = useRef(null);
  const rafRef = useRef(0);
  const lastRef = useRef(0);
  const planRef = useRef(null);
  const srcRef = useRef({});
  const fileInputRef = useRef(null);

  useEffect(() => {
    planRef.current = plan;
  }, [plan]);
  useEffect(() => {
    srcRef.current = srcByAsset;
  }, [srcByAsset]);

  /* ---------- load a plan ---------- */
  const loadPlan = useCallback((json, name) => {
    try {
      const normalized = normalizeEditPlan(json);
      setPlan(normalized);
      setFileName(name || "");
      setLoadError(null);
      setSrcByAsset({});
      setPlaying(false);
      setT(0);
    } catch (e) {
      setLoadError(e.message);
      setPlan(null);
    }
  }, []);

  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadPlan(JSON.parse(String(reader.result)), file.name);
      } catch {
        setLoadError("That file is not valid JSON.");
      }
    };
    reader.readAsText(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadPlan(JSON.parse(String(reader.result)), file.name);
      } catch {
        setLoadError("That file is not valid JSON.");
      }
    };
    reader.readAsText(file);
  };

  /* ---------- resolve assets to Box stream URLs ---------- */
  useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    const ids = Object.keys(plan.assets);
    if (!ids.length) return;
    setResolving(true);
    (async () => {
      const map = {};
      await Promise.all(
        ids.map(async (id) => {
          const a = plan.assets[id];
          try {
            const fileId = await resolveBoxAsset(a.boxFileId || a.uri);
            map[id] = boxFileUrl(fileId);
          } catch {
            map[id] = null; // unresolved -> timeline still renders a placeholder block
          }
        })
      );
      if (!cancelled) {
        setSrcByAsset(map);
        setResolving(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan]);

  /* ---------- imperative video sync ---------- */
  const syncVideos = useCallback((time, isPlaying) => {
    const p = planRef.current;
    const src = srcRef.current;
    if (!p) return;

    const mainLane = p.videoLanes.find((l) => l.role === "main") || p.videoLanes[0];
    const overlayLane = p.videoLanes.find((l) => l.role === "overlay");

    const syncOne = (videoEl, lane, muted) => {
      if (!videoEl) return false;
      const item = activeItem(lane, time);
      const url = item ? src[item.assetId] : null;
      if (!item || !url) {
        if (!videoEl.paused) videoEl.pause();
        videoEl.removeAttribute("data-key");
        return false;
      }
      videoEl.muted = muted;
      if (videoEl.getAttribute("data-key") !== item.id) {
        videoEl.setAttribute("data-key", item.id);
        if (videoEl.src !== url) videoEl.src = url;
        try {
          videoEl.currentTime = item.sourceIn + Math.max(0, time - item.tlIn);
        } catch {
          /* seeking before metadata is fine; the effect below re-syncs */
        }
      } else {
        const desired = item.sourceIn + Math.max(0, time - item.tlIn);
        if (Math.abs(videoEl.currentTime - desired) > 0.3) {
          try {
            videoEl.currentTime = desired;
          } catch {
            /* ignore */
          }
        }
      }
      if (isPlaying && videoEl.paused) videoEl.play().catch(() => {});
      if (!isPlaying && !videoEl.paused) videoEl.pause();
      return true;
    };

    syncOne(mainRef.current, mainLane, false);
    syncOne(overlayRef.current, overlayLane, true);
  }, []);

  /* ---------- playback clock ---------- */
  useEffect(() => {
    if (!playing || !plan) return;
    lastRef.current = performance.now();
    const tick = (now) => {
      const dt = (now - lastRef.current) / 1000;
      lastRef.current = now;
      setT((prev) => {
        const nxt = prev + dt;
        if (nxt >= plan.totalDuration) {
          setPlaying(false);
          return plan.totalDuration;
        }
        syncVideos(nxt, true);
        return nxt;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, plan, syncVideos]);

  // Keep the preview frame correct when paused / scrubbing / after resolve.
  useEffect(() => {
    syncVideos(t, playing);
  }, [t, srcByAsset, plan, syncVideos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) {
      mainRef.current && mainRef.current.pause();
      overlayRef.current && overlayRef.current.pause();
    }
  }, [playing]);

  const seekToClientX = (e) => {
    if (!plan) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setT(ratio * plan.totalDuration);
  };

  /* ---------- empty state: load a plan ---------- */
  if (!plan) {
    return (
      <div className="screen wide">
        <h1 className="h1 rise">Build the <em>timeline</em></h1>
        <p className="lede rise" style={{ animationDelay: ".06s" }}>
          Drop an edit-plan JSON (EditPlan or project format). Reelify resolves each clip against your Box
          workspace and assembles a real, playable timeline.
        </p>

        <div
          className="plan-drop rise"
          style={{ animationDelay: ".12s" }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
        >
          <span className="folder-ic"><Icon name="folder" size={26} /></span>
          <div className="plan-drop-main">Drop a plan.json here, or click to choose a file</div>
          <div className="plan-drop-sub mono">accepts EditPlan (tracks) or project (timeline) JSON</div>
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onFile} style={{ display: "none" }} />
        </div>

        {loadError && <div className="state-err" style={{ marginTop: 14 }}>{loadError}</div>}

        <div className="navfoot rise" style={{ animationDelay: ".2s" }}>
          <button className="btn-text" onClick={onBack}>← Back</button>
          <button className="btn-text" onClick={() => loadPlan(SAMPLE_PLAN, "sample-plan.json")}>Load sample plan →</button>
        </div>
      </div>
    );
  }

  const total = plan.totalDuration;
  const pct = (t / total) * 100;
  const mainLane = plan.videoLanes.find((l) => l.role === "main") || plan.videoLanes[0];
  const overlayLane = plan.videoLanes.find((l) => l.role === "overlay");
  const activeMain = activeItem(mainLane, t);
  const activeOverlay = activeItem(overlayLane, t);
  const activeCaption = plan.captions.find((c) => t >= c.tlIn && t < c.tlOut) || null;
  const mainResolved = activeMain && srcByAsset[activeMain.assetId];
  const overlayResolved = activeOverlay && srcByAsset[activeOverlay.assetId];
  const assetIds = Object.keys(plan.assets);
  const resolvedCount = assetIds.filter((id) => srcByAsset[id]).length;

  return (
    <div className="screen wide">
      <h1 className="h1 rise" style={{ marginBottom: 4 }}>{plan.title}</h1>
      <p className="lede rise" style={{ animationDelay: ".06s", marginBottom: 20 }}>
        {plan.aspectRatio} · {Math.round(total * 10) / 10}s · {plan.format === "editplan" ? "EditPlan" : "project"} plan
        {resolving ? " · resolving Box assets…" : ` · ${resolvedCount}/${assetIds.length} assets from Box`}
      </p>

      <div className="studio">
        <div className="player-col">
          <div className="player" style={{ aspectRatio: plan.width + " / " + plan.height }}>
            {/* placeholder gradient shown when no real footage is resolved for the active clip */}
            <div
              className="vframe"
              style={{
                background: gradFor((activeMain ? mainLane.items.indexOf(activeMain) : 0) + 1),
                opacity: mainResolved ? 0 : 1,
              }}
            >
              {!mainResolved && activeMain && (
                <div className="vframe-tag mono">{activeMain.assetId}{srcByAsset[activeMain.assetId] === null ? " · not in Box" : ""}</div>
              )}
            </div>

            <video ref={mainRef} className="vlayer" playsInline preload="auto"
              style={{ opacity: mainResolved ? 1 : 0 }} />
            <video ref={overlayRef} className="vlayer" playsInline preload="auto" muted
              style={{ opacity: overlayResolved ? 1 : 0 }} />

            {activeCaption && (
              <div className="cap-overlay" key={activeCaption.tlIn}>
                {activeCaption.tokens && activeCaption.tokens.length
                  ? activeCaption.tokens.map((tk, i) => (
                      <span key={i} className={tk.highlight ? "cap-hi" : undefined}>{tk.text} </span>
                    ))
                  : activeCaption.text}
              </div>
            )}
            <div className="play-badge">{fileName || plan.title}</div>
          </div>

          <div className="transport">
            <button className="tbtn" onClick={() => { setT(0); setPlaying(false); }}><Icon name="skipback" size={18} /></button>
            <button className="tbtn play" onClick={() => setPlaying((p) => !p)}>
              <Icon name={playing ? "pause" : "play"} size={20} />
            </button>
            <div className="tcode mono">{mmss(t)} / {mmss(total)}</div>
          </div>

          <div className="tl" onClick={seekToClientX} style={{ cursor: "pointer" }}>
            {plan.videoLanes.map((lane) => (
              <div key={lane.id} className="lane">
                {lane.items.map((it, i) => (
                  <div
                    key={it.id}
                    className={"clip" + ((activeMain?.id === it.id || activeOverlay?.id === it.id) ? " on" : "")}
                    style={{
                      left: `${(it.tlIn / total) * 100}%`,
                      width: `${Math.max(0.5, ((it.tlOut - it.tlIn) / total) * 100)}%`,
                      background: gradFor(i + (lane.role === "overlay" ? 4 : 0)),
                    }}
                    title={`${it.assetId} · ${mmss(it.tlIn)}–${mmss(it.tlOut)}`}
                  >
                    <span className="clip-label">{it.assetId}</span>
                  </div>
                ))}
              </div>
            ))}
            {/* caption lane */}
            <div className="lane caption-lane">
              {plan.captions.map((c, i) => (
                <div
                  key={i}
                  className={"clip cap-clip" + (activeCaption === c ? " on" : "")}
                  style={{ left: `${(c.tlIn / total) * 100}%`, width: `${Math.max(0.5, ((c.tlOut - c.tlIn) / total) * 100)}%` }}
                  title={c.text}
                >
                  <span className="clip-label">{c.text}</span>
                </div>
              ))}
            </div>
            <div className="playhead" style={{ left: `${pct}%` }}></div>
          </div>

          <div className="tl-ruler">
            {Array.from({ length: 7 }).map((_, i) => (
              <span key={i}>{mmss((total / 6) * i)}</span>
            ))}
          </div>
        </div>

        <aside className="studio-side">
          <div className="srow">
            <div className="srow-label mono">Output</div>
            <div className="plan-meta mono">
              {plan.width}×{plan.height} · {plan.fps}fps<br />
              {plan.aspectRatio} · {Math.round(total * 10) / 10}s
            </div>
          </div>

          <div className="srow">
            <div className="srow-label mono">Box assets</div>
            <div className="plan-assets">
              {assetIds.map((id) => (
                <div key={id} className="plan-asset">
                  <span className={"dot " + (srcByAsset[id] ? "ok" : srcByAsset[id] === null ? "bad" : "wait")}></span>
                  <span className="pa-id">{id}</span>
                  <span className="pa-kind mono">{plan.assets[id].kind}</span>
                </div>
              ))}
            </div>
          </div>

          {plan.editorNotes && plan.editorNotes.length > 0 && (
            <div className="srow">
              <div className="srow-label mono">Editor notes</div>
              <ul className="plan-notes">
                {plan.editorNotes.map((n, i) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          <button className="btn-text" style={{ paddingLeft: 0 }} onClick={() => { setPlan(null); setSrcByAsset({}); }}>
            ← Load a different plan
          </button>
        </aside>
      </div>

      <div className="navfoot rise" style={{ animationDelay: ".1s" }}>
        <button className="btn-text" onClick={onBack}>← Back</button>
        <button className="btn btn-primary" onClick={onNext}>Render final video <span className="ar"><Icon name="arrow" size={17} /></span></button>
      </div>
    </div>
  );
}
