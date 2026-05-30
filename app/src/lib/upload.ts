// Phase 1 upload flow (docs/API.md):
//   1. POST /issue-upload            -> { upload_token, folder_id }
//   2. multipart POST to Box upload  -> { entries: [{ id: box_file_id }] }
//   3. insert a clips row (status 'uploaded') so the clip shows immediately.
//   4. POST { fileId } to box-skill-webhook so it transcribes/embeds/analyzes.
//      Box Custom Skills are gated in the modern dev console, so we trigger the
//      same edge function ourselves. Fire-and-forget; the library polls status.
import { issueUpload } from './api';
import { supabase } from './supabase';
import { DEMO_OWNER, FUNCTIONS_URL, SUPABASE_ANON_KEY } from './config';
import type { Clip } from './types';

const BOX_UPLOAD_URL = 'https://upload.box.com/api/2.0/files/content';

export interface UploadResult {
  boxFileId: string;
  clip: Clip;
}

// localUri: a filesystem path or file:// URL to the recorded .mp4.
// expo-camera returns a file:// URI on iOS; normalize defensively in case a
// future module returns a bare path. RN multipart fetch needs file:// prefix.
export async function uploadClip(localUri: string): Promise<UploadResult> {
  const fileUri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;
  // iOS expo-camera produces .mov; the worker normalizes on render regardless.
  const name = `clip_${Date.now()}.mov`;

  // 1. Scoped Box upload token (folder-limited; the app never sees full creds).
  const { upload_token, folder_id } = await issueUpload();

  // 2. Upload the bytes straight to Box. RN FormData streams the file from its
  // uri without loading it into JS memory.
  const form = new FormData();
  form.append(
    'attributes',
    JSON.stringify({ name, parent: { id: folder_id } }),
  );
  // RN-specific file part shape: { uri, name, type }.
  form.append('file', {
    uri: fileUri,
    name,
    type: 'video/quicktime',
  } as unknown as Blob);

  const res = await fetch(BOX_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${upload_token}` },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Box upload failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { entries: Array<{ id: string }> };
  const boxFileId = json.entries?.[0]?.id;
  if (!boxFileId) throw new Error('Box upload returned no file id');

  // 3. Optimistic clips row so the library shows the clip right away.
  const { data, error } = await supabase
    .from('clips')
    .insert({ box_file_id: boxFileId, status: 'uploaded', owner: DEMO_OWNER })
    .select('*')
    .single();
  if (error) throw new Error(`clips insert failed: ${error.message}`);

  // 4. Kick off server-side processing. Fire-and-forget — the library polls
  // status so the user sees uploaded -> transcribed -> analyzed as it runs.
  fetch(`${FUNCTIONS_URL}/box-skill-webhook`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ fileId: boxFileId }),
  }).catch((e) => console.warn('processing trigger failed', e));

  return { boxFileId, clip: data as Clip };
}
