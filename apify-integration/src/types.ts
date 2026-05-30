// Shared types for the Apify pipeline.
// Quantify is deterministic (ffmpeg + OCR) — these features are inputs/instructions
// for the harness LLM, not produced by an LLM themselves.

export type Niche = {
  label: string;
  keywords: string[];
  audience: string;
  rationale: string;
  // 3-5 distinct web-search queries crafted to surface real Instagram creators
  // in this niche. Pipeline runs each one through Tavily and unions the
  // resulting candidates so we get >= 3-5 real handles even on narrow niches.
  search_queries: string[];
  // Adjacent niches to widen the search if the primary queries come up dry.
  adjacent_niches?: string[];
};

export type Creator = {
  handle: string;
  profile_url: string;
  display_name?: string;
  follower_count?: number;
  source: 'tavily' | 'manual';
  why: string;
};

export type ScrapedPost = {
  creator_handle: string;
  post_url: string;
  shortcode: string;
  video_url?: string;
  thumbnail_url?: string;
  caption?: string;
  likes?: number;
  comments?: number;
  views?: number;
  duration_s?: number;
  timestamp?: string;
};

// --- Per-video quantified features (deterministic, no LLM) ---

export type CaptionPosition = 'top' | 'center' | 'bottom' | 'none';
export type AudioPattern = 'throughout' | 'intro-only' | 'outro-only' | 'gaps' | 'silent';

export type VideoFeatures = {
  post_url: string;
  duration_s: number;

  // Pacing / cuts. "Short scenes" are a proxy for b-roll cutaways.
  cut_count: number;
  cuts_per_10s: number;
  avg_scene_duration_s: number;
  longest_scene_s: number;
  short_scenes_ratio: number; // fraction of scenes < 2s

  // Captions (OCR on sampled frames).
  captions: {
    present: boolean;
    position: CaptionPosition;
    avg_size_px: number;
    coverage_rate: number; // fraction of sampled frames with text
  };

  // Audio "placement". We can't reliably split music vs voice without ML,
  // so we report audio-active windows. Background music tends to read as
  // "throughout"; outro stings as "outro-only"; etc.
  audio: {
    has_audio: boolean;
    coverage_rate: number;
    intro_active: boolean;
    mid_active: boolean;
    outro_active: boolean;
    pattern: AudioPattern;
  };

  // Set when the source had no video_url and we couldn't analyze.
  skipped?: 'no-video-url' | 'download-failed' | 'ffmpeg-failed';
};

// --- Per-creator aggregate ---

export type CreatorPattern = {
  creator: Creator;
  videos_analyzed: number;
  avg: {
    duration_s: number;
    cuts_per_10s: number;
    avg_scene_duration_s: number;
    short_scenes_ratio: number;
    longest_scene_s: number;
    caption_size_px: number; // averaged over videos where captions were present
    caption_coverage_rate: number;
    audio_coverage_rate: number;
  };
  dominant: {
    caption_position: CaptionPosition;
    captions_present: boolean; // > 50% of videos use captions
    audio_pattern: AudioPattern;
  };
  // Short natural-language guidance the harness can paste into its prompt.
  instructions: string;
};

// --- Final synthesis ---
// One concrete recipe a downstream editor LLM can execute. Averages the
// per-creator patterns into specific numbers/positions/colors. Produced by
// src/synthesize.ts (which calls GPT).

export type Recipe = {
  target_duration_s: number;
  pacing: {
    total_cuts: number;
    cuts_per_10s: number;
    avg_cut_interval_s: number;
    pattern: string; // e.g. "fast hook in first 3s, steady middle, snap outro"
  };
  captions: {
    present: boolean;
    style: string; // "word-by-word" | "sentence" | "block" | other
    position: 'top' | 'center' | 'bottom';
    size_px: number;
    color: string;             // hex
    background: string | null; // hex or null
    animation: string | null;  // "pop-in" | "fade-in" | "static" | null
  };
  broll: {
    use: boolean;
    count: number;
    avg_duration_s: number;
    placement: string;          // "every ~3-4s, evenly spaced"
    suggested_kinds: string[];  // ["screen recording", "stock footage", ...]
  };
  audio: {
    music: boolean;
    start_at_s: number;
    end_at_s: number | null;    // null = to end of reel
    pattern: 'throughout' | 'intro-only' | 'outro-only' | 'gaps';
    suggested_genre: string;
  };
  hook: {
    style: string;              // "rhetorical question" | "bold claim" | ...
    duration_s: number;
  };
  summary: string;              // natural-language instruction paragraph
};

export type CreatorPatternReport = {
  generated_at: string;
  source: {
    script_text: string;
    transcript_source: 'user-script' | 'user-video-transcribed';
  };
  niche: Niche;
  creators: Creator[];
  posts: ScrapedPost[];
  per_video_features?: VideoFeatures[];
  per_creator?: CreatorPattern[];
  recipe?: Recipe;
};
