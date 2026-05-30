-- Reelify schema. Run in the Supabase SQL editor.
-- Requires the pgvector extension.

create extension if not exists vector;

-- One row per recorded clip.
create table if not exists clips (
  id            uuid primary key default gen_random_uuid(),
  owner         text not null default 'demo',   -- single-user demo; real auth later
  box_file_id   text unique,
  status        text not null default 'uploaded',
                -- uploaded -> transcribed -> embedded -> analyzed -> ready
  transcript    text,
  topic         text,
  keywords      text[] default '{}',
  sentiment     text,
  duration_s    numeric,
  has_speech    boolean default false,
  hook_candidate  boolean default false,
  broll_candidate boolean default false,
  created_at    timestamptz not null default now()
);

-- text-embedding-3-small is 1536 dimensions.
create table if not exists clip_embeddings (
  id        uuid primary key default gen_random_uuid(),
  clip_id   uuid references clips(id) on delete cascade,
  embedding vector(1536)
);
create index if not exists clip_embeddings_idx
  on clip_embeddings using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Cached / scraped trending reels. Seed this (scripts/seed_trends.mjs) so the
-- demo's "Apify is down" fallback path is never empty.
create table if not exists trend_cache (
  id          uuid primary key default gen_random_uuid(),
  query       text,
  caption     text,
  hashtags    text[] default '{}',
  views       bigint,
  duration_s  numeric,
  embedding   vector(1536),
  fetched_at  timestamptz not null default now()
);

-- A queued render. The Fly.io worker polls this table.
create table if not exists render_jobs (
  id                 uuid primary key default gen_random_uuid(),
  owner              text not null default 'demo',
  status             text not null default 'queued',
                     -- queued -> rendering -> done -> failed
  edl                jsonb not null,
  output_box_file_id text,
  output_url         text,        -- Box shared-link URL the app plays
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Cosine-similarity search over the clip library.
create or replace function match_clips(query_embedding vector(1536), match_count int)
returns table (clip_id uuid, similarity float)
language sql stable as $$
  select e.clip_id, 1 - (e.embedding <=> query_embedding) as similarity
  from clip_embeddings e
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

-- DEMO RLS: permissive so the RN app can read with the anon key.
-- Tighten before anything real. Writes happen via the service role in edge fns.
alter table clips enable row level security;
alter table render_jobs enable row level security;
create policy demo_read_clips on clips for select using (true);
create policy demo_insert_clips on clips for insert with check (true);
create policy demo_read_jobs on render_jobs for select using (true);
