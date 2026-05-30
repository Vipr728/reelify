// Supabase edge function: make-reel
// Body: { topic: string }
// 1. embed topic -> pgvector match over the clip library
// 2. fetch trending reels from Apify (fallback to trend_cache)
// 3. GPT builds the edit decision list
// 4. enqueue a render job for the Fly.io worker

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { embed, generateEDL } from "../_shared/openai.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Call an Apify TikTok/Instagram scraper actor synchronously.
// Set APIFY_TOKEN and APIFY_ACTOR_ID as secrets.
async function fetchTrends(keywords: string[]): Promise<any[]> {
  const actor = Deno.env.get("APIFY_ACTOR_ID")!;
  const token = Deno.env.get("APIFY_TOKEN")!;
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Input shape depends on the chosen actor. Adjust to its schema.
    body: JSON.stringify({ searchQueries: keywords, resultsPerPage: 10 }),
  });
  if (!res.ok) throw new Error(`Apify failed: ${res.status}`);
  return await res.json();
}

// Defend the render worker from a bad GPT plan: only allow clip_ids that really
// exist, clamp trim points to each clip's known duration, drop dangling b-roll.
function validateEdl(edl: any, clips: any[]) {
  const byId = new Map(clips.map((c: any) => [c.id, c]));
  const segments = (edl.segments ?? [])
    .filter((s: any) => byId.has(s.clip_id))
    .map((s: any) => {
      const dur = byId.get(s.clip_id)?.duration_s ?? 60;
      const inS = Math.max(0, Math.min(Number(s.in_s) || 0, dur - 0.5));
      const outS = Math.max(inS + 0.5, Math.min(Number(s.out_s) || dur, dur));
      return { clip_id: s.clip_id, in_s: inS, out_s: outS, caption: String(s.caption ?? "").slice(0, 120) };
    });
  const idxSet = new Set(segments.map((_: any, i: number) => i));
  const transitions = (edl.transitions ?? []).filter((t: any) => idxSet.has(t.after_index));
  const broll = (edl.broll ?? []).filter((b: any) => byId.has(b.clip_id) && idxSet.has(b.over_index));
  return { target_duration_s: Number(edl.target_duration_s) || 20, segments, transitions, broll };
}

Deno.serve(async (req) => {
  try {
    const { topic } = await req.json();
    if (!topic) return new Response("topic required", { status: 400 });

    // 1. Similarity match over the user's clips.
    const qvec = await embed(topic);
    const { data: matches } = await sb.rpc("match_clips", {
      query_embedding: qvec,
      match_count: 12,
    });
    const clipIds = (matches ?? []).map((m: any) => m.clip_id);
    const { data: clips } = await sb
      .from("clips")
      .select("id, transcript, topic, keywords, duration_s, hook_candidate, broll_candidate")
      .in("id", clipIds.length ? clipIds : ["00000000-0000-0000-0000-000000000000"]);

    const keywords = [...new Set((clips ?? []).flatMap((c: any) => c.keywords ?? []))].slice(0, 6);

    // 2. Trends from Apify, fall back to cached rows so a live demo never dies.
    let trends: any[] = [];
    try {
      trends = await fetchTrends(keywords.length ? keywords : [topic]);
    } catch (e) {
      console.warn("Apify down, using trend_cache:", String(e));
      const { data: cached } = await sb
        .from("trend_cache")
        .select("caption, hashtags, views, duration_s")
        .limit(10);
      trends = cached ?? [];
    }
    const trendSummary = trends.slice(0, 10).map((t: any) => ({
      caption: t.caption ?? t.text ?? "",
      hashtags: t.hashtags ?? [],
      views: t.views ?? t.playCount ?? 0,
      duration_s: t.duration_s ?? t.duration ?? null,
    }));

    // 3. Build the edit decision list, then validate it against real clips.
    const rawEdl = await generateEDL(topic, clips ?? [], trendSummary);
    const edl = validateEdl(rawEdl, clips ?? []);
    if (!edl.segments.length) {
      return new Response(JSON.stringify({ error: "no usable clips for this topic" }), { status: 422 });
    }

    // 4. Enqueue the render.
    const { data: job } = await sb
      .from("render_jobs")
      .insert({ status: "queued", edl })
      .select("id")
      .single();

    return new Response(JSON.stringify({ job_id: job?.id, edl }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
