# Reelify API contract

All backend logic lives in Supabase edge functions. The RN app calls these over
HTTPS and reads status via the Supabase client (anon key + demo RLS). The app
holds no Box/OpenAI/Apify keys.

Base URL: `https://<project-ref>.supabase.co/functions/v1`
Auth header on edge-fn calls: `Authorization: Bearer <SUPABASE_ANON_KEY>`

---

## POST /issue-upload

Get a short-lived Box token scoped to the raw-clips folder so the app can upload
a clip directly to Box.

Request: `{}`

Response:
```json
{ "upload_token": "<downscoped box token>", "folder_id": "<raw folder id>" }
```

App then uploads directly:
```
POST https://upload.box.com/api/2.0/files/content
Authorization: Bearer <upload_token>
multipart: attributes={"name":"clip_<ts>.mp4","parent":{"id":"<folder_id>"}}, file=<bytes>
-> { "entries": [ { "id": "<box_file_id>", ... } ] }
```

After upload, the app inserts a placeholder row so the clip shows immediately:
```js
supabase.from('clips').insert({ box_file_id, status: 'uploaded', owner: 'demo' })
```
The Box Skill webhook later upserts the same row to `status: 'analyzed'`.

---

## POST /make-reel

Build an edit and queue a render.

Request:
```json
{ "topic": "building an app solo" }
```

Response:
```json
{ "job_id": "<uuid>", "edl": { ...validated edit decision list... } }
```

Errors: `422 { "error": "no usable clips for this topic" }` when no clip matches.

---

## Status polling (Supabase client, no edge fn)

Clip library + per-clip status:
```js
supabase.from('clips').select('*').order('created_at', { ascending: false })
// status: uploaded -> transcribed -> embedded -> analyzed
```

Render job status + playback URL:
```js
supabase.from('render_jobs').select('status, output_url, error').eq('id', jobId).single()
// status: queued -> rendering -> done | failed
// when done, output_url is a Box shared link the app plays in a <Video> component
```

Poll every ~3s while `status` is `queued` or `rendering`.

---

## Edit decision list (EDL) shape

Produced by `make-reel`, consumed by the render worker. Already validated
(clip_ids whitelisted, trim points clamped) before it reaches the worker.

```json
{
  "target_duration_s": 20,
  "segments": [
    { "clip_id": "uuid", "in_s": 0, "out_s": 4.5, "caption": "POV: 2am bug fix" }
  ],
  "transitions": [ { "after_index": 0, "type": "xfade", "duration_s": 0.4 } ],
  "broll": [ { "clip_id": "uuid", "over_index": 1, "start_s": 1.0, "duration_s": 2.0 } ]
}
```
