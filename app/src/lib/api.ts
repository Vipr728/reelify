// Edge-function calls. The app only ever calls two edge functions directly:
// issue-upload (scoped Box upload token) and make-reel. Everything else is read
// via the Supabase client. See docs/API.md.
import { FUNCTIONS_URL, SUPABASE_ANON_KEY } from './config';
import type { IssueUploadResponse, MakeReelResponse } from './types';

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'content-type': 'application/json',
  };
}

// POST /issue-upload -> { upload_token, folder_id }
export async function issueUpload(): Promise<IssueUploadResponse> {
  const res = await fetch(`${FUNCTIONS_URL}/issue-upload`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    throw new Error(`issue-upload failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as IssueUploadResponse;
}

// POST /make-reel { topic } -> { job_id, edl }
// 422 { error } when no clip matches the topic.
export class MakeReelError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'MakeReelError';
  }
}

export async function makeReel(topic: string): Promise<MakeReelResponse> {
  const res = await fetch(`${FUNCTIONS_URL}/make-reel`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ topic }),
  });
  if (!res.ok) {
    let message = `make-reel failed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // non-JSON error body; keep default message
    }
    throw new MakeReelError(message, res.status);
  }
  return (await res.json()) as MakeReelResponse;
}
