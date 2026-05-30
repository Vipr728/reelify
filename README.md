# Reelify

Record vertical clips Snapchat-style, and Reelify turns your best footage into an
edited short-form video tuned to what's trending. Clips live in Box, a Box Custom
Skill transcribes and tags them, Apify surfaces trending TikTok/Instagram reels,
OpenAI plans the edit, and FFmpeg renders it.

Built around Box and Apify as the hackathon sponsor integrations.

## Where to start

1. `docs/PRD.md` — the full product + technical spec.
2. `CLAUDE_CODE_PROMPT.md` — paste into Claude Code to start building.
3. `docs/BOX_SETUP.md` — Box console setup (do this first, biggest time sink).
4. `docs/RUNBOOK.md` — deploy order and smoke tests.
5. `docs/API.md` — endpoint and status-polling contracts.

## Layout

```
docs/                product + interface + setup docs
sql/schema.sql       Supabase schema (pgvector, match_clips, demo RLS)
supabase/functions/  edge functions: issue-upload, box-skill-webhook, make-reel
render-worker/       Fly.io FFmpeg worker
scripts/             trend_cache seeding
app/                 RN iOS app (built by Claude Code)
.env.example         every secret needed
```

## Architecture in one line

App uploads clips to Box -> Box Skill transcribes + embeds -> make-reel matches
clips and Apify trends -> OpenAI plans the edit -> Fly.io FFmpeg worker renders ->
app plays the result from Box.

Decisions are locked in `docs/PRD.md` §7. The render worker always falls back to a
plain cut so a live demo never returns an empty video.
