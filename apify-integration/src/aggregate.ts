import type {
  AudioPattern,
  CaptionPosition,
  Creator,
  CreatorPattern,
  ScrapedPost,
  VideoFeatures,
} from './types.js';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function mode<T extends string>(xs: T[], fallback: T): T {
  if (!xs.length) return fallback;
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: T = fallback;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  return best;
}

function renderInstructions(p: CreatorPattern): string {
  const lines: string[] = [];
  lines.push(`Target duration ~${p.avg.duration_s.toFixed(0)}s.`);
  lines.push(
    `Pacing: ~${p.avg.cuts_per_10s.toFixed(1)} cuts per 10s ` +
      `(avg scene ${p.avg.avg_scene_duration_s.toFixed(1)}s, ` +
      `longest scene ${p.avg.longest_scene_s.toFixed(1)}s).`,
  );
  lines.push(
    `B-roll cutaways: ${(p.avg.short_scenes_ratio * 100).toFixed(0)}% of scenes are < 2s — ` +
      `${p.avg.short_scenes_ratio >= 0.4 ? 'heavy b-roll usage' : p.avg.short_scenes_ratio >= 0.2 ? 'moderate b-roll' : 'mostly talking-head'}.`,
  );
  if (p.dominant.captions_present) {
    lines.push(
      `Captions: yes, positioned ${p.dominant.caption_position}, ` +
        `~${p.avg.caption_size_px.toFixed(0)}px tall, ` +
        `visible ~${(p.avg.caption_coverage_rate * 100).toFixed(0)}% of the time.`,
    );
  } else {
    lines.push('Captions: not used.');
  }
  const audioLabel: Record<AudioPattern, string> = {
    throughout: 'audio (likely background music or constant VO) throughout',
    'intro-only': 'audio only at the intro (music sting up front)',
    'outro-only': 'audio only at the outro',
    gaps: 'audio with gaps (mixed music + speech moments)',
    silent: 'silent / no audio',
  };
  lines.push(`Music/audio placement: ${audioLabel[p.dominant.audio_pattern]}.`);
  return lines.join(' ');
}

export function aggregateByCreator(
  creators: Creator[],
  posts: ScrapedPost[],
  features: VideoFeatures[],
): CreatorPattern[] {
  const byPostUrl = new Map(features.map((f) => [f.post_url, f]));
  const out: CreatorPattern[] = [];

  for (const creator of creators) {
    const myPosts = posts.filter((p) => p.creator_handle.toLowerCase() === creator.handle.toLowerCase());
    const myFeats = myPosts
      .map((p) => byPostUrl.get(p.post_url))
      .filter((f): f is VideoFeatures => !!f && !f.skipped);

    if (!myFeats.length) {
      const empty: CreatorPattern = {
        creator,
        videos_analyzed: 0,
        avg: {
          duration_s: 0,
          cuts_per_10s: 0,
          avg_scene_duration_s: 0,
          short_scenes_ratio: 0,
          longest_scene_s: 0,
          caption_size_px: 0,
          caption_coverage_rate: 0,
          audio_coverage_rate: 0,
        },
        dominant: {
          caption_position: 'none',
          captions_present: false,
          audio_pattern: 'silent',
        },
        instructions: 'No analyzable videos — no guidance derived for this creator.',
      };
      out.push(empty);
      continue;
    }

    const captionPresentRate = mean(myFeats.map((f) => (f.captions.present ? 1 : 0)));
    const captionedFeats = myFeats.filter((f) => f.captions.present);

    const partial: Omit<CreatorPattern, 'instructions'> = {
      creator,
      videos_analyzed: myFeats.length,
      avg: {
        duration_s: mean(myFeats.map((f) => f.duration_s)),
        cuts_per_10s: mean(myFeats.map((f) => f.cuts_per_10s)),
        avg_scene_duration_s: mean(myFeats.map((f) => f.avg_scene_duration_s)),
        short_scenes_ratio: mean(myFeats.map((f) => f.short_scenes_ratio)),
        longest_scene_s: mean(myFeats.map((f) => f.longest_scene_s)),
        caption_size_px: mean(captionedFeats.map((f) => f.captions.avg_size_px)),
        caption_coverage_rate: mean(myFeats.map((f) => f.captions.coverage_rate)),
        audio_coverage_rate: mean(myFeats.map((f) => f.audio.coverage_rate)),
      },
      dominant: {
        caption_position: mode<CaptionPosition>(
          captionedFeats.map((f) => f.captions.position),
          'none',
        ),
        captions_present: captionPresentRate >= 0.5,
        audio_pattern: mode<AudioPattern>(
          myFeats.map((f) => f.audio.pattern),
          'silent',
        ),
      },
    };

    const pattern = { ...partial, instructions: '' } as CreatorPattern;
    pattern.instructions = renderInstructions(pattern);
    out.push(pattern);
  }
  return out;
}
