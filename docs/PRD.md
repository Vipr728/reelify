# Reelify — Product Requirements Document

**Version:** 3.0 (comprehensive, gaps closed)
**Status:** All key decisions locked. Backend scaffolded. Ready for agent build.
**Sponsors featured:** Box (storage, Custom Skills, metadata, AI), Apify (trend scraping).

---

## 1. Summary

Reelify turns raw phone footage into a postable short-form video. You record vertical clips Snapchat-style, they land in Box, a Box Custom Skill transcribes and tags each one, Apify pulls what's trending on TikTok/Instagram for that topic, and OpenAI assembles your best clips, with transitions and b-roll cutaways, into an edit tuned to the trend. FFmpeg renders it, Box stores it, you preview and share.

## 2. Problem

Creators record far more footage than they edit. Editing is slow, and knowing what format is working right now is guesswork. Reelify removes both: it watches your clip library and the live trend signal, then produces the edit for you.

## 3. Target user

Solo creators and small social teams sitting on unedited clips who want "give me a postable reel from what I shot, matched to what's working now."

## 4. Assumptions (confirm before build)

- You have admin access to a Box enterprise or developer enterprise (needed to enable Custom Skills on a folder and create metadata templates).
- Primary trend platform is TikTok (Apify actor configurable for Instagram).
- Clips are capped at ~15s so they stay under Whisper's 25MB limit and render fast.
- Single demo user. No real auth. Permissive RLS on read tables.

## 5. Core user flow

1. Open Reelify (iOS), hit record, capture one or many short vertical clips.
2. App fetches a scoped Box upload token and uploads each clip directly to Box.
3. A Box Skill fires per upload: transcribe, tag, embed, write the datapoint. The library shows a status badge per clip (uploaded -> transcribed -> embedded -> analyzed).
4. User enters or confirms a topic and taps "Make a reel."
5. Reelify matches clips by embedding similarity, pulls trends from Apify, OpenAI builds and the system validates the edit plan.
6. FFmpeg renders, the final lands in Box, the app plays it via a Box shared link.

## 6. System architecture

Client holds no secrets. Supabase edge functions orchestrate and store secrets. A separate Fly.io FFmpeg worker renders, because edge functions run on Deno isolates and cannot execute native FFmpeg.

```
[RN App, iOS]
   | POST /issue-upload -> scoped Box token
   | upload clip directly to Box; insert clips row (status 'uploaded')
   v
[Box: raw clips folder] --upload event--> [box-skill-webhook (edge fn)]
                                              | Whisper ASR
                                              | GPT datapoint extract
                                              | OpenAI embed --> [pgvector]
                                              | skill cards --> [Box preview sidebar]
                                              '--datapoint --> [Box metadata template]
[RN App] --POST /make-reel {topic}--> [make-reel (edge fn)]
   | embed topic -> match_clips (pgvector cosine)
   | Apify actor call --> trending reels   (fallback: trend_cache)
   | GPT --> EDL --> validateEdl (whitelist clips, clamp times)
   '--insert render_jobs (queued)
                                              v
                                   [Fly.io FFmpeg worker]
                                      | claim job, pull clips from Box
                                      | normalize 1080x1920 / 30fps / sar 1
                                      | full render: xfade + overlay + captions
                                      | fallback: concat + captions on error
                                      | upload final --> Box, create shared link
                                      '--mark job done (output_url) --> app plays
```

## 7. Decisions (locked)

| Area | Choice |
|---|---|
| Platform | iOS only, Expo dev client + react-native-vision-camera |
| App auth | Supabase anon key + permissive demo RLS; scoped Box upload token from issue-upload |
| Orchestration | Supabase edge functions + Postgres |
| Vector store | Supabase pgvector |
| Transcription | Box Custom Skill + Whisper as the ASR |
| Similarity | Embeddings from day one (text-embedding-3-small, 1536d) |
| Edit planning | GPT-4o, strict JSON EDL, server-validated |
| Render | FFmpeg in a Fly.io worker, not in edge functions |
| Edit scope | Full: cut + stitch + xfade + b-roll + captions, graceful fallback to concat + captions |
| Playback | Box shared link stored as render_jobs.output_url |

## 8. The "datapoint"

Per clip: clip_id, owner, box_file_id, status, transcript, topic, keywords[], sentiment, duration_s, has_speech, hook_candidate, broll_candidate, embedding(1536). Surfaced in Box as skill cards + the `reelify_datapoint` metadata template, and stored in Supabase. Template field spec is in `BOX_SETUP.md`.

## 9. Interfaces

Full request/response shapes for `issue-upload`, `make-reel`, status polling, and the EDL are in `API.md`. The app reads clip + job status via the Supabase client; it calls edge functions only for upload tokens and reel generation.

## 10. Build sequence with acceptance criteria

Two builders, ~36 working hrs. After Phase 0, App track and Backend track run in parallel.

**P0 Setup (shared, ~4h).** Box CCG app + Custom Skill + folders + `reelify_datapoint` template; Supabase + `schema.sql` + pgvector; Apify actor + token; OpenAI key; Fly.io worker that builds; seed `trend_cache`.
Done when: manual Box upload smoke test (BOX_SETUP §6) passes and the worker logs "render worker up".

**P1 Capture + upload (App, ~5h).** vision-camera vertical record, ~15s cap, multi-clip; call issue-upload; direct Box upload; insert clips row; library + polling.
Done when: a recorded clip appears in the Box raw folder and as a `clips` row with status 'uploaded'.

**P2 Transcription + datapoint + embed (Backend, ~6h).** Webhook: Whisper, GPT datapoint, embed to pgvector, skill cards + metadata write, update clips.
Done when: that row flips to 'analyzed', transcript + topic populate, Box shows skill cards.

**P3 Trend + matching (Backend, ~4h).** make-reel embed + match_clips; Apify call; embed + rank trends; trend_cache fallback.
Done when: make-reel returns trends (real or cached) and a non-empty matched clip set.

**P4 Edit plan (Backend, ~3h).** GPT EDL + validateEdl + insert render_jobs.
Done when: edl.segments is non-empty and every clip_id exists.

**P5 Render (Backend, top risk, ~8h).** Worker poll + claim; normalize; baseline; xfade + b-roll; fallback; upload + shared link.
Done when: a job goes queued -> rendering -> done with a playable output_url.

**P6 Preview + polish (App, ~4h).** Play output_url; error/empty states; demo script; rehearse fallback.
Done when: the app plays a rendered reel end to end.

MVP critical path: P0 -> P2 -> P3 -> P4 -> P5 -> P6.

## 11. MVP vs stretch

**MVP:** everything in §10. Single user, dev token.
**Stretch (after MVP, ordered):** re-roll alternate edits (~2h); auto-hashtag suggestions from Apify (~1.5h); one-tap export to camera roll (~1.5h).

## 12. Repo map

```
reelify/
  README.md
  CLAUDE_CODE_PROMPT.md      handoff prompt for Claude Code
  .env.example
  docs/  PRD.md  API.md  BOX_SETUP.md  RUNBOOK.md
  sql/   schema.sql          tables + pgvector + match_clips + demo RLS
  supabase/functions/
    _shared/box.ts           app token, downscope, download, skill cards, metadata, shared link, upload
    _shared/openai.ts        Whisper, embeddings, datapoint, EDL
    issue-upload/index.ts    scoped Box upload token
    box-skill-webhook/index.ts
    make-reel/index.ts       match + Apify + EDL + validate + enqueue
  render-worker/  render.mjs  Dockerfile  package.json
  scripts/  seed_trends.mjs
  app/                        RN app (Claude Code builds this)
```

## 13. Risks + mitigations

- Full edit (xfade + overlay) is the top time risk. Normalize on ingest; worker degrades to concat + captions on error so the demo never returns empty.
- TikTok/Instagram scraping breaks against ToS and site changes. Seeded `trend_cache` is the live fallback.
- Whisper 25MB limit. ~15s clip cap keeps files under it; revisit if clips get longer.
- Box Skill setup (admin enablement, public webhook, signature verification) is the biggest single time sink. Day one. Signature verification is a documented TODO before real use.
- Single render worker: the select-then-update claim is not atomic. Fine for one worker; add `for update skip locked` if you scale out.
- Never ship Box/Apify/OpenAI keys in the app bundle.

## 14. Success metrics (demo + judging)

- A recorded clip becomes a rendered reel stored in Box, live, under ~2 min.
- Box surface visible: skill cards + datapoint in the preview sidebar.
- Apify surface visible: trending reels (or cache) shown to influence the edit.
- Reliability: render never returns empty (fallback path).

## 15. Demo script

1. Record two or three short clips on a topic in the app.
2. Show them in Box with transcript + topic skill cards filled in.
3. Tap "Make a reel," show the trend list Apify returned.
4. Show the validated edit plan, then the rendered video playing from Box.
5. Call out the Box + Apify integration points as the sponsor story.

## 16. Open items

- Final visual identity / logo.
- Confirm the exact Apify actor and map its input/output in `make-reel` `fetchTrends`.
- Caption styling (font, position) once on-device preview looks right.
