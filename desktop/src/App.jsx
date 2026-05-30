/* ============ REELIFY — app root (real backend wiring) ============ */
// App.jsx owns ALL async + state. Screens stay presentational and receive a
// frozen prop contract (see each screen call below). Real data comes from the
// local server via src/api.js; if the server is unreachable and demo fallback
// is allowed, screens render bundled demo data with a visible notice.
import React, { useState, useEffect, useCallback, useRef } from "react";
import D from "./data.js";
import * as api from "./api.js";
import { ALLOW_DEMO_FALLBACK } from "./config.js";
import ImportScreen from "./screens/ImportScreen.jsx";
import AnalyzeScreen from "./screens/AnalyzeScreen.jsx";
import MatchScreen from "./screens/MatchScreen.jsx";
import StyleScreen from "./screens/StyleScreen.jsx";
import StudioScreen from "./screens/StudioScreen.jsx";
import ExportScreen from "./screens/ExportScreen.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const ACCENTS = {
  "Scope lime": { a: "#CDFF4F", d: "#A6E000", s: "rgba(205,255,79,0.13)", ink: "#0C0B09" },
  "Ice": { a: "#7FE9FF", d: "#2FB6D9", s: "rgba(127,233,255,0.14)", ink: "#0C0B09" },
  "Coral": { a: "#FF7A52", d: "#E8431A", s: "rgba(255,122,82,0.15)", ink: "#0C0B09" },
  "Violet": { a: "#A18BFF", d: "#6A4FE0", s: "rgba(161,139,255,0.16)", ink: "#FFFFFF" },
};

const STEPS = ["Import", "Analyze", "Match", "Style DNA", "Studio", "Export"];
const TWEAK_DEFAULTS = { accent: "Scope lime", grain: true, glow: true };

function useTweaks(defaults) {
  const [t, setT] = useState(defaults);
  const setTweak = (k, v) => setT((s) => ({ ...s, [k]: v }));
  return [t, setTweak];
}

// async-state helper: { data, loading, error, demo }
const idle = { data: null, loading: false, error: null, demo: false };

export default function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);

  const [reels, setReels] = useState(idle);
  const [selected, setSelected] = useState([]);
  const [activeReel, setActiveReel] = useState(null);

  const [analysis, setAnalysis] = useState(idle);
  const [creators, setCreators] = useState(idle);
  const [style, setStyle] = useState(idle);
  const [chosen, setChosen] = useState(null);

  const [settings, setSettings] = useState({ pacing: "Match", captions: "Pop", energy: 70, grade: 0 });
  const analysisReel = useRef(null);

  useEffect(() => {
    const r = document.documentElement;
    const ac = ACCENTS[t.accent] || ACCENTS["Scope lime"];
    r.style.setProperty("--accent", ac.a);
    r.style.setProperty("--accent-deep", ac.d);
    r.style.setProperty("--accent-soft", ac.s);
    r.style.setProperty("--accent-ink", ac.ink);
    r.setAttribute("data-grain", t.grain ? "on" : "off");
  }, [t]);

  /* ---------- generic loader with demo fallback ---------- */
  const run = useCallback(async (setState, realFn, demoFn) => {
    setState({ data: null, loading: true, error: null, demo: false });
    try {
      const data = await realFn();
      setState({ data, loading: false, error: null, demo: false });
      return data;
    } catch (e) {
      if (ALLOW_DEMO_FALLBACK && demoFn) {
        setState({ data: demoFn(), loading: false, error: e.message, demo: true });
      } else {
        setState({ data: null, loading: false, error: e.message, demo: false });
      }
      return null;
    }
  }, []);

  /* ---------- stage loaders ---------- */
  const loadReels = useCallback(() => run(setReels, api.listReels, api.demoReels), [run]);
  const loadAnalysis = useCallback(
    (reelName) => run(setAnalysis, () => api.analyzeReel(reelName), api.demoAnalysis),
    [run]
  );
  const loadCreators = useCallback(
    (niche) => run(setCreators, () => api.findCreators(niche), api.demoCreators),
    [run]
  );
  const loadStyle = useCallback(
    (niche, creatorList, transcriptText) =>
      run(setStyle, () => api.synthesizeStyle({ niche, creators: creatorList, transcriptText }), api.demoStyle),
    [run]
  );

  useEffect(() => {
    loadReels();
  }, [loadReels]);

  // Default the chosen creator once creators arrive (selection is optional —
  // the master style synthesizes across all of them).
  useEffect(() => {
    if (creators.data && creators.data.length && !chosen) setChosen(creators.data[0].id);
  }, [creators.data, chosen]);

  /* ---------- step-entry triggers (data dependencies are sequential) ---------- */
  useEffect(() => {
    if (step === 1 && activeReel && analysisReel.current !== activeReel && !analysis.loading) {
      analysisReel.current = activeReel;
      loadAnalysis(activeReel);
    }
  }, [step, activeReel, analysis.loading, loadAnalysis]);

  useEffect(() => {
    if (step === 2 && analysis.data?.niche && !creators.data && !creators.loading) {
      loadCreators(analysis.data.niche);
    }
  }, [step, analysis.data, creators.data, creators.loading, loadCreators]);

  useEffect(() => {
    if (step === 3 && analysis.data?.niche && creators.data?.length && !style.data && !style.loading) {
      loadStyle(analysis.data.niche, creators.data, analysis.data.transcript?.text || "");
    }
  }, [step, analysis.data, creators.data, style.data, style.loading, loadStyle]);

  /* ---------- nav ---------- */
  const next = () => {
    const n = Math.min(STEPS.length - 1, step + 1);
    setStep(n);
    setMaxStep((m) => Math.max(m, n));
  };
  const back = () => setStep((s) => Math.max(0, s - 1));
  const restart = () => {
    setStep(0);
    setMaxStep(0);
    setChosen(null);
    setActiveReel(null);
    analysisReel.current = null;
    setAnalysis(idle);
    setCreators(idle);
    setStyle(idle);
  };

  const toggle = (id) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  // Import -> Analyze: pick the active reel (first selected with a facecam) and
  // reset everything downstream so it re-derives from the new reel.
  const startAnalyze = () => {
    const list = reels.data || [];
    const sel = list.filter((r) => selected.includes(r.id));
    const target = sel.find((r) => r.hasFacecam) || sel[0];
    if (!target) return;
    if (target.id !== activeReel) {
      setActiveReel(target.id);
      analysisReel.current = null;
      setAnalysis(idle);
      setCreators(idle);
      setStyle(idle);
      setChosen(null);
    }
    next();
  };

  /* ---------- frozen prop contract per screen ---------- */
  const screen = [
    <ImportScreen
      reels={reels.data || []}
      selected={selected}
      toggle={toggle}
      loading={reels.loading}
      error={reels.error}
      demo={reels.demo}
      onReload={loadReels}
      onNext={startAnalyze}
    />,
    <AnalyzeScreen
      analysis={analysis.data}
      loading={analysis.loading}
      error={analysis.error}
      demo={analysis.demo}
      onRetry={() => activeReel && loadAnalysis(activeReel)}
      onNext={next}
      onBack={back}
    />,
    <MatchScreen
      creators={creators.data || []}
      chosen={chosen}
      setChosen={setChosen}
      loading={creators.loading}
      error={creators.error}
      demo={creators.demo}
      query={analysis.data?.niche ? api.tavilyQuery(analysis.data.niche) : ""}
      onRetry={() => analysis.data?.niche && loadCreators(analysis.data.niche)}
      onNext={next}
      onBack={back}
    />,
    <StyleScreen
      style={style.data}
      axes={api.dnaAxes}
      loading={style.loading}
      error={style.error}
      demo={style.demo}
      onRetry={() =>
        analysis.data?.niche &&
        creators.data?.length &&
        loadStyle(analysis.data.niche, creators.data, analysis.data.transcript?.text || "")
      }
      onNext={next}
      onBack={back}
    />,
    // Studio + Export are out of scope for this pass — still mock-backed.
    <StudioScreen data={D} chosen={chosen} settings={settings} setSettings={setSettings} onNext={next} onBack={back} />,
    <ExportScreen data={D} chosen={chosen} onRestart={restart} onBack={back} />,
  ][step];

  return (
    <>
      <div className="atmos glow" style={{ display: t.glow ? "block" : "none" }}></div>
      <div className="atmos grain"></div>

      <div className="shell">
        <header className="topnav">
          <div className="brand"><span className="logo-mark"></span>Reelify</div>
          <div className="stepper">
            {STEPS.map((s, i) => (
              <span
                key={i}
                className={"seg " + (i === step ? "active" : i < step ? "done" : "future")}
                onClick={() => i <= maxStep && setStep(i)}
                title={s}
              ></span>
            ))}
          </div>
          <div className="step-meta">
            {String(step + 1).padStart(2, "0")} / 06 · <b>{STEPS[step]}</b>
          </div>
        </header>

        <main className="stage" key={step}>
          <div className="fadeIn">{screen}</div>
        </main>
      </div>

      <SettingsPanel accents={ACCENTS} t={t} setTweak={setTweak} />
    </>
  );
}
