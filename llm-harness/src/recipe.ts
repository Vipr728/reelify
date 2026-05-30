import { z } from "zod";

import { RecipeSchema, type Recipe } from "./schema";

const ApifyRecipeSchema = z
  .object({
    target_duration_s: z.number().positive(),
    pacing: z
      .object({
        total_cuts: z.number().int().nonnegative(),
        cuts_per_10s: z.number().nonnegative(),
        avg_cut_interval_s: z.number().nonnegative(),
        pattern: z.string().min(1),
      })
      .strict(),
    captions: z
      .object({
        present: z.boolean(),
        style: z.string().min(1),
        position: z.enum(["top", "center", "bottom"]),
        size_px: z.number().nonnegative(),
        color: z.string().min(1),
        background: z.string().nullable(),
        animation: z.string().nullable(),
      })
      .strict(),
    broll: z
      .object({
        use: z.boolean(),
        count: z.number().int().nonnegative(),
        avg_duration_s: z.number().nonnegative(),
        placement: z.string().min(1),
        suggested_kinds: z.array(z.string()).default([]),
      })
      .strict(),
    audio: z
      .object({
        music: z.boolean(),
        start_at_s: z.number().nonnegative(),
        end_at_s: z.number().nullable(),
        pattern: z.enum(["throughout", "intro-only", "outro-only", "gaps"]),
        suggested_genre: z.string().min(1),
      })
      .strict(),
    hook: z
      .object({
        style: z.string().min(1),
        duration_s: z.number().nonnegative(),
      })
      .strict(),
    summary: z.string().min(1),
  })
  .strict();

export function parseRecipeInput(input: unknown, source: string | null = null): Recipe {
  const flat = RecipeSchema.safeParse(input);
  if (flat.success) {
    return {
      ...flat.data,
      source: flat.data.source ?? source,
    };
  }

  const apify = ApifyRecipeSchema.parse(input);
  return RecipeSchema.parse({
    durationSec: apify.target_duration_s,
    pacing: `${apify.pacing.total_cuts} cuts · ${formatNumber(apify.pacing.cuts_per_10s)}/10s · avg ${formatNumber(apify.pacing.avg_cut_interval_s)}s between cuts`,
    pacingPattern: apify.pacing.pattern,
    captions: apify.captions.present
      ? [
          apify.captions.style,
          apify.captions.position,
          `${formatNumber(apify.captions.size_px)}px`,
          captionColorLabel(apify.captions.color, apify.captions.background),
          apify.captions.animation,
        ]
          .filter(Boolean)
          .join(" · ")
      : "captions disabled",
    broll: apify.broll.use
      ? [
          `${apify.broll.count} cutaways`,
          `avg ${formatNumber(apify.broll.avg_duration_s)}s`,
          apify.broll.placement,
          apify.broll.suggested_kinds.length ? `kinds: ${apify.broll.suggested_kinds.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "no b-roll cutaways",
    audio: apify.audio.music
      ? [
          `${apify.audio.suggested_genre} background music`,
          apify.audio.pattern,
          `start ${formatNumber(apify.audio.start_at_s)}s ${apify.audio.end_at_s === null ? "to end" : `to ${formatNumber(apify.audio.end_at_s)}s`}`,
        ].join(" · ")
      : `no music · ${apify.audio.pattern}`,
    hook: `${apify.hook.style} · ${formatNumber(apify.hook.duration_s)}s`,
    summary: apify.summary,
    source,
  });
}

function captionColorLabel(color: string, background: string | null): string {
  return background ? `${color} on ${background}` : color;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
