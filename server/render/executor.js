// Render executor: takes a validated EditPlan, downloads source assets, runs
// FFmpeg with the filter graph from filter-graph.js, uploads the resulting MP4
// to Box, and updates the reel manifest with the new edit.

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const { buildRenderPlan, buildSubtitles } = require('./filter-graph');

const FFMPEG_TIMEOUT_MS = Number(process.env.RENDER_FFMPEG_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_FFMPEG_BUFFER = 4 * 1024 * 1024;

async function executeRender({ plan, reelFolderId, reelName, jobId, box, workRoot, report }) {
  const jobDir = path.join(workRoot, jobId);
  const inputsDir = path.join(jobDir, 'inputs');
  const outputPath = path.join(jobDir, 'output.mp4');
  const subtitlePath = path.join(jobDir, 'captions.ass');

  await fs.mkdir(inputsDir, { recursive: true });

  try {
    report?.('rendering', 'Downloading source assets', { progress: 35 });
    const inputPaths = new Map();
    let downloaded = 0;
    for (const asset of plan.assets) {
      if (!asset.boxFileId) {
        // Allow local paths for testing — uri may already be an absolute path.
        if (asset.uri && fsSync.existsSync(asset.uri)) {
          inputPaths.set(asset.id, asset.uri);
          continue;
        }
        throw new Error(`Asset ${asset.id} has no boxFileId and no resolvable local path`);
      }
      const localPath = path.join(inputsDir, `${safeAssetId(asset.id)}${extForKind(asset.kind)}`);
      await box.downloadFile(asset.boxFileId, localPath);
      inputPaths.set(asset.id, localPath);
      downloaded += 1;
    }

    report?.('rendering', `Downloaded ${downloaded} asset(s); writing captions`, { progress: 45 });

    const hasCaptions = plan.tracks.captions.some((track) => track.items.length > 0);
    let subtitleArg = null;
    if (hasCaptions) {
      const assContent = buildSubtitles(plan);
      await fs.writeFile(subtitlePath, assContent, 'utf8');
      subtitleArg = subtitlePath;
    }

    const renderPlan = buildRenderPlan(plan, { inputPaths, subtitlePath: subtitleArg });
    const fullArgs = [...renderPlan.args, outputPath];

    report?.('rendering', 'Running FFmpeg', { progress: 55 });
    await runFfmpeg(fullArgs, jobId);

    const stat = await fs.stat(outputPath);
    if (stat.size === 0) {
      throw new Error('FFmpeg produced an empty file');
    }

    report?.('uploading', 'Uploading rendered video to Box', { progress: 85 });
    const editsFolder = await box.ensureFolder(reelFolderId, 'edits');
    const fileName = `edit_${stampForFilename()}.mp4`;
    const uploaded = await box.uploadFileOrVersion(editsFolder.id, fileName, outputPath, 'video/mp4');

    report?.('uploading', 'Updating manifest', { progress: 95 });
    const editRecord = {
      edit_id: fileName.replace(/\.mp4$/, ''),
      file_id: uploaded.id,
      file_name: uploaded.name,
      path: `/reels/${reelName}/edits/${fileName}`,
      duration_seconds: plan.output.durationSec,
      width: plan.output.width,
      height: plan.output.height,
      fps: plan.output.fps,
      size_bytes: stat.size,
      job_id: jobId,
      created_at: new Date().toISOString(),
    };

    await box.upsertManifest(reelFolderId, (current) => {
      const next = current && typeof current === 'object'
        ? { ...current, edits: Array.isArray(current.edits) ? [...current.edits] : [] }
        : { edits: [] };
      next.edits.push(editRecord);
      return next;
    });

    return {
      ok: true,
      reelName,
      output: editRecord,
      ffmpegArgsCount: fullArgs.length,
    };
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args, jobId) {
  return new Promise((resolve, reject) => {
    const child = execFile('ffmpeg', args, { maxBuffer: MAX_FFMPEG_BUFFER, timeout: FFMPEG_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        const tail = (stderr || '').split('\n').slice(-20).join('\n');
        const error = new Error(`FFmpeg failed for job ${jobId}: ${err.message}\n${tail}`);
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.on('error', reject);
  });
}

function safeAssetId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function extForKind(kind) {
  switch (kind) {
    case 'music':
    case 'sfx':
      return '.mp3';
    default:
      return '.mp4';
  }
}

function stampForFilename() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}_${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

module.exports = { executeRender };
