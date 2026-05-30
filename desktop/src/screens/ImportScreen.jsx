import { Icon } from "../ui.jsx";

export default function ImportScreen({
  reels = [],
  selected = [],
  toggle,
  loading,
  error,
  demo,
  onReload,
  onNext,
}) {
  if (loading) {
    return (
      <div className="state-wrap">
        <div className="state-spinner"></div>
        <div className="state-msg">Loading reels from Box…</div>
      </div>
    );
  }

  if (error && reels.length === 0) {
    return (
      <div className="state-wrap">
        <div className="state-err">{error}</div>
        <button className="retry-btn" onClick={onReload}>
          Retry
        </button>
      </div>
    );
  }

  const selCount = selected.length;
  const clipsQueued = reels
    .filter((r) => selected.includes(r.id))
    .reduce((sum, r) => sum + (r.clips || 0), 0);
  const canNext = reels.some((r) => selected.includes(r.id) && r.hasFacecam);

  return (
    <>
      <h1>
        Import from <em>Box</em>
      </h1>
      <p className="lede">
        Pick the reels you want to ingest. Each reel is transcribed and analyzed
        for clip-worthy moments.
      </p>
      <div className="src-tag">
        <Icon name="folder" size={14} /> Box
      </div>

      {demo && <div className="demo-badge">Demo data · backend unreachable</div>}

      <div className="mlist">
        {reels.map((r, i) => {
          const on = selected.includes(r.id);
          return (
            <div
              key={r.id}
              className={
                "mrow rise" + (on ? " on" : "") + (r.hasFacecam ? "" : " dim")
              }
              style={{ animationDelay: i * 0.05 + "s" }}
              onClick={() => toggle(r.id)}
            >
              <div className="mcheck">
                <Icon name="check" size={12} sw={3} />
              </div>
              <div className="folder-ic" style={{ background: r.grad }}>
                <Icon name="folder" size={19} />
              </div>
              <div className="clip-nm">
                <div className="fn">{r.name}</div>
                <div className="mt">{r.subtitle}</div>
              </div>
              <div className="clip-dur">{r.path}</div>
            </div>
          );
        })}
      </div>

      <div className="sel-line">
        {selCount} {selCount === 1 ? "reel" : "reels"} selected · {clipsQueued}{" "}
        {clipsQueued === 1 ? "clip" : "clips"} queued
      </div>

      <div className="navfoot">
        <button className="btn-primary" disabled={!canNext} onClick={onNext}>
          Ingest & transcribe <Icon name="arrow" size={16} />
        </button>
      </div>
    </>
  );
}
