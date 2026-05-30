# First prompt for Claude Code

Paste everything below into Claude Code from the repo root.

---

You are building **Reelify**, a React Native (iOS) app that turns raw vertical
clips into an edited, trend-tuned short-form video. The backend is already
scaffolded. Your main job is to build the RN app and finish the TODOs in the
existing backend, phase by phase.

## Read these first, in order
1. `docs/PRD.md` — full spec, locked decisions, build sequence with acceptance criteria.
2. `docs/API.md` — exact endpoint and status-polling contracts. Do not invent shapes.
3. `docs/BOX_SETUP.md` — what the human must configure in Box.
4. `docs/RUNBOOK.md` — deploy order and the smoke test for each phase.

## What already exists (don't rewrite, extend)
- `sql/schema.sql` — Postgres + pgvector + `match_clips` + demo RLS.
- `supabase/functions/` — `issue-upload`, `box-skill-webhook`, `make-reel`, shared Box + OpenAI helpers.
- `render-worker/` — Fly.io FFmpeg worker with full-render-then-fallback.
- `scripts/seed_trends.mjs` — trend fallback seeding.

## What you build
- `app/` — the Expo (dev client) iOS app with react-native-vision-camera.
  Screens: record (vertical, ~15s cap, multi-clip), clip library with per-clip
  status, topic entry + "Make a reel", render progress, final-video preview.
- Finish backend TODOs as you hit them (Apify actor input mapping, Box signature
  verification if time allows).

## Hard constraints (do not violate)
- The app holds NO Box/OpenAI/Apify secrets. It uses only the Supabase anon key
  and the scoped upload token from `issue-upload`.
- Follow `API.md` exactly. The app reads clip + job status via the Supabase
  client; it calls edge functions only for `issue-upload` and `make-reel`.
- Edge functions cannot run FFmpeg. All rendering stays in the Fly.io worker.
- Use the EDL JSON contract verbatim. Do not change the locked decisions in PRD §7.
- iOS only. vision-camera needs an Expo dev build, not Expo Go.
- Clips capped at ~15s (Whisper 25MB limit).

## How to work
- Build in the PRD §10 phase order. Start by confirming Phase 0 is done (ask the
  human for the values below), then build Phase 1 (the app's record + upload).
- After each phase, run that phase's smoke test from `RUNBOOK.md` before moving on.
- Commit per phase. Don't scaffold the whole app at once; get capture+upload
  working end to end first, then layer on make-reel and preview.
- When something needs a real credential or a Box/Apify id you don't have, stop
  and ask the human rather than guessing.

## Ask the human for, before Phase 1
- Supabase URL + anon key.
- That `schema.sql` has been run and edge functions are deployed.
- `BOX_RAW_FOLDER_ID` and confirmation the Custom Skill is enabled on it.
- The chosen Apify actor id, so `make-reel`'s `fetchTrends` input can be mapped.

Start now: read the four docs, then tell me what you need from me to begin Phase 1.
