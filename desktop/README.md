# Reelify Desktop — real functionality wiring

The Electron desktop app used to be a self-contained UI prototype running entirely
on `src/data.js` mock data. It is now wired to real backends for stages 2–6:

| Step | Screen | What it does for real | Backend |
|------|--------|-----------------------|---------|
| 1 (01) | `ImportScreen` | Lists your actual Box reels | `GET /api/reels` |
| 2 (02) | `AnalyzeScreen` | Transcribes the reel's facecam (Whisper) + infers niche → topics/throughline | `POST /api/reels/:name/analyze` |
| 3 (03) | `MatchScreen` | Finds real similar creators (Tavily + GPT rank) | `POST /api/creators` |
| 4 (04) | `StyleScreen` | Synthesizes the **master style** (scrape → quantify → aggregate → synthesize) | `POST /api/style` |
| 5 (05) | `StudioScreen` | **Stage 6 timeline:** turns an edit-plan JSON into a real, playable timeline sourced straight from Box | `POST /api/box/resolve`, `GET /api/box/file/:id` |
| 6 (06) | `ExportScreen` | Still mock (render/download) — out of scope for this pass | — |

> Note on "step 6": the timeline lives in the **Studio** screen (shown as `05 / 06`),
> because that is the screen that *has* the timeline UI. The edit-plan → real-timeline
> feature was built there. `ExportScreen` (`06 / 06`) is unchanged. See *Possible mistakes*.

## Architecture

```
Electron renderer (React)                 server/index.js (Express :8787)
  src/api.js  ──HTTP/JSON──────────────►   /api/reels                 ──► Box API
  src/config.js (API_BASE)                 /api/reels/:name/analyze   ──► Box download + ffmpeg + OpenAI Whisper + niche
                                           /api/creators              ──► spawn apify CLI: creators (Tavily+GPT)
                                           /api/style                 ──► spawn apify CLI: scrape→quantify→aggregate→synthesize
                                           /api/box/resolve           ──► Box path/uri → file id
                                           /api/box/file/:id          ──► range-proxied Box file stream (<video src>)
```

- **Transport:** plain `fetch` from the renderer to the local Express server. No
  Electron IPC was added — the server already holds the Box client + OpenAI key and
  has CORS enabled. `preload.cjs`/`main.cjs` are untouched.
- **Apify reuse:** the heavy pipeline (`apify-integration`) is invoked as child
  processes of its existing CLI (`tsx src/cli.ts <stage>`), passing JSON on stdin and
  reading JSON from stdout. Logic is single-sourced; the only duplication is a small
  native niche + Whisper transcription path in the server (so Analyze needs only an
  OpenAI key, not the Tavily/Apify keys).
- **Demo fallback:** if the server is unreachable, screens fall back to bundled demo
  data (`src/data.js`) and show a "Demo data · backend unreachable" badge. Toggle with
  `ALLOW_DEMO_FALLBACK` in `src/config.js`.

## Running it

1. **Credentials.** The repo root `.env` provides `BOX_*`, `OPENAI_API_KEY`,
   `APIFY_TOKEN`, and `TAVILY_API_KEY`. The server loads root `.env` and passes those
   vars to the spawned apify CLI, so a separate `apify-integration/.env` is **not**
   required.
   - **Box token must be fresh.** `getBoxAccessToken()` prefers `BOX_DEVELOPER_TOKEN`,
     which Box expires after ~60 minutes. When it's stale, Box returns `401` (observed
     this session). The durable alternative is CCG (client-credentials), but to use it
     you must remove/comment `BOX_DEVELOPER_TOKEN` in `.env` (otherwise `dotenv` keeps
     loading the stale token) **and** the Box app must be authorized for CCG. Refresh the
     token before expecting any live Box call to succeed.
2. **Install deps** (once):
   ```bash
   npm install                      # root (server, expo)
   (cd apify-integration && npm install)
   (cd desktop && npm install)
   ```
   `ffmpeg` must be on PATH (Whisper audio extraction + the apify quantify stage).
3. **Start the server** (repo root): `npm run server`  → http://localhost:8787
4. **Start the desktop app** (`desktop/`): `npm run dev`  (Vite + Electron)

Override the API location at build time with `VITE_REELIFY_API_URL`.

## Stage 6 — the real timeline

`StudioScreen` accepts a JSON edit plan in **either** of two shapes and normalizes both
(`src/editplan.js`):

- **EditPlan** (machine format, matches `llm-harness` output): `{ schemaVersion, output, assets[], tracks[] }`
  where `tracks` are `kind: "video" | "caption"`. The first video track is the main
  layer; additional video tracks are overlays.
- **Project** (authoring format): `{ project, assets:{talkingHead,broll}, timeline[], captionStyle, editorNotes }`.
  `talking_head` segments become the main layer, `broll` segments the overlay layer.

Load a plan by dropping a `.json` onto the dropzone, clicking to choose a file, or
"Load sample plan".

**Asset resolution (straight from Box).** Each asset reference is resolved to a Box
file id by `POST /api/box/resolve`, which accepts:
- `box://files/<id>` or a bare numeric id → used directly;
- a path like `raw/clip.mp4` or `reel_001/facecam/facecam.mp4` → walked from
  `BOX_RAW_FOLDER_ID`, `BOX_OUTPUT_FOLDER_ID`, and the reels folder (it also retries with
  the first path segment dropped).

The resolved id becomes a `<video src>` pointing at `GET /api/box/file/:id`, which
proxies the Box download and forwards the browser's `Range` header for seeking.
Unresolved assets still appear on the timeline as labeled placeholder blocks (red status
dot) so the layout stays intact.

**Playback.** A requestAnimationFrame clock drives a timeline `t`; the main and overlay
`<video>` elements are imperatively re-sourced and seeked to `sourceIn + (t - tlIn)` as
the playhead crosses clip boundaries. Captions render token-by-token with highlighted
emphasis words. Click the timeline to scrub. The visual language reuses the original
Studio classes (`.studio`-era `.player`, `.tl`/`.lane`/`.clip`/`.playhead`/`.tl-ruler`).

## Files added / changed

Added:
- `desktop/src/config.js` — API base + demo-fallback flag.
- `desktop/src/api.js` — fetch client, response normalizers, recipe→styleDNA mapping, Box resolve/stream helpers.
- `desktop/src/editplan.js` — edit-plan normalizer (both formats) + sample plan.

Changed:
- `desktop/src/App.jsx` — owns all async + state; sequential step-entry triggers; frozen prop contract per screen; demo fallback.
- `desktop/src/screens/{Import,Analyze,Match,Style,Studio}Screen.jsx` — presentational, consume real props/data.
- `desktop/src/styles/screens.css` — shared loading/error/demo states + stage-6 timeline styles.
- `server/index.js` — added `/api/reels/:name/analyze`, `/api/creators`, `/api/style`, `/api/box/resolve`, `/api/box/file/:id`; native Whisper transcription + niche; apify CLI spawn helper; Box `getFacecam` / `downloadFileToPath` / `findChild` / `listFolderItems`; JSON body limit raised to 10mb.

## Verification status (honest)

Confirmed working in this session:
- `vite build` passes (29 modules); no stage screen imports `data.js` anymore.
- Server boots; `/health` → `boxConfigured:true`, `openaiConfigured:true`.
- `/api/box/resolve` for `box://files/<id>` returns the id (no Box call needed).
- Apify CLI spawn path proven: the `aggregate` stage runs through `tsx` via
  stdin/stdout and returns real per-creator JSON (this is the exact mechanism
  `creators`/`scrape`/`quantify`/`synthesize` use).

**Blocked on credentials at time of writing (NOT verified live, NOT a code defect):**
- `/api/reels` returned **`Box API 401`** — the `BOX_DEVELOPER_TOKEN` in `.env` is expired.
- I could not force the CCG path to test it: `dotenv.config()` reloads
  `BOX_DEVELOPER_TOKEN` from the `.env` file even when it's unset in the shell, so
  `getBoxAccessToken()` keeps returning the stale dev token. To test CCG you must remove
  / comment out `BOX_DEVELOPER_TOKEN` in `.env` (and the app must be authorized for CCG).
- Because no Box auth currently succeeds, the live paths that touch Box could **not** be
  exercised end-to-end this session: `/api/reels`, `/api/reels/:name/analyze` (downloads
  facecam), and `/api/box/file/:id` (stream). They are wired and the code path is in
  place; they need a fresh Box token (or CCG authorization) to confirm.
- `/api/creators` and `/api/style` were not run end-to-end either (Tavily + Apify are
  paid/slow, minutes-long); their spawn mechanism is the one proven via `aggregate`.

To finish verification once Box auth is fresh: `npm run server`, then
`curl localhost:8787/api/reels`, pick a reel with a facecam, and load the Studio
timeline with a plan whose assets are `box://files/<id>` or
`reel_001/facecam/facecam.mp4`.

---

# Possible mistakes / risks (honest list)

1. **Box auth was never exercised live this session.** The `.env` `BOX_DEVELOPER_TOKEN`
   is expired (`401`), and I couldn't fall back to CCG to test it because `dotenv`
   reloads the stale token from the file even when unset in the shell. Everything
   Box-dependent (reels list, analyze download, file streaming) is therefore unproven
   end-to-end. If a Box API detail is wrong it would only surface once a valid token
   exists. The non-Box pieces (build, resolve-by-id, apify spawn) are confirmed.

2. **"Step 6" interpretation.** The request said "step 6," but the timeline UI lives in
   the **Studio** screen (`05 / 06`). I built the real timeline there and left
   `ExportScreen` (`06 / 06`) as-is. If you wanted the timeline to replace the Export
   step, it must move.

3. **Long synchronous requests.** `/api/style` runs Apify scrape → quantify →
   synthesize synchronously and can take **several minutes**. No streaming/progress, no
   cancellation. A proxy or client timeout shorter than ~15 min will fail the stage. The
   apify `web-server.ts` streams NDJSON progress; I did not port that here.

4. **Range header across Box's 302 redirect.** `/api/box/file/:id` forwards `Range` to
   Box `/content`, which 302s to `dl.boxcloud.com`. If undici drops `Range` on the
   redirect, Box may return `200` (full file) instead of `206`, hurting seek. Unverified
   live (see #1). No caching either — each seek can re-request bytes.

5. **Mixed content in a packaged build.** Dev renderer is `http://localhost:5173`; a
   packaged build is `file://` fetching `http://localhost:8787`. `file://`→localhost is
   normally allowed, but an `https` renderer would block the plain-HTTP API + video URLs
   as mixed content.

6. **Path-based asset resolution is heuristic.** Real `llm-harness` plans use
   `box://files/<id>` (reliable). The pasted *project* examples use loose paths like
   `raw/person_clip_01.mp4` that may not match actual Box folders. The resolver walks a
   few roots and retries dropping the first segment; it can resolve the wrong file on a
   name collision, or fail to a placeholder. Prefer `box://files/<id>` / a `boxFileId`.

7. **Whisper segments not guaranteed.** `analyze` requests `verbose_json`; if no
   `segments` come back, AnalyzeScreen splits the transcript into sentences without
   timecodes. Very long takes could approach Whisper's upload cap.

8. **styleDNA radar mapping is derived, not measured.** 0–100 axis values are mapped from
   the Recipe (e.g. `cutRate` from `cuts_per_10s/16`); the `grade` axis isn't measured by
   the pipeline and is hardcoded to a neutral 55. Display approximations, not ground truth.

9. **`match %` removed.** The real creators pipeline has no per-creator overlap score, so
   MatchScreen shows **rank** (#1, #2…) instead of a fabricated percentage — a deliberate
   honesty change that differs from the original mock.

10. **Env coupling.** The apify CLI's `env.ts` requires `OPENAI_API_KEY`,
    `TAVILY_API_KEY`, and `APIFY_TOKEN` all present even for stages that don't use all
    three. It works because the server inherits root `.env` and passes it down; running
    the server from a shell missing those vars makes `creators`/`style` fail with
    "Missing/invalid env" even though Analyze still works.

11. **Reel name assumption.** `analyze` validates `:name` as `reel_\d+`. Demo-fallback
    reels (e.g. "Raw — May shoot") never reach the endpoint, but pointing the app at a
    Box folder with differently named reels would 400.

12. **Playback is "good enough," not frame-accurate.** Switching `<video>.src` per clip
    and seeking by wall-clock drifts slightly and can stutter at boundaries; main/overlay
    audio isn't mixed (overlay is muted). It's a preview, not a render.

13. **Parallel-agent screen edits.** The four stage screens were rewritten by separate
    agents against a frozen prop contract. MatchScreen dropped the outer
    `<div className="screen">` wrapper while the others kept it; if that wrapper provided
    padding the others rely on, spacing could be subtly off on that one screen.
