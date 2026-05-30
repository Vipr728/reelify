# Reelify — Apify pipeline

Front half of Reelify, on its own branch. Turns the user's script (or talking-head video) into a `CreatorPatternReport`: niche → top creators → their scraped posts → **deterministic per-video features** → **per-creator instructions** the harness LLM can paste straight into its prompt.

Quantify is **not** an LLM. It's ffmpeg + OCR producing plain numbers like "captions ~46px at bottom, ~3.2 cuts per 10s, audio throughout."

```
script | video
   │
   ▼ transcribe                   (Whisper if video, passthrough if text)
   │
   ▼ inferNiche                   (OpenAI → { label, keywords, audience })
   │
   ▼ findTopCreators              (Tavily + GPT extract → Creator[])
   │
   ▼ scrapeCreators               (Apify IG profile actor → ScrapedPost[])
   │
   ▼ quantifyPosts                ── deterministic, per video:
   │      • duration_s
   │      • cut_count, cuts_per_10s, avg_scene_duration_s
   │      • short_scenes_ratio          (proxy for b-roll cutaway density)
   │      • longest_scene_s             (longest talking-head segment)
   │      • captions: present, position (top/center/bottom), avg_size_px, coverage_rate
   │      • audio: has_audio, intro/mid/outro active, pattern (throughout / intro-only / outro-only / gaps / silent)
   │
   ▼ aggregateByCreator           → CreatorPattern with `instructions` string
   │
   ▼ CreatorPatternReport.json    ← the harness reads this file
```

## Setup

Requires **ffmpeg** and **ffprobe** on PATH:

```bash
brew install ffmpeg
```

Then:

```bash
cp .env.example .env   # OPENAI_API_KEY, TAVILY_API_KEY, APIFY_TOKEN
npm install
```

First quantify run downloads ~5 MB of Tesseract English language data.

## Run

```bash
# Full pipeline from a script
npm run pipeline -- --script "Today I'm gonna show you how I built my SaaS solo..."

# From a video
npm run pipeline -- --video ~/Downloads/my-reel.mp4

# Fast: skip the quantify step (front half only)
npm run pipeline -- --skip-quantify --script "..."

# Tune quantify concurrency (default 3)
npm run pipeline -- --concurrency 5 --script "..."
```

Output lands at `out/report-<ts>.json` and on stdout.

## Per-step CLI

```bash
npm run transcribe -- ~/Downloads/clip.mp4
npm run niche -- "transcript text..."
echo '<niche-json>'    | npm run creators
echo '<creators-json>' | npm run scrape
echo '<posts-json>'    | npm run quantify
echo '<report-json-with-features>' | npm run aggregate
```

## What the harness reads

`per_creator[i].instructions` is the punchline — a short string ready to paste in a prompt. Example:

```
Target duration ~24s. Pacing: ~3.2 cuts per 10s (avg scene 2.4s, longest scene 6.1s).
B-roll cutaways: 43% of scenes are < 2s — heavy b-roll usage.
Captions: yes, positioned bottom, ~46px tall, visible ~84% of the time.
Music/audio placement: audio (likely background music or constant VO) throughout.
```

If you want the raw numbers (you will, for finer control), every field that produced that sentence is also in `per_creator[i].avg` and `per_creator[i].dominant`.

## Notes

- Caption detection is OCR on 5 sampled frames per video — fast and cheap, but a stylized burned-in font can fool it. Tune `OCR_CONFIDENCE` / `FRAME_SAMPLES` in `quantify.ts` if you see false negatives.
- "Music placement" is really *audio activity placement*: we don't separate music from speech without ML. The pattern (`throughout` / `intro-only` / `outro-only` / `gaps`) is what's reliable; treat the label as guidance, not a music classifier.
- "B-roll cut pattern" is approximated by short-scene density (`short_scenes_ratio`). A reel with 40%+ short scenes almost always has cutaways; a low number means mostly talking head.
- The Apify scrape pulls minutes. Use `--skip-quantify` while iterating on the front half.
- This service is server-side. Don't import it from the RN app.
