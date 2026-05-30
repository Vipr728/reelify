import { request } from 'undici';
import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { Creator, Niche } from './types.js';

// Strategy:
// 1. Tavily searches the open web for "top Instagram creators in <niche>".
// 2. We REGEX out real instagram.com/<handle> URLs from Tavily's results —
//    grounds the candidate list in handles that actually appeared somewhere
//    instead of letting GPT invent them.
// 3. GPT-4o-mini picks the top N from that real list and writes a "why" line.

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

const RankedSchema = z.object({
  creators: z
    .array(
      z.object({
        handle: z
          .string()
          .min(1)
          .transform((s) => s.replace(/^@/, '').toLowerCase().trim()),
        display_name: z.string().optional(),
        why: z.string(),
      }),
    )
    .min(0),
});

async function tavilySearch(query: string, maxResults: number) {
  const env = loadEnv();
  const res = await request('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: env.TAVILY_API_KEY,
      query,
      search_depth: 'advanced',
      include_answer: false,
      max_results: maxResults,
      include_domains: ['instagram.com', 'socialblade.com', 'hypeauditor.com', 'creatordb.app'],
    }),
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`tavily search ${res.statusCode}: ${body}`);
  }
  const json = await res.body.json();
  return TavilyResultSchema.parse(json).results;
}

// IG path segments that aren't user handles.
const HANDLE_BLOCKLIST = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'directory',
  'about', 'developer', 'legal', 'press', 'api', 'web', 'tags', 'topics',
]);

function extractHandles(snippets: string[]): string[] {
  const re = /\b(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/g;
  const counts = new Map<string, number>();
  for (const text of snippets) {
    for (const m of text.matchAll(re)) {
      const h = m[1].toLowerCase().replace(/[/?#].*$/, '');
      if (!h || h.length < 2 || h.length > 30) continue;
      if (HANDLE_BLOCKLIST.has(h)) continue;
      counts.set(h, (counts.get(h) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

const RANK_SYSTEM = `You rank Instagram creator handles for a niche. The user gives you:
- a niche definition
- a candidate list of REAL handles already extracted from web search results
- the search snippets where each handle appeared

Pick the top N handles best matching the niche. ONLY return handles from the
candidate list — never invent new ones. If fewer than N fit, return fewer.
Return JSON only.`;

export async function findTopCreators(niche: Niche): Promise<Creator[]> {
  const env = loadEnv();
  const topN = env.TAVILY_TOP_N;

  const query = `top instagram creators ${niche.label} ${niche.keywords.slice(0, 3).join(' ')} site:instagram.com`;
  const results = await tavilySearch(query, Math.max(topN * 4, 15));

  const snippets = results.map((r) => `${r.title}\n${r.url}\n${r.content}`);
  const candidates = extractHandles(snippets);

  if (candidates.length === 0) return [];

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const snippetBlock = results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content}`)
    .join('\n\n');

  const gpt = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: RANK_SYSTEM },
      {
        role: 'user',
        content:
          `Niche: ${niche.label}\nAudience: ${niche.audience}\nKeywords: ${niche.keywords.join(', ')}\n\n` +
          `Candidate handles (REAL — extracted from search): ${candidates.join(', ')}\n\n` +
          `Search snippets:\n${snippetBlock}\n\n` +
          `Return JSON: { "creators": [{ "handle": "...", "display_name": "...", "why": "..." }] }. ` +
          `Pick at most ${topN}. Handles MUST come from the candidate list.`,
      },
    ],
  });

  const raw = gpt.choices[0]?.message?.content ?? '{}';
  const parsed = RankedSchema.parse(JSON.parse(raw));

  const candidateSet = new Set(candidates);
  const ranked = parsed.creators.filter((c) => candidateSet.has(c.handle)).slice(0, topN);

  // Fallback: if GPT discarded everything, take top candidates by frequency.
  const chosen = ranked.length
    ? ranked
    : candidates.slice(0, topN).map((handle) => ({
        handle,
        display_name: undefined as string | undefined,
        why: 'Extracted from Tavily results (GPT did not rank).',
      }));

  return chosen.map<Creator>((c) => ({
    handle: c.handle,
    display_name: c.display_name,
    profile_url: `https://www.instagram.com/${c.handle}/`,
    source: 'tavily',
    why: c.why,
  }));
}
