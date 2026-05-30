import { request } from 'undici';
import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { Creator, Niche } from './types.js';

// Strategy:
// 1. Niche stage already wrote 3-5 distinct web-search queries (varying angle/breadth).
// 2. We run EACH query through Tavily, REGEX out real instagram.com/<handle> URLs from
//    the snippets, and union the candidates across all queries. Frequency (a handle
//    appearing in multiple queries) ranks higher.
// 3. If the pool is still smaller than MIN_CREATORS, fall back to adjacent-niche queries.
// 4. GPT-4o-mini picks the top N from the pooled list and writes a "why" line.
//    If GPT discards everything, we use the top frequency-ranked candidates directly.

const MIN_CREATORS = 3;
const TARGET_CREATORS = 3;

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

// Words that appear as instagram.com/<word>/ but aren't user handles —
// IG hub pages, app routes, generic categories, marketing pages. Without
// this filter "instagram.com/popular/" sneaks in and the scraper wastes
// minutes retrying a non-existent profile.
const HANDLE_BLOCKLIST = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'accounts', 'directory',
  'about', 'developer', 'legal', 'press', 'api', 'web', 'tags', 'topics',
  'popular', 'trending', 'login', 'signup', 'session', 'graphql', 'ajax',
  'create', 'media', 'invites', 'shop', 'feed', 'home', 'help', 'oauth',
  'privacy', 'terms', 'safety', 'business', 'features', 'download',
  'blog', 'careers', 'contact',
]);

type Pool = Map<string, { count: number; snippets: string[] }>;

function addToPool(pool: Pool, results: Awaited<ReturnType<typeof tavilySearch>>) {
  const re = /\b(?:www\.)?instagram\.com\/([A-Za-z0-9._]+)/g;
  for (const r of results) {
    const text = `${r.title}\n${r.url}\n${r.content}`;
    const matches = new Set<string>();
    for (const m of text.matchAll(re)) {
      const h = m[1].toLowerCase().replace(/[/?#].*$/, '');
      if (!h || h.length < 2 || h.length > 30) continue;
      if (HANDLE_BLOCKLIST.has(h)) continue;
      matches.add(h);
    }
    for (const h of matches) {
      const entry = pool.get(h) ?? { count: 0, snippets: [] };
      entry.count += 1;
      if (entry.snippets.length < 3) entry.snippets.push(text.slice(0, 280));
      pool.set(h, entry);
    }
  }
}

function poolToCandidates(pool: Pool): string[] {
  return [...pool.entries()].sort((a, b) => b[1].count - a[1].count).map(([h]) => h);
}

function isUsableQuery(q: string): boolean {
  const trimmed = q.trim();
  if (trimmed.length < 4) return false;
  // GPT sometimes returns placeholders like "entrepreneurship in [City]" or
  // "<niche> creators". Skip anything with unfilled brackets.
  if (/[\[\]<>{}]/.test(trimmed)) return false;
  return true;
}

async function runQueriesIntoPool(queries: string[], perQueryMax: number): Promise<Pool> {
  const pool: Pool = new Map();
  for (const q of queries) {
    if (!isUsableQuery(q)) {
      console.error(`[creators] skipping placeholder query: ${q}`);
      continue;
    }
    console.error(`[creators] tavily query: ${q}`);
    try {
      const results = await tavilySearch(q, perQueryMax);
      addToPool(pool, results);
      console.error(`[creators]   ${results.length} results -> pool size ${pool.size}`);
    } catch (err) {
      console.error(`[creators]   tavily failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (pool.size >= TARGET_CREATORS * 3) break; // plenty to rank from
  }
  return pool;
}

const RANK_SYSTEM = `You rank Instagram creator handles for a niche. The user gives you:
- a niche definition
- a candidate list of REAL handles already extracted from web search results, with frequency
- the search snippets where each handle appeared

Pick the top N handles best matching the niche. ONLY return handles from the candidate list —
never invent new ones. Prefer handles that show up across multiple search angles (higher
frequency). If fewer than N fit, return fewer. Return JSON only.`;

export async function findTopCreators(niche: Niche): Promise<Creator[]> {
  const env = loadEnv();
  // Honor TAVILY_TOP_N if set, but cap at TARGET_CREATORS to keep Apify hits
  // low (default 3). Larger values blow past Instagram's anti-bot thresholds.
  const topN = Math.min(Math.max(env.TAVILY_TOP_N, MIN_CREATORS), TARGET_CREATORS);

  // 1. Run all of the niche's primary queries.
  const primary = niche.search_queries?.length
    ? niche.search_queries
    : [`top instagram creators ${niche.label} ${niche.keywords.slice(0, 3).join(' ')}`];
  let pool = await runQueriesIntoPool(primary, Math.max(topN * 3, 12));

  // 2. If we still don't have enough, widen with adjacent niches.
  if (pool.size < MIN_CREATORS && niche.adjacent_niches?.length) {
    console.error(`[creators] only ${pool.size} candidates; falling back to adjacent niches`);
    const adjacentQueries = niche.adjacent_niches.map(
      (n) => `top instagram creators ${n}`,
    );
    const extra = await runQueriesIntoPool(adjacentQueries, Math.max(topN * 2, 10));
    for (const [h, entry] of extra) {
      const cur = pool.get(h) ?? { count: 0, snippets: [] };
      pool.set(h, {
        count: cur.count + entry.count,
        snippets: [...cur.snippets, ...entry.snippets].slice(0, 3),
      });
    }
  }

  // 3. Last resort: keywords-only blast.
  if (pool.size < MIN_CREATORS) {
    console.error(`[creators] still ${pool.size}; last-resort keyword blast`);
    const blast = await runQueriesIntoPool(
      [niche.keywords.slice(0, 5).join(' ') + ' instagram creator'],
      20,
    );
    for (const [h, entry] of blast) {
      const cur = pool.get(h) ?? { count: 0, snippets: [] };
      pool.set(h, {
        count: cur.count + entry.count,
        snippets: [...cur.snippets, ...entry.snippets].slice(0, 3),
      });
    }
  }

  const candidates = poolToCandidates(pool);
  console.error(`[creators] pool size: ${candidates.length} candidates`);
  if (candidates.length === 0) return [];

  // 4. Ask GPT to rank from the real pool.
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const snippetBlock = candidates
    .slice(0, 30)
    .map((h) => {
      const entry = pool.get(h)!;
      return `@${h} (seen ${entry.count}x):\n  ${entry.snippets.join('\n  ')}`;
    })
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
          `Candidate handles (real, with frequency + snippets):\n${snippetBlock}\n\n` +
          `Return JSON: { "creators": [{ "handle": "...", "display_name": "...", "why": "..." }] }. ` +
          `Pick ${topN} (or as many as fit, minimum ${MIN_CREATORS}). Handles MUST come from the list.`,
      },
    ],
  });

  const raw = gpt.choices[0]?.message?.content ?? '{}';
  const parsed = RankedSchema.parse(JSON.parse(raw));

  const candidateSet = new Set(candidates);
  let ranked = parsed.creators.filter((c) => candidateSet.has(c.handle)).slice(0, topN);

  // 5. If GPT returned fewer than MIN_CREATORS, top up with the most-frequent candidates.
  if (ranked.length < MIN_CREATORS) {
    const have = new Set(ranked.map((c) => c.handle));
    for (const h of candidates) {
      if (ranked.length >= MIN_CREATORS) break;
      if (have.has(h)) continue;
      ranked.push({
        handle: h,
        display_name: undefined as string | undefined,
        why: `Frequency fallback (appeared in ${pool.get(h)!.count} searches).`,
      });
      have.add(h);
    }
  }

  console.error(`[creators] returning ${ranked.length} creators`);
  return ranked.map<Creator>((c) => ({
    handle: c.handle,
    display_name: c.display_name,
    profile_url: `https://www.instagram.com/${c.handle}/`,
    source: 'tavily',
    why: c.why,
  }));
}
