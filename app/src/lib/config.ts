// Reelify app config.
// These are PUBLIC client values only: the Supabase project URL and the anon
// key (guarded by permissive demo RLS). The app holds NO Box / OpenAI / Apify
// secrets — it gets a short-lived scoped Box upload token from the issue-upload
// edge function at upload time. See docs/API.md.

export const SUPABASE_URL = 'https://pylbexbnfrbojnvhcewm.supabase.co';

// Legacy anon JWT (public; demo RLS allows read/insert on clips + read on render_jobs).
export const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5bGJleGJuZnJib2pudmhjZXdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwOTY0ODMsImV4cCI6MjA5NTY3MjQ4M30.cCeX4cf-Aizkh-bnggoZdukcfW68ND6BmzvGe-89snU';

// Edge function base URL.
export const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// How often to poll clip / render-job status (ms). API.md: ~3s.
export const POLL_INTERVAL_MS = 3000;

// Max clip length in seconds. Keeps files under Whisper's 25MB limit (PRD §4).
export const MAX_CLIP_DURATION_S = 15;

export const DEMO_OWNER = 'demo';
