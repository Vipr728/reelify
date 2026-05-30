/* ============ REELIFY — edit-plan normalizer (Stage 6) ============ */
// Stage 6 ingests a JSON edit plan and turns it into a real timeline.
// Two input shapes are accepted and normalized to ONE internal model:
//
//   A) "Project" authoring format:
//      { version, project{title,targetDurationSec,aspectRatio,style},
//        assets:{ talkingHead:[{id,source,description}], broll:[...] },
//        timeline:[{id,type,assetId,sourceInSec,sourceOutSec,timelineInSec,
//                   timelineOutSec,caption:{text,emphasis[]},notes}],
//        captionStyle, editorNotes[] }
//
//   B) "EditPlan" machine format (matches llm-harness output):
//      { schemaVersion, output{aspectRatio,width,height,fps,durationSec},
//        assets:[{id,kind,uri,boxFileId?,durationSec?}],
//        tracks:[{id,kind:'video'|'caption',items:[...]}] }
//
// Normalized model:
//   { title, aspectRatio, width, height, fps, totalDuration,
//     assets: { [id]: { id, kind, uri, boxFileId } },
//     videoLanes: [ { id, role:'main'|'overlay', items:[ Item ] } ],
//     captions: [ { tlIn, tlOut, text, tokens:[{text,highlight}] } ],
//     captionStyle, editorNotes:[], format:'project'|'editplan', raw }
//   Item = { id, assetId, sourceIn, sourceOut, tlIn, tlOut, layout|null }

function dimsForAspect(aspect) {
  const m = String(aspect || "9:16").match(/^(\d+)\s*[:x]\s*(\d+)$/);
  const w = m ? Number(m[1]) : 9;
  const h = m ? Number(m[2]) : 16;
  // Normalize to a 1080-wide canvas (portrait) / 1080-tall (landscape).
  if (h >= w) return { width: 1080, height: Math.round((1080 * h) / w) };
  return { width: Math.round((1080 * w) / h), height: 1080 };
}

function fileIdFromUri(uri) {
  if (!uri) return null;
  const m = String(uri).match(/^box:\/\/files\/(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(String(uri).trim())) return String(uri).trim();
  return null;
}

function buildTokens(text, emphasis) {
  const set = new Set((emphasis || []).map((w) => String(w).toLowerCase()));
  return String(text || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ({
      text: word,
      highlight: set.has(word.toLowerCase().replace(/[^a-z0-9']/gi, "")),
    }));
}

function normalizeProject(json) {
  const project = json.project || {};
  const dims = dimsForAspect(project.aspectRatio);
  const assets = {};
  const addAssets = (arr, kind) =>
    (arr || []).forEach((a) => {
      assets[a.id] = { id: a.id, kind, uri: a.source || a.uri || null, boxFileId: a.boxFileId || fileIdFromUri(a.source || a.uri) };
    });
  addAssets(json.assets?.talkingHead, "talking_head");
  addAssets(json.assets?.broll, "broll");

  const items = (json.timeline || []).map((seg) => ({
    id: seg.id,
    type: seg.type,
    assetId: seg.assetId,
    sourceIn: seg.sourceInSec ?? 0,
    sourceOut: seg.sourceOutSec ?? 0,
    tlIn: seg.timelineInSec ?? 0,
    tlOut: seg.timelineOutSec ?? 0,
    layout: null,
  }));

  const mainItems = items.filter((it) => it.type !== "broll");
  const overlayItems = items.filter((it) => it.type === "broll");
  const videoLanes = [{ id: "video_main", role: "main", items: mainItems }];
  if (overlayItems.length) videoLanes.push({ id: "video_overlay", role: "overlay", items: overlayItems });

  const captions = (json.timeline || [])
    .filter((seg) => seg.caption && seg.caption.text)
    .map((seg) => ({
      tlIn: seg.timelineInSec ?? 0,
      tlOut: seg.timelineOutSec ?? 0,
      text: seg.caption.text,
      tokens: buildTokens(seg.caption.text, seg.caption.emphasis),
    }));

  const maxTl = items.reduce((m, it) => Math.max(m, it.tlOut), 0);
  return {
    title: project.title || "Untitled reel",
    aspectRatio: project.aspectRatio || "9:16",
    width: dims.width,
    height: dims.height,
    fps: 30,
    totalDuration: project.targetDurationSec || maxTl || 1,
    assets,
    videoLanes,
    captions,
    captionStyle: json.captionStyle || null,
    editorNotes: json.editorNotes || [],
    format: "project",
    raw: json,
  };
}

function normalizeEditPlanFormat(json) {
  const output = json.output || {};
  const dims = output.width && output.height ? { width: output.width, height: output.height } : dimsForAspect(output.aspectRatio);

  const assets = {};
  (json.assets || []).forEach((a) => {
    assets[a.id] = { id: a.id, kind: a.kind, uri: a.uri || null, boxFileId: a.boxFileId || fileIdFromUri(a.uri) };
  });

  const videoTracks = (json.tracks || []).filter((t) => t.kind === "video");
  const videoLanes = videoTracks.map((t, i) => ({
    id: t.id || `video_${i}`,
    role: i === 0 ? "main" : "overlay",
    items: (t.items || []).map((it) => ({
      id: it.id,
      assetId: it.assetId,
      sourceIn: it.sourceInSec ?? 0,
      sourceOut: it.sourceOutSec ?? 0,
      tlIn: it.timelineInSec ?? 0,
      tlOut: it.timelineOutSec ?? 0,
      layout: it.layout || null,
    })),
  }));

  const captionTrack = (json.tracks || []).find((t) => t.kind === "caption");
  const captions = (captionTrack?.items || []).map((it) => ({
    tlIn: it.timelineInSec ?? 0,
    tlOut: it.timelineOutSec ?? 0,
    text: it.text || (it.tokens || []).map((tk) => tk.text).join(" "),
    tokens: it.tokens && it.tokens.length ? it.tokens : buildTokens(it.text, []),
  }));

  const maxTl = videoLanes.reduce(
    (m, lane) => Math.max(m, lane.items.reduce((mm, it) => Math.max(mm, it.tlOut), 0)),
    0
  );
  return {
    title: json.title || "Untitled reel",
    aspectRatio: output.aspectRatio || "9:16",
    width: dims.width,
    height: dims.height,
    fps: output.fps || 30,
    totalDuration: output.durationSec || maxTl || 1,
    assets,
    videoLanes,
    captions,
    captionStyle: null,
    editorNotes: [],
    format: "editplan",
    raw: json,
  };
}

export function normalizeEditPlan(json) {
  if (!json || typeof json !== "object") throw new Error("Plan is not a JSON object.");
  if (Array.isArray(json.tracks)) return normalizeEditPlanFormat(json);
  if (Array.isArray(json.timeline)) return normalizeProject(json);
  throw new Error('Unrecognized plan: expected a "tracks" array (EditPlan) or a "timeline" array (project).');
}

// A ready-to-use sample (the EditPlan example) for the "Load sample" button.
export const SAMPLE_PLAN = {
  schemaVersion: "1.0",
  output: { aspectRatio: "9:16", width: 1080, height: 1920, fps: 30, durationSec: 6.7 },
  assets: [
    { id: "talk_001", kind: "talking_head", uri: "box://files/talk_001", durationSec: 60.2 },
    { id: "broll_001", kind: "broll", uri: "box://files/broll_001", durationSec: 8.4 },
  ],
  tracks: [
    {
      id: "video_main",
      kind: "video",
      items: [
        {
          id: "clip_001",
          assetId: "talk_001",
          sourceInSec: 0,
          sourceOutSec: 4.2,
          timelineInSec: 0,
          timelineOutSec: 4.2,
          layout: { mode: "fit", x: 0, y: 0, width: 1080, height: 1920 },
        },
      ],
    },
    {
      id: "video_overlay",
      kind: "video",
      items: [
        {
          id: "broll_001_use",
          assetId: "broll_001",
          sourceInSec: 1,
          sourceOutSec: 3.5,
          timelineInSec: 4.2,
          timelineOutSec: 6.7,
          layout: { mode: "cover", x: 0, y: 0, width: 1080, height: 1920 },
        },
      ],
    },
    {
      id: "captions",
      kind: "caption",
      items: [
        {
          id: "caption_001",
          timelineInSec: 0,
          timelineOutSec: 4.2,
          text: "Here is the fastest way to edit videos.",
          tokens: [
            { text: "Here", highlight: false },
            { text: "is", highlight: false },
            { text: "the", highlight: false },
            { text: "fastest", highlight: true },
            { text: "way", highlight: false },
            { text: "to", highlight: false },
            { text: "edit", highlight: false },
            { text: "videos.", highlight: true },
          ],
        },
      ],
    },
  ],
};
