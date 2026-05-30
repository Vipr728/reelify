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

async function tavilySearch(query: string, maxResults: number, includeDomains?: string[]) {
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
      // NOTE: restricting to instagram.com makes Tavily return individual
      // post/reel URLs (instagram.com/reel/..., /p/...) whose path segment is
      // not a handle. Leaving domains open surfaces aggregator/listicle pages
      // (socialblade, blogs) that actually name creator handles in their text.
      ...(includeDomains && includeDomains.length ? { include_domains: includeDomains } : {}),
    }),
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`tavily search ${res.statusCode}: ${body}`);
  }
  const json = await res.body.json();
  return TavilyResultSchema.parse(json).results;
}

// IG path segments / generic words that aren't user handles.
const HANDLE_BLOCKLIST = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'directory',
  'about', 'developer', 'legal', 'press', 'api', 'web', 'tags', 'topics',
  'popular', 'create', 'login', 'signup', 'help', 'privacy', 'terms',
  'instagram', 'igtv', 'channel',
  // generic single words that resolve to real-but-irrelevant IG pages
  'edit', 'edits', 'editing', 'video', 'videos', 'ai', 'reel', 'content',
  'creator', 'creators', 'app', 'apps', 'tools', 'tool', 'media', 'official',
]);

function addHandle(counts: Map<string, number>, raw: string, weight = 1) {
  const h = raw.toLowerCase().replace(/[/?#].*$/, '').trim();
  if (!h || h.length < 2 || h.length > 30) return;
  if (HANDLE_BLOCKLIST.has(h)) return;
  if (!/^[a-z0-9._]+$/.test(h)) return;
  if (!/[a-z]/.test(h)) return; // skip pure-number/punctuation tokens
  counts.set(h, (counts.get(h) ?? 0) + weight);
}

function extractHandles(snippets: string[]): string[] {
  // 1) instagram.com/<handle> profile URLs (NOT /p/ or /reel/ post URLs).
  const urlRe = /\b(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/g;
  // 2) @handle mentions in titles/snippet text (how listicles name creators).
  const atRe = /(?:^|[\s(>"'])@([A-Za-z0-9._]{2,30})\b/g;
  const counts = new Map<string, number>();

  for (const text of snippets) {
    for (const m of text.matchAll(urlRe)) {
      const seg = m[1].toLowerCase();
      // skip post/reel/tv URLs whose first segment is a content type
      if (HANDLE_BLOCKLIST.has(seg)) continue;
      addHandle(counts, seg, 2); // profile URL is a strong signal
    }
    for (const m of text.matchAll(atRe)) {
      addHandle(counts, m[1], 1);
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

  // Open-web search (no site: restriction). Aggregator/listicle pages name the
  // actual creator handles in their text; instagram.com-only results were just
  // individual post URLs with no handle in the path.
  const query = `best instagram creators ${niche.label} ${niche.keywords.slice(0, 3).join(' ')}`;
  const results = await tavilySearch(query, Math.max(topN * 4, 15));

  const snippets = results.map((r) => `${r.title}\n${r.url}\n${r.content}`);
  let candidates = extractHandles(snippets);

  // Fallback: if the open query found nothing, retry restricted to instagram.com.
  if (candidates.length === 0) {
    const fallback = await tavilySearch(
      `instagram ${niche.label} ${niche.keywords.slice(0, 3).join(' ')}`,
      Math.max(topN * 4, 15),
      ['instagram.com', 'socialblade.com', 'hypeauditor.com'],
    );
    candidates = extractHandles(fallback.map((r) => `${r.title}\n${r.url}\n${r.content}`));
  }

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

  return chosen.slice(0, topN).map<Creator>((c) => ({
    handle: c.handle,
    display_name: c.display_name,
    profile_url: `https://www.instagram.com/${c.handle}/`,
    source: 'tavily',
    why: (c as { why?: string }).why || 'Matched your niche.',
  }));
}
