# Reelify — Apify pipeline

Front half of Reelify, on its own branch. Upload a talking-head clip; out comes a `Recipe` JSON — a concrete editor brief (cuts, captions, b-roll, audio, hook) averaged from the top creators in the user's niche. The harness LLM consumes that recipe to assemble the final reel.

Quantify is **deterministic** — ffmpeg + tesseract.js OCR, no LLM. Only the first and last steps (niche/creator-rank, recipe) hit GPT.

```
mp4 upload (or script string)
   │
   ▼ transcribe                   (ffmpeg strip audio → Whisper)
   │
   ▼ inferNiche                   (OpenAI → { label, keywords, audience })
   │
   ▼ findTopCreators              (Tavily search → handles extracted from real
   │                                instagram.com/* URLs → GPT ranks)
   │
   ▼ scrapeCreators               (Apify apify/instagram-scraper → ScrapedPost[])
   │
   ▼ quantifyPosts                deterministic, per video:
   │      • duration_s
   │      • cut_count, cuts_per_10s, avg_scene_duration_s
   │      • short_scenes_ratio          (proxy for b-roll cutaway density)
   │      • longest_scene_s             (longest talking-head segment)
   │      • captions: present, position (top/center/bottom), avg_size_px, coverage_rate
   │      • audio: intro/mid/outro active, pattern
   │
   ▼ aggregateByCreator           pure-compute averages + short `instructions` text
   │
   ▼ synthesizeRecipe             one GPT call → ONE concrete Recipe:
          • target_duration_s
          • pacing { total_cuts, cuts_per_10s, pattern }
          • captions { style, position, size_px, color, background, animation }
          • broll { count, avg_duration_s, placement, suggested_kinds }
          • audio { music, start_at_s, pattern, suggested_genre }
          • hook { style, duration_s }
          • summary (paragraph for the editor LLM)
```

## Setup

Requires **ffmpeg** + **ffprobe** on PATH (`brew install ffmpeg`).

```bash
cp .env.example .env   # OPENAI_API_KEY, TAVILY_API_KEY, APIFY_TOKEN
npm install
```

First quantify run downloads ~5 MB of Tesseract English language data (gitignored).

## Run

### Web app (easiest)

```bash
npm run web    # http://localhost:5173
```

Drop in an mp4. Each stage card lights up live; the final card shows the recipe parameters in a table + a saved-file path. Reports land in `out/report-<ts>.json` and `out/recipe-<ts>.json`.

### CLI

```bash
npm run pipeline -- --video ~/Downloads/my-reel.mp4          # full pipeline
npm run pipeline -- --script "Today I'm gonna show you..."    # script instead of video
npm run pipeline -- --skip-quantify --script "..."            # stop after scrape (no ffmpeg work)
npm run pipeline -- --skip-synthesize --script "..."          # stop before final GPT recipe
npm run pipeline -- --concurrency 5 --script "..."            # parallelize quantify
```

Writes `out/report-<ts>.json` (full) and `out/recipe-<ts>.json` (just the editor instruction).

### Per-step CLI

```bash
npm run transcribe -- ~/Downloads/clip.mp4
npm run niche -- "transcript text..."
echo '<niche-json>'                              | npm run creators
echo '<creators-json>'                           | npm run scrape
echo '<posts-json>'                              | npm run quantify
echo '<report-json-with-features>'               | npm run aggregate
echo '<report-json-with-per-creator>'            | npm run synthesize
```

## Local test loop (no APIs needed)

```bash
npm run check                                                # env + ffmpeg sanity
npm run test:aggregate                                       # aggregate against fixtures/sample-report.json
npm run test:quantify -- --file path/to/my-reel.mp4          # real ffmpeg + OCR on a local file
npm run test:niche                                           # pipes fixtures/sample-script.txt → OpenAI
npm run test:creators                                        # pipes fixtures/sample-niche.json → Tavily + OpenAI
npm run test:scrape                                          # pipes fixtures/sample-creators.json → Apify (costs minutes)
```

`fixtures/sample-report.json` has fabricated per-video features so `test:aggregate` is fully offline.

## What the editor LLM consumes

The harness reads `out/recipe-<ts>.json`. Shape:

```jsonc
{
  "target_duration_s": 24,
  "pacing": { "total_cuts": 8, "cuts_per_10s": 3.3, "avg_cut_interval_s": 3.0, "pattern": "fast hook in first 3s, steady middle, snap outro" },
  "captions": { "present": true, "style": "word-by-word", "position": "bottom", "size_px": 48, "color": "#ffffff", "background": "#000000cc", "animation": "pop-in" },
  "broll":    { "use": true, "count": 4, "avg_duration_s": 1.8, "placement": "every ~5s, evenly spaced", "suggested_kinds": ["screen recording", "stock footage"] },
  "audio":    { "music": true, "start_at_s": 0, "end_at_s": null, "pattern": "throughout", "suggested_genre": "lofi hip-hop" },
  "hook":     { "style": "rhetorical question", "duration_s": 3 },
  "summary":  "..."
}
```

The full `report-<ts>.json` keeps every intermediate (scraped posts, per-video features, per-creator aggregates) alongside the recipe.

## Notes

- Caption detection is OCR on 5 sampled frames per video — fast and cheap, but a stylized burned-in font can fool it. Tune `OCR_CONFIDENCE` / `FRAME_SAMPLES` in `src/quantify.ts` if you see false negatives.
- "Audio placement" is `audio-active` placement, not music-vs-speech classification. The pattern (`throughout` / `intro-only` / `outro-only` / `gaps`) is what's reliable; the genre suggestion comes from GPT in the synthesize step.
- "B-roll cut pattern" is approximated by short-scene density (`short_scenes_ratio`). 40%+ short scenes → heavy cutaways; low → mostly talking head.
- Apify scrape takes minutes per run. Use `--skip-quantify` (or the UI checkbox) when iterating on the front half.
- The web app is local-dev only — no auth, no rate limit. Don't expose to the internet.
