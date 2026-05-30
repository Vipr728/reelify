# Box Context Workflow

This harness builds a machine-readable LLM context JSON from a Box reel folder,
then asks OpenAI to produce a validated edit-plan JSON. It does not run ffmpeg.

## Current Flow

1. Box stores reels under a folder shaped like:

```text
/reels/reel_001
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

2. The server runs `apify-integration` with the facecam transcript as the
   script input, then stores the report and recipe under the reel's Box
   `outputs/apify` folder.

3. `npm run llm:context:box` reads that Box tree plus the Apify recipe and
   creates a local context file in `llm-harness/out/`.

4. `npm run llm:plan` sends that context to OpenAI Structured Outputs and
   writes a strict edit-plan JSON locally.

5. The server uploads the context JSON and generated edit-plan JSON to the
   reel's Box `outputs` folder.

6. The downstream editor parses the JSON and calls deterministic edit
   functions. No LLM is used after this step.

## Box Data Used

The context builder reads:

- `reel_manifest.json`: reel-level manifest and source of asset duration hints.
- `facecam/facecam.mp4`: primary talking-head video with dialogue audio.
- `facecam/transcript.txt`: transcript text for captions and timing decisions.
- `facecam/transcript.json` or `facecam/metadata.json`: face/head position and
  framing metadata.
- `broll/*/clip.mp4`: b-roll assets.
- `broll/*/metadata.json`: b-roll descriptions and duration hints.

## Upload-Time Transcript Creation

The Expo upload button sends the recorded video file plus clip metadata. It does
not currently send transcript text from the client.

For `clipType=talking`, the server now handles transcript creation:

1. Uploads `facecam.mp4` to Box.
2. Extracts mono 16kHz audio with ffmpeg.
3. Sends the audio to OpenAI Whisper.
4. Versions `facecam/transcript.txt` with the transcript text.
5. Versions `facecam/transcript.json` with status, text, segments, words, and
   timing metadata.
6. Updates `reel_manifest.json` with transcript file IDs and transcript status.

If `OPENAI_API_KEY` is missing or transcription fails, the server still uploads
the facecam video and writes a transcript JSON with `status` set to `pending` or
`error`.

Each generated asset includes:

- `id`
- `kind`
- `uri` as `box://files/<fileId>`
- `boxFileId`
- `boxPath`
- `durationSec`
- `description`
- `transcript`
- `metadata`

## Commands

Build context from Box:

```bash
npm run llm:context:box -- \
  --reel reel_001 \
  --output llm-harness/out/context.reel_001.json
```

Generate the edit plan from that context:

```bash
npm run llm:plan -- \
  --input llm-harness/out/context.reel_001.json \
  --output llm-harness/out/edit-plan.reel_001.json \
  --no-box-upload
```

The Expo/server integrated flow stores generated files under:

```text
/reels/reel_001/outputs/apify/apify-report.reel_001.json
/reels/reel_001/outputs/apify/apify-recipe.reel_001.json
/reels/reel_001/outputs/llm-harness/context.reel_001.json
/reels/reel_001/outputs/editing instructions/edit-plan.reel_001.json
```

The standalone `llm:plan` command still uploads to `BOX_OUTPUT_FOLDER_ID` unless
`--no-box-upload` is passed.

Validate an edit plan:

```bash
npm run llm:validate -- llm-harness/out/edit-plan.json
```

Run schema tests:

```bash
npm run llm:test
```

## Current Box State

The latest check found:

```text
/reels/reel_001
  reel_manifest.json
  /facecam
    facecam.mp4
    transcript.txt
    transcript.json
  /broll
    /clip_001
      clip.mp4
      metadata.json
    /clip_002
      clip.mp4
      metadata.json
```

The generated context contains:

```text
reel=reel_001
assets=3
facecam duration=29s
broll clips=clip_001, clip_002
```

The generated edit plan is:

```text
llm-harness/out/edit-plan.reel_001.json
Box: outputs/editing instructions/edit-plan.reel_001.json
duration=29s
assets=3
videoItems=4
audioItems=1
captionItems=3
```

The output is 29 seconds because the available facecam/dialogue source is 29
seconds. The schema now rejects plans with blank video tails, so the LLM must
either fully cover the requested duration with media or shorten the plan to a
fully covered duration.

## Auth Notes

For quick local testing, the script supports `BOX_DEVELOPER_TOKEN` from the
environment. For longer-term use, use Box client credentials with:

- `BOX_CLIENT_ID`
- `BOX_CLIENT_SECRET`
- `BOX_SUBJECT_TYPE`
- `BOX_SUBJECT_ID`

Do not commit real tokens or secrets.
