import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { Niche } from './types.js';

const NicheSchema = z.object({
  label: z.string().min(2),
  keywords: z.array(z.string()).min(3).max(12),
  audience: z.string().min(4),
  rationale: z.string().min(4),
});

const SYSTEM = `You categorize short-form personal-brand creator content (Instagram Reels / TikTok).
Given a transcript of a creator talking to camera, return the *niche* they're operating in:
a tight label, search keywords a discovery API could use to find similar creators, the audience,
and a one-sentence rationale.

Return JSON only, matching the schema. Be specific: prefer "solo founder build-in-public" over
"entrepreneurship". Prefer "early-20s fitness for skinny guys" over "fitness".`;

export async function inferNiche(transcript: string): Promise<Niche> {
  const env = loadEnv();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `Transcript:\n"""\n${transcript}\n"""\n\n` +
          `Return JSON with keys: label, keywords (3-12 strings), audience, rationale.`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  const parsed = NicheSchema.parse(JSON.parse(raw));
  return parsed;
}
