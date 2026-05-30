import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { request } from 'undici';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import {
  getDuration,
  getDimensions,
  hasAudioStream,
  detectCutTimes,
  detectSilenceIntervals,
  extractFrame,
} from './ffmpeg.js';
import type { AudioPattern, CaptionPosition, ScrapedPost, VideoFeatures } from './types.js';

const FRAME_SAMPLES = 5;       // sampled frames per video for caption OCR
const CAPTION_PRESENT_RATE = 0.4; // call captions "present" if >= this fraction of frames have text
const SHORT_SCENE_S = 2;       // scene shorter than this counts as a b-roll cutaway
const OCR_CONFIDENCE = 55;     // discard tesseract words below this
const AUDIO_ACTIVE_THRESHOLD = 0.5; // a third is "active" if >= this fraction is non-silent

async function downloadToTemp(url: string): Promise<string> {
  const tmp = path.join(
    os.tmpdir(),
    `reelify-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );
  const res = await request(url, { maxRedirections: 4 });
  if (res.statusCode >= 400) {
    throw new Error(`download ${url}: HTTP ${res.statusCode}`);
  }
  const buf = Buffer.from(await res.body.arrayBuffer());
  await fs.writeFile(tmp, buf);
  return tmp;
}

function emptyFeatures(post: ScrapedPost, why: NonNullable<VideoFeatures['skipped']>): VideoFeatures {
  return {
    post_url: post.post_url,
    duration_s: 0,
    cut_count: 0,
    cuts_per_10s: 0,
    avg_scene_duration_s: 0,
    longest_scene_s: 0,
    short_scenes_ratio: 0,
    captions: { present: false, position: 'none', avg_size_px: 0, coverage_rate: 0 },
    audio: {
      has_audio: false,
      coverage_rate: 0,
      intro_active: false,
      mid_active: false,
      outro_active: false,
      pattern: 'silent',
    },
    skipped: why,
  };
}

function classifyAudioPattern(
  intro: boolean,
  mid: boolean,
  outro: boolean,
  coverage: number,
): AudioPattern {
  if (coverage < 0.1) return 'silent';
  if (intro && mid && outro) return 'throughout';
  if (intro && !mid && !outro) return 'intro-only';
  if (!intro && !mid && outro) return 'outro-only';
  return 'gaps';
}

function classifyCaptionPosition(yRatios: number[]): CaptionPosition {
  if (!yRatios.length) return 'none';
  const avg = yRatios.reduce((a, b) => a + b, 0) / yRatios.length;
  if (avg < 0.33) return 'top';
  if (avg < 0.67) return 'center';
  return 'bottom';
}

async function ocrFrame(
  worker: TesseractWorker,
  framePath: string,
  frameH: number,
): Promise<{ yCentroid: number; avgHeightPx: number } | null> {
  const { data } = await worker.recognize(framePath);
  const words = data.words.filter(
    (w) => w.text && w.text.trim().length > 1 && w.confidence >= OCR_CONFIDENCE,
  );
  if (words.length === 0) return null;
  const yCentroid =
    words.reduce((s, w) => s + (w.bbox.y0 + w.bbox.y1) / 2, 0) / words.length / frameH;
  const avgHeightPx =
    words.reduce((s, w) => s + (w.bbox.y1 - w.bbox.y0), 0) / words.length;
  return { yCentroid, avgHeightPx };
}

async function quantifyOne(
  post: ScrapedPost,
  worker: TesseractWorker,
): Promise<VideoFeatures> {
  if (!post.video_url) return emptyFeatures(post, 'no-video-url');

  let file: string;
  try {
    file = await downloadToTemp(post.video_url);
  } catch {
    return emptyFeatures(post, 'download-failed');
  }

  const frameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reelify-frames-'));
  try {
    const [duration, dims, cutTimes, silence, audioStream] = await Promise.all([
      getDuration(file),
      getDimensions(file),
      detectCutTimes(file),
      detectSilenceIntervals(file).catch(() => []),
      hasAudioStream(file).catch(() => false),
    ]);

    // --- Scene-length stats (b-roll cut pattern proxy). ---
    const boundaries = [0, ...cutTimes, duration].sort((a, b) => a - b);
    const sceneDurations: number[] = [];
    for (let i = 1; i < boundaries.length; i++) {
      const d = boundaries[i] - boundaries[i - 1];
      if (d > 0.05) sceneDurations.push(d);
    }
    const sceneCount = sceneDurations.length || 1;
    const avgScene = sceneDurations.reduce((a, b) => a + b, 0) / sceneCount;
    const longestScene = sceneDurations.length ? Math.max(...sceneDurations) : duration;
    const shortScenes = sceneDurations.filter((d) => d < SHORT_SCENE_S).length;

    // --- Audio "placement". Compute silent fraction in each third. ---
    const third = duration / 3;
    const active = (a: number, b: number) => {
      let silentInWindow = 0;
      for (const s of silence) {
        const start = Math.max(a, s.start);
        const end = Math.min(b, s.end);
        if (end > start) silentInWindow += end - start;
      }
      const window = b - a;
      return window > 0 ? 1 - silentInWindow / window : 0;
    };
    const introCov = audioStream ? active(0, third) : 0;
    const midCov = audioStream ? active(third, 2 * third) : 0;
    const outroCov = audioStream ? active(2 * third, duration) : 0;
    const totalCov = audioStream ? (introCov + midCov + outroCov) / 3 : 0;
    const pattern = classifyAudioPattern(
      introCov >= AUDIO_ACTIVE_THRESHOLD,
      midCov >= AUDIO_ACTIVE_THRESHOLD,
      outroCov >= AUDIO_ACTIVE_THRESHOLD,
      totalCov,
    );

    // --- Captions via OCR on N evenly-spaced frames. ---
    const yRatios: number[] = [];
    const heights: number[] = [];
    let captionFrames = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const at = (duration * (i + 0.5)) / FRAME_SAMPLES;
      const framePath = path.join(frameDir, `f${i}.jpg`);
      await extractFrame(file, at, framePath);
      const r = await ocrFrame(worker, framePath, dims.h);
      if (r) {
        captionFrames++;
        yRatios.push(r.yCentroid);
        heights.push(r.avgHeightPx);
      }
    }
    const coverage = captionFrames / FRAME_SAMPLES;
    const position = classifyCaptionPosition(yRatios);
    const avgCaptionSize =
      heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : 0;

    return {
      post_url: post.post_url,
      duration_s: duration,
      cut_count: cutTimes.length,
      cuts_per_10s: duration > 0 ? (cutTimes.length / duration) * 10 : 0,
      avg_scene_duration_s: avgScene,
      longest_scene_s: longestScene,
      short_scenes_ratio: shortScenes / sceneCount,
      captions: {
        present: coverage >= CAPTION_PRESENT_RATE,
        position,
        avg_size_px: avgCaptionSize,
        coverage_rate: coverage,
      },
      audio: {
        has_audio: audioStream,
        coverage_rate: totalCov,
        intro_active: introCov >= AUDIO_ACTIVE_THRESHOLD,
        mid_active: midCov >= AUDIO_ACTIVE_THRESHOLD,
        outro_active: outroCov >= AUDIO_ACTIVE_THRESHOLD,
        pattern,
      },
    };
  } catch {
    return emptyFeatures(post, 'ffmpeg-failed');
  } finally {
    await fs.rm(frameDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

async function pMap<T, R>(
  items: T[],
  fn: (item: T, i: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const idx = i++;
        if (idx >= items.length) return;
        results[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return results;
}

export async function quantifyPosts(
  posts: ScrapedPost[],
  opts: { concurrency?: number } = {},
): Promise<VideoFeatures[]> {
  if (!posts.length) return [];
  const worker = await createWorker('eng');
  try {
    return await pMap(posts, (p) => quantifyOne(p, worker), opts.concurrency ?? 3);
  } finally {
    await worker.terminate();
  }
}
