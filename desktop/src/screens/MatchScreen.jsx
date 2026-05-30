import { Icon, initials } from "../ui.jsx";

export default function MatchScreen({
  creators = [],
  chosen,
  setChosen,
  loading,
  error,
  demo,
  query,
  onRetry,
  onNext,
  onBack,
}) {
  if (loading) {
    return (
      <div className="state-wrap">
        <div className="state-spinner"></div>
        <div className="state-msg">Searching the web for creators who match your niche…</div>
        {query && (
          <div className="search-query">
            <span className="sq-label">Tavily query</span>
            <code className="sq-text">{query}</code>
          </div>
        )}
      </div>
    );
  }

  if (error && creators.length === 0) {
    return (
      <div className="state-wrap">
        <div className="state-err">{error}</div>
        <button className="retry-btn" onClick={onRetry}>Retry</button>
      </div>
    );
  }

  return (
    <>
      <h1 className="h1 rise">Creators who speak your <em>language</em></h1>
      <p className="lede">We found the voices closest to your niche. The style DNA is synthesized across all of them, so picking one is optional.</p>

      {demo && <div className="demo-badge">Demo data · backend unreachable</div>}

      <div className="cr-list">
        {creators.map((c) => (
          <div
            key={c.id}
            className={"cr-row rise" + (chosen === c.id ? " on" : "")}
            onClick={() => setChosen(c.id)}
          >
            <div className="cr-av" style={{ background: c.grad }}>{initials(c.name)}</div>
            <div className="cr-mid">
              <div className="h">
                {c.profile_url ? (
                  <a className="cr-link" href={c.profile_url} target="_blank" rel="noreferrer"
                    onClick={(e) => e.stopPropagation()} title={`Open ${c.handle} on Instagram`}>
                    {c.handle}<span className="cr-link-ic"><Icon name="link" size={13} /></span>
                  </a>
                ) : c.handle}
              </div>
              <div className="n">{c.name} · {c.followers} · {c.niche}</div>
              <div className="sh">
                Shared:{" "}
                {c.shared.map((s, i) => (
                  <span key={i}>
                    <b>{s}</b>{i < c.shared.length - 1 ? ", " : ""}
                  </span>
                ))}
              </div>
              {c.blurb && <div className="bl">{c.blurb}</div>}
            </div>
            <div className="cr-pc">
              <div className="v">#{c.rank}</div>
              <div className="l">rank</div>
            </div>
          </div>
        ))}
      </div>

      <div className="navfoot">
        <button className="btn-text" onClick={onBack}>← Back</button>
        <button className="btn btn-coral" disabled={!creators.length} onClick={onNext}>
          Extract their style DNA <span className="ar"><Icon name="arrow" size={17} /></span>
        </button>
      </div>
    </>
  );
}
