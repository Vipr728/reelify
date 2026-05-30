# LLM Harness

Scope:
- Run niche inference.
- Feed quantified creator patterns into prompts.
- Orchestrate file-system prompt workflows.

## Edit plan JSON generator

This harness turns video context into a strict edit decision JSON file. It does
not run ffmpeg. The generated JSON is meant for a deterministic parser/editor
that calls functions from exact fields in the plan.

### Input context

Use `llm-harness/fixtures/context.example.json` as the context shape:

- `request`: the user edit request.
- `output`: target dimensions, fps, aspect ratio, and duration.
- `reel`: Box reel folder metadata and `reel_manifest.json` contents.
- `assets`: raw talking-head, b-roll, music, or sfx assets with stable IDs,
  `boxFileId`, `boxPath`, transcript text, and metadata.
- `recipe`: target duration, pacing, caption, b-roll, audio, and hook recipe.
- `style`: simple machine-readable pacing and caption preferences.

### Output plan

The LLM writes an `EditPlan` JSON object with:

- `output`: exact render settings.
- `assets`: only assets the downstream editor may reference.
- `styles.captions`: explicit caption style records.
- `tracks.video`: main and overlay video timeline items.
- `tracks.audio`: dialogue, music, or sfx timeline items.
- `tracks.captions`: timed caption cues with token-level highlights.

The plan intentionally has no notes, comments, markdown, or vague human
instructions. Unknown keys are rejected.

### Commands

Validate the checked-in example plan:

```bash
npm run llm:validate
```

Run schema tests:

```bash
npm run llm:test
```

Build context from Box for a reel folder:

```bash
npm run llm:context:box -- \
  --reel reel_001 \
  --output llm-harness/out/context.reel_001.json
```

The Box builder expects this tree under the configured Box root:

```text
/Reelify-Hackathon/reels/reel_001
  /facecam
    facecam.mp4
    transcript.txt
    transcript.json
  /broll
    /clip_001
      clip.mp4
      metadata.json
  reel_manifest.json
```

Auth comes from `.env`. Prefer `BOX_DEVELOPER_TOKEN` for quick hackathon
testing, or configure CCG with `BOX_CLIENT_ID`, `BOX_CLIENT_SECRET`,
`BOX_SUBJECT_TYPE`, and `BOX_SUBJECT_ID`.

Generate a new plan with OpenAI Structured Outputs:

```bash
OPENAI_API_KEY=... npm run llm:plan -- \
  --input llm-harness/out/context.reel_001.json \
  --output llm-harness/out/edit-plan.json
```

Override the model with `--model` or `OPENAI_MODEL`. The default is
`gpt-4o-2024-08-06` because it supports strict structured outputs.
