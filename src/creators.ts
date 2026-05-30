import { request } from 'undici';
import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { Creator, Niche } from './types.js';

// Strategy:
// 1. Ask Tavily to search the open web for "top Instagram creators in <niche>".
//    Tavily returns ranked results with snippets — good for discovery, bad at
//    handing us clean IG handles.
// 2. Hand Tavily's snippets to GPT to extract the top N IG handles + a "why".
//    GPT is the right tool here — pattern extraction from messy text.

const TavilyResultSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().optional().default(''),
      url: z.string().optional().default(''),
      content: z.string().optional().default(''),
      score: z.number().optional(),
    }),
  ),
});

const CreatorsSchema = z.object({
  creators: z
    .array(
      z.object({
        handle: z
          .string()
          .min(1)
          .transform((s) => s.replace(/^@/, '').trim()),
        display_name: z.string().optional(),
        why: z.string(),
      }),
    )
    .min(1),
});

async function tavilySearch(query: string, topN: number) {
  const env = loadEnv();
  const res = await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: 'advanced',
      include_answer: false,
      max_results: Math.max(topN * 3, 10), // overfetch so GPT can dedupe + rank
      include_domains: ['instagram.com', 'socialblade.com', 'hypeauditor.com'],
    }),
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`tavily search ${res.statusCode}: ${body}`);
  }
  const json = await res.body.json();
  return TavilyResultSchema.parse(json).results;
}

const EXTRACT_SYSTEM = `You extract Instagram creator handles from search results.
Given a niche and a list of search snippets, return up to N handles that best
fit the niche. Prefer creators who actively post short-form content there.
Skip news outlets, brands, and aggregator accounts. Skip handles that look invented.
Return JSON only.`;

export async function findTopCreators(niche: Niche): Promise<Creator[]> {
  const env = loadEnv();
  const topN = env.TAVILY_TOP_N;

  const query =
    `top instagram creators in "${niche.label}" niche site:instagram.com ` +
    niche.keywords.slice(0, 4).join(' ');
  const results = await tavilySearch(query, topN);

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const snippets = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n');

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      {
        role: 'user',
        content:
          `Niche: ${niche.label}\nAudience: ${niche.audience}\nKeywords: ${niche.keywords.join(', ')}\n\n` +
          `Search snippets:\n${snippets}\n\n` +
          `Return JSON: { "creators": [{ "handle": "...", "display_name": "...", "why": "..." }] }. ` +
          `Return at most ${topN} creators.`,
      },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  const parsed = CreatorsSchema.parse(JSON.parse(raw));

  return parsed.creators.slice(0, topN).map<Creator>((c) => ({
    handle: c.handle,
    display_name: c.display_name,
    profile_url: `https://www.instagram.com/${c.handle}/`,
    source: 'tavily',
    why: c.why,
  }));
}
