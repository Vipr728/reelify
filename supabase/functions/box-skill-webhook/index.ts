// Supabase edge function: box-skill-webhook
// Point your Box Custom Skill invocation_url here.
// Box pushes a payload with read/write tokens + the uploaded file id.
//
// Signature verification (Box webhooks v2) is implemented in _shared/boxSignature.ts
// and is OPT-IN: set BOX_SKILL_PRIMARY_KEY / BOX_SKILL_SECONDARY_KEY as function
// secrets to enforce it. With no keys set we run in hackathon mode (verification
// skipped, logged loudly). PRD §13: add real verification before production.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { downloadFile, writeSkillCards, writeDatapoint, getAppToken } from "../_shared/box.ts";
import { transcribe, extractDatapoint, embed } from "../_shared/openai.ts";
import { verifyBoxSignature, boxSignatureKeysFromEnv } from "../_shared/boxSignature.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    // Read the RAW body first: signature verification must hash the exact bytes
    // Box signed, before we JSON.parse.
    const rawBody = await req.text();

    // Opt-in signature check. If keys are configured, a bad signature is rejected.
    // If no keys are configured, proceed (hackathon mode) but warn.
    const keys = boxSignatureKeysFromEnv();
    const keysConfigured = !!(keys.primaryKey || keys.secondaryKey);
    if (keysConfigured) {
      const ok = await verifyBoxSignature(rawBody, req.headers, keys);
      if (!ok) {
        console.warn("Rejected Box payload: invalid/expired signature");
        return new Response("invalid signature", { status: 401 });
      }
    } else {
      console.warn(
        "BOX_SKILL_*_KEY not set — skipping signature verification (hackathon mode)",
      );
    }

    const payload = JSON.parse(rawBody);

    // Shape per Box Skills payload docs.
    const fileId: string = payload.source?.id;
    const skillId: string = payload.skill?.id;
    const invocationId: string = payload.id;
    const readToken: string = payload.token?.read?.access_token;
    const writeToken: string = payload.token?.write?.access_token;
    if (!fileId || !readToken) return new Response("bad payload", { status: 400 });

    // 1. Download the clip from Box and transcribe it (text + duration seconds).
    const bytes = await downloadFile(readToken, fileId);
    const { text: transcript, duration } = await transcribe(bytes);

    // Surface progress early: flip an existing row (the app's optimistic
    // 'uploaded' insert) to 'transcribed' with the transcript + duration so the
    // library badge advances while the rest of the pipeline runs. No-op if the
    // row doesn't exist yet (e.g. a manual Box upload with no app insert).
    await sb
      .from("clips")
      .update({ status: "transcribed", transcript, duration_s: duration })
      .eq("box_file_id", fileId);

    // 2. Extract the structured datapoint.
    const dp = await extractDatapoint(transcript);

    // 3. Embed and store the vector for similarity search later.
    const vector = await embed(transcript || dp.topic || "untitled clip");

    // 4. Write skill cards back to Box (shows in the Box preview sidebar).
    if (writeToken && skillId) {
      await writeSkillCards(writeToken, skillId, invocationId, {
        transcript: transcript || "(no speech detected)",
        keywords: dp.keywords ?? [],
      });
    }

    // 5. Write the richer datapoint to the metadata template (app token).
    const appToken = await getAppToken();
    await writeDatapoint(appToken, fileId, {
      topic: dp.topic ?? "",
      sentiment: dp.sentiment ?? "neutral",
      hook_candidate: !!dp.hook_candidate,
      broll_candidate: !!dp.broll_candidate,
    });

    // 6. Upsert into Supabase (status -> analyzed) + store the embedding.
    const { data: clip } = await sb
      .from("clips")
      .upsert({
        box_file_id: fileId,
        status: "analyzed",
        transcript,
        topic: dp.topic,
        keywords: dp.keywords ?? [],
        sentiment: dp.sentiment,
        duration_s: duration,
        has_speech: !!transcript,
        hook_candidate: !!dp.hook_candidate,
        broll_candidate: !!dp.broll_candidate,
      }, { onConflict: "box_file_id" })
      .select("id")
      .single();

    if (clip) {
      // Replace any prior embedding so re-analysis doesn't duplicate vectors.
      await sb.from("clip_embeddings").delete().eq("clip_id", clip.id);
      await sb.from("clip_embeddings").insert({ clip_id: clip.id, embedding: vector });
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
