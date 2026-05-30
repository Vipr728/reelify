# Box setup (do this first, it's the day-one time sink)

Requires admin access to a Box enterprise or a Box developer enterprise. Custom
Skills must be enabled on a folder by an admin, and metadata templates need
enterprise scope. Confirm you have this before anything else.

## 1. Create the app (Client Credentials Grant)

Box Developer Console > Create Platform App > Custom App > Server Authentication
(Client Credentials Grant). Note the Client ID and Client Secret. Under app
settings, authorize/enable the app in the Admin Console so CCG works against the
enterprise. Record the Enterprise ID.

App scopes: read + write all files, manage metadata templates.

## 2. Folders

Create two folders and record their IDs:
- Raw clips folder -> `BOX_RAW_FOLDER_ID` (the Skill watches this one)
- Output folder -> `BOX_OUTPUT_FOLDER_ID`

## 3. Metadata template `reelify_datapoint`

Admin Console > Content > Metadata, create a template with templateKey
`reelify_datapoint` and these fields:

| Field key | Display name | Type |
|---|---|---|
| topic | Topic | Text |
| sentiment | Sentiment | Dropdown (positive, neutral, negative) |
| hook_candidate | Hook candidate | Dropdown (true, false) |
| broll_candidate | B-roll candidate | Dropdown (true, false) |

(The webhook writes these via the enterprise metadata API. Adjust field keys if
you change `writeDatapoint` in `_shared/box.ts`.)

## 4. Custom Skill

Create a SECOND app of type Custom Skill (or configure the skill on the same
enterprise). Set its `invocation_url` to your deployed webhook:
`https://<project-ref>.supabase.co/functions/v1/box-skill-webhook`
During local dev, expose the function with a tunnel (e.g. ngrok) and use that URL.

Enable the skill on the raw clips folder. Now every upload there fires the
webhook with read/write tokens.

## 5. Constraints to respect

- Whisper caps upload at 25MB. Keep clips short (app records max ~15s) so the
  video stays under the limit when the webhook sends it to Whisper.
- Production must verify the Box signature headers
  (`box-signature-primary` / `secondary`) before trusting a webhook payload. The
  scaffold skips this for hackathon speed; add it before any real use.

## 6. Quick check

Upload a short clip to the raw folder by hand. Within a few seconds the Box
preview sidebar should show a Transcript card and a Topics card, and a `clips`
row should appear in Supabase with `status = 'analyzed'`.
