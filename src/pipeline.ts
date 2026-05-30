import { transcribe, type TranscribeInput } from './transcribe.js';
import { inferNiche } from './niche.js';
import { findTopCreators } from './creators.js';
import { scrapeCreators } from './scrape.js';
import { quantifyPosts } from './quantify.js';
import { aggregateByCreator } from './aggregate.js';
import { synthesizeRecipe } from './synthesize.js';
import type { CreatorPatternReport } from './types.js';

// End-to-end Apify pipeline:
//   user script/video
//     -> transcript
//     -> niche (OpenAI)
//     -> top creators (Tavily + GPT extract)
//     -> scraped posts (Apify IG profile actor)
//     -> per-video features (deterministic: ffmpeg + OCR, no LLM)
//     -> per-creator aggregate + instructions
//     -> single synthesized Recipe (GPT) ready for the editor LLM

export type PipelineOpts = {
  skipQuantify?: boolean;
  skipSynthesize?: boolean;
  quantifyConcurrency?: number;
};

export async function runApifyPipeline(
  input: TranscribeInput,
  opts: PipelineOpts = {},
): Promise<CreatorPatternReport> {
  const t = await transcribe(input);
  const niche = await inferNiche(t.text);
  const creators = await findTopCreators(niche);
  const posts = await scrapeCreators(creators);

  const report: CreatorPatternReport = {
    generated_at: new Date().toISOString(),
    source: { script_text: t.text, transcript_source: t.source },
    niche,
    creators,
    posts,
  };

  if (opts.skipQuantify) return report;

  const features = await quantifyPosts(posts, { concurrency: opts.quantifyConcurrency });
  const perCreator = aggregateByCreator(creators, posts, features);

  report.per_video_features = features;
  report.per_creator = perCreator;

  if (opts.skipSynthesize) return report;
  if (perCreator.some((p) => p.videos_analyzed > 0)) {
    report.recipe = await synthesizeRecipe(report);
  }
  return report;
}
