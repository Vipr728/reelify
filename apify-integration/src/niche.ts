import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { Niche } from './types.js';

const NicheSchema = z.object({
  label: z.string().min(2),
  keywords: z.array(z.string()).min(3).max(12),
  audience: z.string().min(4),
  rationale: z.string().min(4),
  search_queries: z.array(z.string().min(4)).min(3).max(6),
  adjacent_niches: z.array(z.string()).max(5).default([]),
});

const SYSTEM = `You categorize short-form personal-brand creator content (Instagram Reels / TikTok),
then write 3-5 distinct web-search queries that a discovery API (Tavily) can use to find REAL
top creators in that niche.

Steps you take internally:
1. Read the transcript and identify the niche with surgical precision.
   Prefer "solo founder build-in-public" over "entrepreneurship".
   Prefer "early-20s fitness for skinny guys" over "fitness".
2. Pick the audience and 3-12 keyword phrases that real creators in this niche use.
3. Write 3-5 SEARCH QUERIES targeting Instagram creator-discovery sites
   (instagram.com, socialblade.com, hypeauditor.com, creatordb.app). Vary the angle:
   one narrow, one broad, one with a specific format ("reels"/"motivational"/"founder story"),
   one with a city or sub-segment if it fits. Each query should be a single line of text.
4. List 2-5 ADJACENT niches the creator's audience overlaps with — used as fallback if
   the primary queries don't find enough real handles.

Return JSON only matching the schema. Do not include the search engine name in the query strings;
just write the search the user would type.`;

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
          `Return JSON with keys: label, keywords (3-12 strings), audience, rationale, ` +
          `search_queries (3-5 distinct queries varying angle/breadth), ` +
          `adjacent_niches (2-5 nearby niches for fallback).`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  return NicheSchema.parse(JSON.parse(raw));
}
