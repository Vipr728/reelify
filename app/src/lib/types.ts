// Shared row + payload types. Mirror sql/schema.sql and docs/API.md exactly.

// clips.status lifecycle (schema.sql): uploaded -> transcribed -> embedded -> analyzed -> ready
export type ClipStatus =
  | 'uploaded'
  | 'transcribed'
  | 'embedded'
  | 'analyzed'
  | 'ready';

export interface Clip {
  id: string;
  owner: string;
  box_file_id: string | null;
  status: ClipStatus;
  transcript: string | null;
  topic: string | null;
  keywords: string[];
  sentiment: string | null;
  duration_s: number | null;
  has_speech: boolean;
  hook_candidate: boolean;
  broll_candidate: boolean;
  created_at: string;
}

// render_jobs.status (schema.sql): queued -> rendering -> done | failed
export type RenderStatus = 'queued' | 'rendering' | 'done' | 'failed';

export interface RenderJobStatus {
  status: RenderStatus;
  output_url: string | null;
  error: string | null;
}

// --- Edit decision list (docs/API.md). Produced by make-reel, played-back shape only here. ---
export interface EdlSegment {
  clip_id: string;
  in_s: number;
  out_s: number;
  caption: string;
}
export interface EdlTransition {
  after_index: number;
  type: string;
  duration_s: number;
}
export interface EdlBroll {
  clip_id: string;
  over_index: number;
  start_s: number;
  duration_s: number;
}
export interface Edl {
  target_duration_s: number;
  segments: EdlSegment[];
  transitions: EdlTransition[];
  broll: EdlBroll[];
}

// POST /issue-upload response (docs/API.md)
export interface IssueUploadResponse {
  upload_token: string;
  folder_id: string;
}

// POST /make-reel response (docs/API.md)
export interface MakeReelResponse {
  job_id: string;
  edl: Edl;
}
