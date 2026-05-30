// Supabase edge function: issue-upload
// The RN app calls this before recording uploads. It returns a short-lived Box
// token scoped to ONLY the raw-clips folder, so the app uploads straight to Box
// without ever seeing full credentials.
//
// App flow:
//   1. POST /issue-upload  -> { upload_token, folder_id }
//   2. App uploads the clip directly to https://upload.box.com/api/2.0/files/content
//   3. App optimistically inserts a clips row (status 'uploaded') via the anon client
//   4. The Box Skill fires and the webhook upserts that row to 'analyzed'

import { getAppToken, downscopeForUpload } from "../_shared/box.ts";

const RAW_FOLDER = Deno.env.get("BOX_RAW_FOLDER_ID")!;

Deno.serve(async (_req) => {
  try {
    const appToken = await getAppToken();
    const uploadToken = await downscopeForUpload(appToken, RAW_FOLDER);
    return new Response(
      JSON.stringify({ upload_token: uploadToken, folder_id: RAW_FOLDER }),
      { headers: { "content-type": "application/json" } },
    );
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
