// In-memory render-job queue. Single-process, single-user — jobs are lost on
// server restart. Documented as such in the README. When we outgrow that
// (multi-user or durability needed), swap this module for a SQLite/Supabase
// implementation behind the same API.

const STATUSES = [
  'queued',
  'building_context',
  'generating_plan',
  'rendering',
  'uploading',
  'done',
  'failed',
];

const TERMINAL_STATUSES = new Set(['done', 'failed']);

const jobs = new Map();

function createJob({ reelName, params = {} } = {}) {
  const id = `render_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  const job = {
    id,
    reelName: reelName || null,
    status: 'queued',
    progress: 0,
    message: 'Queued',
    params,
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    history: [{ status: 'queued', at: now, message: 'Queued' }],
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? { ...job, history: [...job.history] } : null;
}

function listJobs({ reelName, limit = 50 } = {}) {
  const all = [...jobs.values()];
  const filtered = reelName ? all.filter((job) => job.reelName === reelName) : all;
  return filtered
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map((job) => ({ ...job, history: [...job.history] }));
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job not found: ${id}`);
  if (TERMINAL_STATUSES.has(job.status) && patch.status && patch.status !== job.status) {
    throw new Error(`Cannot transition from terminal status ${job.status}`);
  }
  const now = new Date().toISOString();
  if (patch.status && patch.status !== job.status) {
    if (!STATUSES.includes(patch.status)) {
      throw new Error(`Unknown status: ${patch.status}`);
    }
    job.history.push({ status: patch.status, at: now, message: patch.message || '' });
    if (job.startedAt === null && patch.status !== 'queued') {
      job.startedAt = now;
    }
    if (TERMINAL_STATUSES.has(patch.status)) {
      job.finishedAt = now;
    }
  }
  Object.assign(job, patch, { updatedAt: now });
  return { ...job, history: [...job.history] };
}

// Run an async lifecycle function in the background. The function receives a
// helper to report status; rejection automatically transitions to 'failed'.
function runJob(id, lifecycleFn) {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job not found: ${id}`);

  const report = (status, message, extra = {}) => {
    updateJob(id, { status, message, ...extra });
  };

  setImmediate(async () => {
    try {
      await lifecycleFn(report, () => jobs.get(id));
      const finalJob = jobs.get(id);
      if (!TERMINAL_STATUSES.has(finalJob.status)) {
        updateJob(id, { status: 'done', message: 'Finished', progress: 100 });
      }
    } catch (error) {
      console.error(`[render job ${id}] failed:`, error);
      updateJob(id, {
        status: 'failed',
        message: error?.message || 'Render failed',
        error: { message: error?.message || String(error), stack: error?.stack || null },
      });
    }
  });
}

module.exports = { createJob, getJob, listJobs, updateJob, runJob, STATUSES };
