import OpenAI from 'openai';
import { z } from 'zod';
import { loadEnv } from './env.js';
import type { CreatorPatternReport, Recipe } from './types.js';

// Folds the per-creator patterns into ONE concrete recipe a downstream
// editor LLM can execute. Specific numbers, positions, colors, timings.
// This is the only LLM step in the whole pipeline; everything before it
// was deterministic ffmpeg / OCR or constrained extraction.

const RecipeSchema = z.object({
  target_duration_s: z.number().positive(),
  pacing: z.object({
    total_cuts: z.number().int().nonnegative(),
    cuts_per_10s: z.number().nonnegative(),
    avg_cut_interval_s: z.number().nonnegative(),
    pattern: z.string().min(1),
  }),
  captions: z.object({
    present: z.boolean(),
    style: z.string().min(1),
    position: z.enum(['top', 'center', 'bottom']),
    size_px: z.number().nonnegative(),
    color: z.string().min(1),
    background: z.string().nullable(),
    animation: z.string().nullable(),
  }),
  broll: z.object({
    use: z.boolean(),
    count: z.number().int().nonnegative(),
    avg_duration_s: z.number().nonnegative(),
    placement: z.string().min(1),
    suggested_kinds: z.array(z.string()).default([]),
  }),
  audio: z.object({
    music: z.boolean(),
    start_at_s: z.number().nonnegative(),
    end_at_s: z.number().nullable(),
    pattern: z.enum(['throughout', 'intro-only', 'outro-only', 'gaps']),
    suggested_genre: z.string().min(1),
  }),
  hook: z.object({
    style: z.string().min(1),
    duration_s: z.number().nonnegative(),
  }),
  summary: z.string().min(1),
});

const SYSTEM = `You are an editor briefing a downstream reel-assembly LLM that has no judgment of its own.

You receive:
- the user's transcript (the words that will be spoken in the reel)
- the niche the reel is in
- quantified style stats from the top creators in that niche

Your job: synthesize ONE concrete recipe the assembly LLM can execute step by step.

Rules:
- Average across creators when they agree on something. When they diverge, pick what fits the user's transcript.
- Use real numbers, never ranges ("3.2 cuts per 10s", not "3-4").
- For colors, suggest a concrete hex value (white captions on a black box is fine if you can't tell).
- Be opinionated. Vague answers force the assembly LLM to guess.

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
    `Return JSON with: target_duration_s, pacing { total_cuts, cuts_per_10s, avg_cut_interval_s, pattern },`,
    `captions { present, style ("word-by-word" | "sentence" | "block"), position ("top" | "center" | "bottom"), size_px, color (hex), background (hex or null), animation ("pop-in" | "fade-in" | "static" | null) },`,
    `broll { use, count, avg_duration_s, placement, suggested_kinds[] },`,
    `audio { music, start_at_s, end_at_s (null = to end), pattern ("throughout" | "intro-only" | "outro-only" | "gaps"), suggested_genre },`,
    `hook { style, duration_s },`,
    `summary (one paragraph natural-language brief).`,
  ].join('\n');
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

  const res = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userPrompt },
    ],
  });

  const raw = res.choices[0]?.message?.content ?? '{}';
  return RecipeSchema.parse(JSON.parse(raw));
}
