// Supabase edge function: box-skill-webhook
// Point your Box Custom Skill invocation_url here.
// Box pushes a payload with read/write tokens + the uploaded file id.
//
// TODO before production: verify Box signatures (BOX_SKILL_PRIMARY_KEY /
// SECONDARY_KEY headers) before trusting the payload. Skipped here for brevity.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { downloadFile, writeSkillCards, writeDatapoint, getAppToken } from "../_shared/box.ts";
import { transcribe, extractDatapoint, embed } from "../_shared/openai.ts";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  try {
    const payload = await req.json();

    // Shape per Box Skills payload docs.
    const fileId: string = payload.source?.id;
    const skillId: string = payload.skill?.id;
    const invocationId: string = payload.id;
    const readToken: string = payload.token?.read?.access_token;
    const writeToken: string = payload.token?.write?.access_token;
    if (!fileId || !readToken) return new Response("bad payload", { status: 400 });

    // 1. Download the clip from Box and transcribe it.
    const bytes = await downloadFile(readToken, fileId);
    const transcript = await transcribe(bytes);

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

    // 6. Upsert into Supabase + store the embedding.
    const { data: clip } = await sb
      .from("clips")
      .upsert({
        box_file_id: fileId,
        status: "analyzed",
        transcript,
        topic: dp.topic,
        keywords: dp.keywords ?? [],
        sentiment: dp.sentiment,
        has_speech: !!transcript,
        hook_candidate: !!dp.hook_candidate,
        broll_candidate: !!dp.broll_candidate,
      }, { onConflict: "box_file_id" })
      .select("id")
      .single();

    if (clip) {
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
