/* ============ REELIFY — API client + normalizers ============ */
// Single source of truth for how the desktop reaches real functionality and
// how raw backend/pipeline shapes become screen-ready props. Screens stay
// presentational: App.jsx calls these, screens just render the result.
//
// Backend (server/index.js, default http://localhost:8787):
//   GET  /api/reels                      -> { reels: [...] }
//   POST /api/reels/:name/analyze        -> { transcript, segments, niche }
//   POST /api/creators   { niche }       -> { creators: Creator[] }
//   POST /api/style      { niche, creators, transcriptText }
//                                        -> { recipe, perCreator, posts }

import { API_BASE } from "./config.js";
import D from "./data.js";

/* ---------- low-level fetch ---------- */

async function req(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(
      e.name === "AbortError" ? "Request timed out — is the server running?" : `Cannot reach server at ${API_BASE}. Is it running? (npm run server)`
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Bad response from server (${res.status}).`);
  }
  if (!res.ok) throw new Error(payload.error || payload.message || `Server error (${res.status}).`);
  return payload;
}

/* ---------- display helpers ---------- */

const GRADS = D.grads;
export const gradFor = (i) => GRADS[i % GRADS.length];

function humanCount(n) {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function clock(sec) {
  if (sec == null || Number.isNaN(sec)) return "00:00";
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

/* ============================================================
   STAGE 2 — IMPORT (reels from Box)
   ============================================================ */

export function normalizeReels(raw) {
  return (raw || []).map((r, i) => ({
    id: r.name, // reel folder name is the stable id used downstream
    name: r.name,
    path: r.path || "/reels",
    hasFacecam: !!r.hasFacecam,
    brollCount: r.brollCount || 0,
    clips: (r.brollCount || 0) + (r.hasFacecam ? 1 : 0),
    subtitle: `${r.hasFacecam ? "facecam set" : "no facecam"} · ${r.brollCount || 0} b-roll`,
    grad: gradFor(i),
  }));
}

export async function listReels() {
  const payload = await req("/api/reels", { timeoutMs: 20000 });
  return normalizeReels(payload.reels);
}

export function demoReels() {
  // Bundled fallback derived from mock folders so Import still renders offline.
  return D.boxFolders.map((f, i) => ({
    id: f.id,
    name: f.name,
    path: f.path,
    hasFacecam: true,
    brollCount: f.clips,
    clips: f.clips,
    subtitle: `${f.clips} clips · ${f.res} · ${f.dur}`,
    grad: gradFor(i),
  }));
}

/* ============================================================
   STAGE 3 — ANALYZE (transcript + niche -> topics/throughline)
   ============================================================ */

function topicsFromNiche(niche) {
  const kw = (niche?.keywords || []).slice(0, 6);
  const n = Math.max(1, kw.length - 1);
  return kw.map((label, i) => ({ label, w: clamp(95 - i * (40 / n), 40, 99) }));
}

export function normalizeAnalysis(payload) {
  const niche = payload.niche || {};
  const segs = (payload.segments || []).map((s) => ({
    t: clock(s.start),
    clip: "Talking",
    text: (s.text || "").trim(),
  }));
  const vt = payload.videoType || niche.video_type || null;
  return {
    transcript: payload.transcript || { text: "", source: "user-video-transcribed" },
    segments: segs,
    topics: topicsFromNiche(niche),
    throughline: niche.rationale || niche.label || "",
    videoType: vt && vt.label ? { label: vt.label, rationale: vt.rationale || "", confidence: vt.confidence ?? null } : null,
    niche, // raw — threaded forward to stage 4 + 5
  };
}

export async function analyzeReel(reelName) {
  // Whisper + niche; can take ~10-40s for a 30s clip.
  const payload = await req(`/api/reels/${encodeURIComponent(reelName)}/analyze`, {
    method: "POST",
    timeoutMs: 180000,
  });
  return normalizeAnalysis(payload);
}

export function demoAnalysis() {
  return {
    transcript: { text: D.transcript.map((s) => s.text).join(" "), source: "demo" },
    segments: D.transcript.map((s) => ({ t: s.t, clip: s.clip, text: s.text })),
    topics: D.topics,
    throughline: D.throughline,
    videoType: { label: "talking head", rationale: "demo", confidence: null },
    niche: {
      label: "Founder-led growth",
      keywords: D.topics.map((t) => t.label),
      audience: "early-stage founders",
      rationale: D.throughline,
    },
  };
}

/* ============================================================
   STAGE 4 — MATCH (real creators)
   ============================================================ */

export function normalizeCreators(rawCreators, niche) {
  return (rawCreators || []).map((c, i) => ({
    id: c.handle,
    rank: i + 1,
    handle: "@" + String(c.handle || "").replace(/^@/, ""),
    name: c.display_name || c.handle,
    niche: niche?.label || "—",
    followers: humanCount(c.follower_count),
    platform: "Instagram",
    profile_url: c.profile_url,
    blurb: c.why || "",
    // Real pipeline has no per-creator overlap score; show shared niche keywords.
    shared: (niche?.keywords || []).slice(0, 3),
    grad: gradFor(i + 2),
  }));
}

// Mirror of the query string apify-integration/src/creators.ts builds for Tavily,
// so the UI can show exactly what is being searched while loading.
export function tavilyQuery(niche) {
  const label = niche?.label || "";
  const kw = (niche?.keywords || []).slice(0, 3).join(" ");
  return `top instagram creators ${label} ${kw} site:instagram.com`.replace(/\s+/g, " ").trim();
}

export async function findCreators(niche) {
  const payload = await req("/api/creators", { method: "POST", body: { niche }, timeoutMs: 120000 });
  const list = normalizeCreators(payload.creators, niche);
  // Treat an empty result as a failure so the caller's demo fallback engages —
  // the UI should never dead-end on "no creators found".
  if (!list.length) throw new Error("No creators returned for this niche.");
  return list;
}

export function demoCreators() {
  return D.creators.map((c, i) => ({
    id: c.id,
    rank: i + 1,
    handle: c.handle,
    name: c.name,
    niche: c.niche,
    followers: c.followers,
    platform: c.platform,
    profile_url: null,
    blurb: c.blurb,
    shared: c.shared,
    grad: c.grad,
  }));
}

/* ============================================================
   STAGE 5 — STYLE (synthesized master style = Recipe)
   ============================================================ */

// Map a Recipe (apify synthesize output) onto the 7 radar axes 0..100.
// Some axes (grade) aren't measured by the deterministic pipeline; we derive a
// best-effort value and keep the trait honest ("not measured" where relevant).
export function recipeToStyleDNA(recipe) {
  const cuts = recipe?.pacing?.cuts_per_10s ?? 0;
  const cutRate = clamp((cuts / 16) * 100);
  const caps = recipe?.captions || {};
  const audio = recipe?.audio || {};
  const broll = recipe?.broll || {};
  const hook = recipe?.hook || {};
  return {
    cutRate,
    punch: clamp(cutRate * 0.9),
    captions: caps.present ? (caps.animation ? 92 : 75) : 12,
    music: audio.music
      ? audio.pattern === "throughout"
        ? 90
        : audio.pattern === "gaps"
        ? 65
        : 50
      : 10,
    broll: broll.use ? clamp(40 + (broll.count || 0) * 4) : 10,
    hook: clamp(100 - (hook.duration_s ?? 4) * 15, 30, 99),
    grade: 55, // not measured by the deterministic pipeline
  };
}

function recipeTraits(recipe) {
  const caps = recipe?.captions || {};
  const audio = recipe?.audio || {};
  const broll = recipe?.broll || {};
  const hook = recipe?.hook || {};
  const pacing = recipe?.pacing || {};
  return [
    { ic: "scissors", k: "Pacing", v: `${(pacing.cuts_per_10s ?? 0).toFixed(1)} cuts/10s` },
    {
      ic: "type",
      k: "Captions",
      v: caps.present ? `${caps.style || "captions"}, ${caps.position || ""}`.trim() : "none",
      sw: caps.present && caps.color ? caps.color : null,
    },
    { ic: "palette", k: "B-roll", v: broll.use ? `${broll.count || 0} cutaways` : "minimal" },
    {
      ic: "music",
      k: "Music",
      v: audio.music ? `${audio.suggested_genre || "music"} · ${audio.pattern || ""}`.trim() : "none",
    },
    { ic: "zap", k: "Hook", v: hook.style ? `${hook.style} (${hook.duration_s ?? "?"}s)` : "—" },
  ];
}

export function normalizeStyle(payload) {
  const recipe = payload.recipe;
  const perCreator = payload.perCreator || [];
  const analyzed = perCreator.filter((p) => p.videos_analyzed > 0);
  if (!recipe) {
    return {
      recipe: null,
      error: "No analyzable creator videos were found, so no master style could be synthesized.",
      perCreator,
    };
  }
  return {
    recipe,
    styleDNA: recipeToStyleDNA(recipe),
    traits: recipeTraits(recipe),
    summary: recipe.summary || "",
    targetDuration: recipe.target_duration_s,
    creatorsAnalyzed: analyzed.length,
    videosAnalyzed: analyzed.reduce((a, p) => a + (p.videos_analyzed || 0), 0),
    perCreator,
  };
}

export async function synthesizeStyle({ niche, creators, transcriptText }) {
  // Scrape -> quantify -> aggregate -> synthesize. Apify scrape alone can take
  // several minutes, hence the long timeout.
  const rawCreators = (creators || []).map((c) => ({
    handle: String(c.handle || c.id || "").replace(/^@/, ""),
    profile_url: c.profile_url || `https://www.instagram.com/${String(c.handle || c.id).replace(/^@/, "")}/`,
    display_name: c.name,
    source: "tavily",
    why: c.blurb || "",
  }));
  const payload = await req("/api/style", {
    method: "POST",
    body: { niche, creators: rawCreators, transcriptText },
    timeoutMs: 900000,
  });
  return normalizeStyle(payload);
}

export function demoStyle() {
  const dna = D.styleDNA.v1;
  return {
    recipe: { summary: "Demo master style (backend unreachable)." },
    styleDNA: {
      cutRate: dna.cutRate,
      punch: dna.punch,
      captions: dna.captions,
      music: dna.music,
      broll: dna.broll,
      hook: dna.hook,
      grade: dna.grade,
    },
    traits: [
      { ic: "scissors", k: "Pacing", v: dna.cutsMin },
      { ic: "type", k: "Captions", v: dna.capStyle.split(",")[0] },
      { ic: "palette", k: "Grade", v: dna.gradeName, sw: dna.gradeCss },
      { ic: "music", k: "Music", v: dna.musicName },
      { ic: "zap", k: "Hook", v: dna.hookDesc },
    ],
    summary: D.throughline,
    targetDuration: 28,
    creatorsAnalyzed: D.creators.length,
    videosAnalyzed: 12,
    perCreator: [],
  };
}

export const dnaAxes = D.dnaAxes;

/* ============================================================
   STAGE 6 — TIMELINE (resolve + stream Box assets)
   ============================================================ */

// Resolve a plan asset reference (box://files/<id>, a numeric id, or a Box
// path like "raw/clip.mp4") to a Box file id.
export async function resolveBoxAsset(uriOrId) {
  const payload = await req("/api/box/resolve", {
    method: "POST",
    body: { uri: uriOrId },
    timeoutMs: 30000,
  });
  return payload.fileId;
}

// Direct, range-enabled stream URL for a Box file id (used as <video src>).
export function boxFileUrl(fileId) {
  return `${API_BASE}/api/box/file/${encodeURIComponent(fileId)}`;
}
