# Reelify

Expo SDK 54 starter app for Reelify.

## Development

```bash
npm install
npm run server
npx expo start
```

The Expo app uploads clips to the local server at `EXPO_PUBLIC_REELIFY_API_URL`.
The server uses private `.env` values to upload originals to Box and only sends a
tiny FFmpeg-generated storyboard image to OpenAI for b-roll metadata.
Use the app's reel strip to create/select the active reel before recording. Each
reel can have one `facecam.mp4` and many b-roll `clip_###` folders.

Box layout:

```text
/Reelify-Hackathon
  /reels
    /reel_001
      /facecam
        facecam.mp4
        transcript.txt
        transcript.json
      /broll
        /clip_001
          clip.mp4
          metadata.json
      /outputs
        /apify
          apify-report.reel_001.json
          apify-recipe.reel_001.json
        /llm-harness
          context.reel_001.json
        /editing instructions
          edit-plan.reel_001.json
      reel_manifest.json
```

Set `BOX_REELS_FOLDER_ID` to the Box folder ID for `reels` if it already exists.
Otherwise the server creates/uses `reels` under `BOX_REELS_ROOT_FOLDER_ID`,
falling back to `BOX_RAW_FOLDER_ID`.

## Project areas

- `apify-integration/` — scraping top creators, extracting video patterns, and outputting quantified JSON.
- `llm-harness/` — niche inference, prompt orchestration, and feeding creator patterns into LLM workflows.
- `frontend-and-tools/` — Expo UI work plus FFmpeg/editing tool integration.

## Generate edit instructions

After uploading a talking clip and b-roll for the active reel, tap `Plan` in the
Expo app. The server reads the Box transcript, runs the Apify creator pipeline
with that script, stores the Apify report/recipe under the reel's `outputs`
folder, runs `llm-harness` with the Box assets plus recipe, and stores the final
strict edit-plan JSON under `outputs/editing instructions`.
