// OpenAI helpers (Deno / Supabase edge runtime).
// Set OPENAI_API_KEY as a Supabase function secret.

const OPENAI = "https://api.openai.com/v1";
const key = () => Deno.env.get("OPENAI_API_KEY")!;

// Whisper speech-to-text. `bytes` is the raw clip downloaded from Box.
export async function transcribe(bytes: Uint8Array, filename = "clip.mp4"): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes]), filename);
  form.append("model", "whisper-1");
  const res = await fetch(`${OPENAI}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key()}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper failed: ${await res.text()}`);
  return (await res.json()).text ?? "";
}

export async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OPENAI}/embeddings`, {
    method: "POST",
    headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embed failed: ${await res.text()}`);
  return (await res.json()).data[0].embedding;
}

async function chatJSON(system: string, user: string): Promise<any> {
  const res = await fetch(`${OPENAI}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Chat failed: ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

// Pull the structured datapoint out of a transcript.
export async function extractDatapoint(transcript: string) {
  return await chatJSON(
    "You label short vertical video clips. Return ONLY JSON with keys: " +
      "topic (string), keywords (string array, max 8), sentiment " +
      "('positive'|'neutral'|'negative'), hook_candidate (bool, is this a strong opener), " +
      "broll_candidate (bool, works as a silent cutaway).",
    `Transcript: """${transcript}"""`,
  );
}

// Produce the edit decision list the FFmpeg worker executes.
// `clips` and `trends` are compact summaries the orchestrator assembles.
export async function generateEDL(topic: string, clips: unknown[], trends: unknown[]) {
  return await chatJSON(
    "You are a short-form video editor. Given a topic, the user's available clips, " +
      "and currently trending reels, return ONLY JSON: " +
      "{ target_duration_s:number, segments:[{clip_id:string,in_s:number,out_s:number," +
      "caption:string}], transitions:[{after_index:number,type:'xfade',duration_s:number}], " +
      "broll:[{clip_id:string,over_index:number,start_s:number,duration_s:number}] }. " +
      "Put the strongest hook clip first. Match total length to the trend norm.",
    JSON.stringify({ topic, clips, trends }),
  );
}
