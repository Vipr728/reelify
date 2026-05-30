// Phase 1 upload flow (docs/API.md):
//   1. POST /issue-upload            -> { upload_token, folder_id }
//   2. multipart POST to Box upload  -> { entries: [{ id: box_file_id }] }
//   3. insert a clips row (status 'uploaded') so the clip shows immediately.
// The Box Skill webhook later upserts that same row to 'analyzed'.
import { issueUpload } from './api';
import { supabase } from './supabase';
import { DEMO_OWNER } from './config';
import type { Clip } from './types';

const BOX_UPLOAD_URL = 'https://upload.box.com/api/2.0/files/content';

export interface UploadResult {
  boxFileId: string;
  clip: Clip;
}

// localUri: a filesystem path or file:// URL to the recorded .mp4.
// vision-camera returns a bare filesystem path, so we normalize to file:// for
// the React Native multipart fetch.
export async function uploadClip(localUri: string): Promise<UploadResult> {
  const fileUri = localUri.startsWith('file://') ? localUri : `file://${localUri}`;
  const name = `clip_${Date.now()}.mp4`;

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
    type: 'video/mp4',
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

  return { boxFileId, clip: data as Clip };
}
