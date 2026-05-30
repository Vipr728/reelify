import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { CreatorPatternReport, Recipe } from './types.js';

// Folds the per-creator patterns into ONE concrete recipe a downstream
// editor LLM can execute. Specific numbers, positions, colors, timings.
// This is the only LLM step in the whole pipeline; everything before it
// was deterministic ffmpeg / OCR or constrained extraction.

// GPT-4o-mini occasionally returns booleans as "yes"/"no"/"true" strings and
// numbers/nulls as strings, so every primitive is preprocessed before the
// strict zod type. We also retry once if the first parse fails.

const boolish = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'on', 'present', 'use'].includes(s)) return true;
    if (['false', 'no', 'n', '0', 'off', 'none', 'absent', 'skip'].includes(s)) return false;
  }
  return v;
}, z.boolean());

const num = z.preprocess((v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return v;
}, z.number());

const nullableNum = z.preprocess((v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '' || s === 'null' || s === 'none' || s === 'to end') return null;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return v;
}, z.number().nullable());

const nullableStr = z.preprocess((v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && ['', 'null', 'none'].includes(v.trim().toLowerCase())) return null;
  return v;
}, z.string().nullable());

// Required strings the model sometimes nulls/empties when a feature is "absent".
// Fall back to a sane default instead of failing the whole recipe.
const strOr = (fallback: string) =>
  z.preprocess((v) => {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'string' && v.trim() === '') return fallback;
    return v;
  }, z.string().min(1));

// Enums the model sometimes nulls — coerce null/empty to a default member.
const enumOr = <T extends [string, ...string[]]>(values: T, fallback: T[number]) =>
  z.preprocess((v) => (v === null || v === undefined || v === '' ? fallback : v), z.enum(values));

const RecipeSchema = z.object({
  target_duration_s: num.pipe(z.number().positive()),
  pacing: z.object({
    total_cuts: num.pipe(z.number().int().nonnegative()),
    cuts_per_10s: num.pipe(z.number().nonnegative()),
    avg_cut_interval_s: num.pipe(z.number().nonnegative()),
    pattern: strOr('steady'),
  }),
  captions: z.object({
    present: boolish,
    style: strOr('sentence'),
    position: enumOr(['top', 'center', 'bottom'], 'bottom'),
    size_px: num.pipe(z.number().nonnegative()),
    color: strOr('#FFFFFF'),
    background: nullableStr,
    animation: nullableStr,
  }),
  broll: z.object({
    use: boolish,
    count: num.pipe(z.number().int().nonnegative()),
    avg_duration_s: num.pipe(z.number().nonnegative()),
    placement: strOr('evenly spaced'),
    suggested_kinds: z.array(z.string()).default([]),
  }),
  audio: z.object({
    music: boolish,
    start_at_s: num.pipe(z.number().nonnegative()),
    end_at_s: nullableNum,
    pattern: enumOr(['throughout', 'intro-only', 'outro-only', 'gaps'], 'throughout'),
    suggested_genre: strOr('ambient'),
  }),
  hook: z.object({
    style: strOr('direct statement'),
    duration_s: num.pipe(z.number().nonnegative()),
  }),
  summary: strOr('Synthesized from the available creator stats.'),
});

const SYSTEM = `You are an editor briefing a downstream reel-assembly LLM that has no judgment of its own.

You receive:
- the user's transcript (the words that will be spoken in the reel)
- the niche the reel is in
- quantified style stats from the top creators in that niche

Your job: synthesize ONE concrete recipe the assembly LLM can execute step by step.

Rules:
- Average across creators when they agree. When they diverge, pick what fits the user's transcript.
- Use real numbers, never ranges ("3.2 cuts per 10s", not "3-4").
- Booleans must be JSON true / false (NOT "yes" / "no" / "true").
- Numbers must be JSON numbers (NOT strings like "24").
- Nullable fields use JSON null (NOT "null").
- For colors, suggest a concrete hex value.
- Be opinionated — vague answers force the assembly LLM to guess.

Output JSON only, exactly matching the schema. No prose outside the JSON.`;

function buildPrompt(report: CreatorPatternReport): string {
  const stats = report.per_creator ?? [];
  const block = stats
    .map((p, i) => {
      const lines = [
        `[creator ${i + 1}: @${p.creator.handle}] — ${p.videos_analyzed} videos`,
        `  duration ~${p.avg.duration_s.toFixed(1)}s`,
        `  pacing: ${p.avg.cuts_per_10s.toFixed(2)} cuts/10s, avg scene ${p.avg.avg_scene_duration_s.toFixed(2)}s, longest ${p.avg.longest_scene_s.toFixed(1)}s`,
        `  b-roll proxy: ${(p.avg.short_scenes_ratio * 100).toFixed(0)}% short scenes (<2s)`,
        `  captions: present=${p.dominant.captions_present}, position=${p.dominant.caption_position}, ~${p.avg.caption_size_px.toFixed(0)}px, coverage ${(p.avg.caption_coverage_rate * 100).toFixed(0)}%`,
        `  audio: pattern=${p.dominant.audio_pattern}, coverage ${(p.avg.audio_coverage_rate * 100).toFixed(0)}%`,
        `  instructions: ${p.instructions}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');

  return [
    `Niche: ${report.niche.label}`,
    `Audience: ${report.niche.audience}`,
    `Niche keywords: ${report.niche.keywords.join(', ')}`,
    '',
    `User's transcript (these are the words spoken in the reel):`,
    `"""`,
    report.source.script_text,
    `"""`,
    '',
    `Top creators in this niche — quantified stats:`,
    block || '(none — no creators analyzed)',
    '',
    `Return JSON with the EXACT shape below. Boolean fields are true/false (not strings).`,
    '```json',
    '{',
    '  "target_duration_s": 24,',
    '  "pacing": { "total_cuts": 8, "cuts_per_10s": 3.3, "avg_cut_interval_s": 3.0, "pattern": "fast hook in first 3s, steady middle, snap outro" },',
    '  "captions": { "present": true, "style": "word-by-word", "position": "bottom", "size_px": 48, "color": "#FFFFFF", "background": "#000000CC", "animation": "pop-in" },',
    '  "broll":    { "use": true, "count": 4, "avg_duration_s": 1.8, "placement": "every ~5s, evenly spaced", "suggested_kinds": ["screen recording", "stock footage"] },',
    '  "audio":    { "music": true, "start_at_s": 0, "end_at_s": null, "pattern": "throughout", "suggested_genre": "lofi hip-hop" },',
    '  "hook":     { "style": "rhetorical question", "duration_s": 3 },',
    '  "summary":  "..."',
    '}',
    '```',
  ].join('\n');
}

async function callOpenAi(
  client: OpenAI,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
): Promise<string> {
  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages,
  });
  return res.choices[0]?.message?.content ?? '{}';
}

export async function synthesizeRecipe(report: CreatorPatternReport): Promise<Recipe> {
  if (!report.per_creator || report.per_creator.length === 0) {
    throw new Error(
      'synthesizeRecipe: report has no per_creator data. Run aggregate first (don\'t skip quantify).',
    );
  }
  const env = loadEnv();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const userPrompt = buildPrompt(report);

  const first = await callOpenAi(client, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt },
  ]);

  try {
    return RecipeSchema.parse(JSON.parse(first));
  } catch (err) {
    const msg = err instanceof z.ZodError ? JSON.stringify(err.issues) : String(err);
    console.error('[synthesize] first attempt failed schema; retrying with feedback:', msg.slice(0, 400));

    const second = await callOpenAi(client, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
      { role: 'assistant', content: first },
      {
        role: 'user',
        content:
          `Your previous response failed schema validation:\n${msg}\n\n` +
          `Return CORRECTED JSON only. Booleans must be true/false (not "yes"/"no"/"true"). ` +
          `Numbers must be JSON numbers (not strings). Nullable fields use JSON null.`,
      },
    ]);

    return RecipeSchema.parse(JSON.parse(second));
  }
}
