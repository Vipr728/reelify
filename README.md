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
      reel_manifest.json
```

Set `BOX_REELS_FOLDER_ID` to the Box folder ID for `reels` if it already exists.
Otherwise the server creates/uses `reels` under `BOX_REELS_ROOT_FOLDER_ID`,
falling back to `BOX_RAW_FOLDER_ID`.

## Project areas

- `apify-integration/` — scraping top creators, extracting video patterns, and outputting quantified JSON.
- `llm-harness/` — niche inference, prompt orchestration, and feeding creator patterns into LLM workflows.
- `frontend-and-tools/` — Expo UI work plus FFmpeg/editing tool integration.
