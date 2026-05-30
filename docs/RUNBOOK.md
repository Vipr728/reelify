# Reelify runbook

## Deploy order

1. **Supabase project.** Run `sql/schema.sql` in the SQL editor. Confirm pgvector
   is on and `match_clips` exists.
2. **Secrets.** Fill `.env` from `.env.example`. `supabase secrets set --env-file .env`.
3. **Box.** Follow `docs/BOX_SETUP.md` fully. Get the manual-upload smoke test
   (step 6 there) passing before touching the app.
4. **Edge functions.** `supabase functions deploy issue-upload box-skill-webhook make-reel`.
   Point the Box Skill `invocation_url` at the deployed `box-skill-webhook`.
5. **Trend seed.** `node scripts/seed_trends.mjs` so the fallback path has data.
6. **Render worker.** `cd render-worker && fly launch && fly deploy`. Set the same
   secrets on Fly (`fly secrets set ...`). Confirm logs show "render worker up".
7. **App.** Build per `CLAUDE_CODE_PROMPT.md`. Point it at the Supabase URL + anon key.

## Smoke test per phase

- **P1 (capture+upload):** record a clip in the app, confirm the file lands in the
  Box raw folder and a `clips` row appears with `status = 'uploaded'`.
- **P2 (skill):** within a few seconds that row flips to `analyzed`, transcript +
  topic populate, and Box shows the skill cards.
- **P3 (trends):** call `make-reel` with a topic, confirm it returns trends
  (or cached trends if Apify is down) and a non-empty matched clip set.
- **P4 (edl):** the response `edl.segments` is non-empty and every `clip_id` exists.
- **P5 (render):** a `render_jobs` row goes queued -> rendering -> done, and
  `output_url` is a playable Box link.
- **P6 (preview):** the app plays `output_url` end to end.

## Debugging

- Edge function logs: `supabase functions logs <name>`.
- Worker logs: `fly logs`.
- If render fails, the job row's `error` column has the message; the worker still
  attempts the baseline concat before marking failed.
