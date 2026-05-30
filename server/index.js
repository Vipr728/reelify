const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const multer = require('multer');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { transcribeVideo } = require('./transcribe');
const renderJobs = require('./render/jobs');
const { executeRender } = require('./render/executor');

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.REELIFY_SERVER_PORT || 8787);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(__dirname, '.tmp');
const UPLOAD_DIR = path.join(TMP_ROOT, 'uploads');
const WORK_DIR = path.join(TMP_ROOT, 'work');
const RENDER_WORK_DIR = path.join(TMP_ROOT, 'render');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const BOX_API_BASE = 'https://api.box.com/2.0';
const BOX_UPLOAD_BASE = 'https://upload.box.com/api/2.0';
const OPENAI_MODEL = process.env.OPENAI_BROLL_MODEL || 'gpt-4.1-mini';

fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
fsSync.mkdirSync(WORK_DIR, { recursive: true });
fsSync.mkdirSync(RENDER_WORK_DIR, { recursive: true });

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

let boxTokenCache = null;

app.use(cors());
app.use(express.json());

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    boxConfigured: hasBoxConfig(),
    boxAuthMode: process.env.BOX_DEVELOPER_TOKEN ? 'developer_token' : 'client_credentials',
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    uploadLimitMb: MAX_UPLOAD_BYTES / 1024 / 1024,
  });
});

app.get('/api/reels', async (_request, response) => {
  try {
    const box = await createBoxClient();
    const reelsFolder = await box.getReelsFolder();
    const reels = await box.listReels(reelsFolder.id);

    response.json({
      ok: true,
      reelsFolder: miniItem(reelsFolder),
      reels,
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  }
});

app.post('/api/reels', async (_request, response) => {
  try {
    const box = await createBoxClient();
    const reelsFolder = await box.getReelsFolder();
    const reelFolder = await box.createNextReelFolder(reelsFolder.id);
    const manifest = await box.upsertManifest(reelFolder.id, (currentManifest) =>
      baseManifest(currentManifest, reelFolder.name)
    );
    const reel = await box.getReelSummary(reelFolder);

    response.json({
      ok: true,
      reel,
      manifestFile: miniItem(manifest),
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  }
});

// --- TEMP Phase 2 render-test endpoints. Replaced by /api/reels/:id/render in Phase 3. ---
app.post('/render/_test', express.json({ limit: '4mb' }), async (request, response) => {
  try {
    const plan = request.body?.plan;
    const reelName = normalizeOptionalReelName(request.body?.reelName);
    if (!plan || typeof plan !== 'object') {
      response.status(400).json({ error: 'Body must include a "plan" object (EditPlan).' });
      return;
    }
    if (!reelName) {
      response.status(400).json({ error: '"reelName" is required.' });
      return;
    }

    const box = await createBoxClient();
    const reelsFolder = await box.getReelsFolder();
    const reelFolder = await box.getReelFolderByName(reelsFolder.id, reelName);

    const job = renderJobs.createJob({ reelName, params: { source: 'test', planSummary: summarizePlan(plan) } });
    renderJobs.runJob(job.id, async (report) => {
      report('rendering', 'Starting render', { progress: 10 });
      const result = await executeRender({
        plan,
        reelFolderId: reelFolder.id,
        reelName: reelFolder.name,
        jobId: job.id,
        box,
        workRoot: RENDER_WORK_DIR,
        report,
      });
      renderJobs.updateJob(job.id, {
        status: 'done',
        message: 'Render complete',
        progress: 100,
        result,
      });
    });

    response.json({ ok: true, jobId: job.id, status: job.status });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  }
});

app.get('/render/jobs/:jobId', (request, response) => {
  const job = renderJobs.getJob(request.params.jobId);
  if (!job) {
    response.status(404).json({ error: `Job not found: ${request.params.jobId}` });
    return;
  }
  response.json({ ok: true, job });
});

app.get('/render/jobs', (request, response) => {
  const { reelName, limit } = request.query;
  response.json({
    ok: true,
    jobs: renderJobs.listJobs({
      reelName: typeof reelName === 'string' ? reelName : undefined,
      limit: limit ? Number(limit) : undefined,
    }),
  });
});

function summarizePlan(plan) {
  if (!plan || typeof plan !== 'object') return null;
  try {
    return {
      durationSec: plan?.output?.durationSec,
      assets: Array.isArray(plan.assets) ? plan.assets.length : 0,
      videoItems: countTrackItems(plan?.tracks?.video),
      audioItems: countTrackItems(plan?.tracks?.audio),
      captionItems: countTrackItems(plan?.tracks?.captions),
    };
  } catch {
    return null;
  }
}

function countTrackItems(tracks) {
  if (!Array.isArray(tracks)) return 0;
  return tracks.reduce((sum, track) => sum + (Array.isArray(track?.items) ? track.items.length : 0), 0);
}

app.get('/api/reels/:reelName/clips/:clipId/status', async (request, response) => {
  try {
    const reelName = normalizeOptionalReelName(request.params.reelName);
    if (!reelName) {
      response.status(400).json({ error: 'reelName is required' });
      return;
    }
    const clipId = String(request.params.clipId || '').trim();
    if (!clipId) {
      response.status(400).json({ error: 'clipId is required' });
      return;
    }

    const box = await createBoxClient();
    const reelsFolder = await box.getReelsFolder();
    const reelFolder = await box.getReelFolderByName(reelsFolder.id, reelName);
    const manifest = await box.downloadManifest(reelFolder.id);
    if (!manifest) {
      response.status(404).json({ error: 'Reel manifest not found' });
      return;
    }

    if (clipId === 'facecam') {
      const facecam = manifest.facecam || null;
      if (!facecam) {
        response.status(404).json({ error: 'Facecam clip not found in reel' });
        return;
      }
      response.json({
        ok: true,
        kind: 'facecam',
        reelName,
        clipId: 'facecam',
        status: facecam.transcript_status || 'pending',
        transcriptPreview: facecam.transcript_preview || '',
        transcriptError: facecam.transcript_error || null,
        durationSeconds: facecam.duration_seconds || null,
        path: facecam.path || null,
        uploadedAt: facecam.uploaded_at || null,
      });
      return;
    }

    const broll = (manifest.broll || []).find((clip) => clip.clip_id === clipId);
    if (!broll) {
      response.status(404).json({ error: `Clip not found: ${clipId}` });
      return;
    }
    response.json({
      ok: true,
      kind: 'broll',
      reelName,
      clipId: broll.clip_id,
      status: broll.tagging_status || 'complete',
      summary: broll.summary || null,
      tags: broll.tags || [],
      durationSeconds: broll.duration_seconds || null,
      path: broll.path || null,
      metadataPath: broll.metadata_path || null,
      uploadedAt: broll.uploaded_at || null,
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  }
});

app.post('/api/clips', upload.single('clip'), async (request, response) => {
  const cleanupPaths = [];

  try {
    if (!request.file) {
      response.status(400).json({ error: 'Upload a video file in the "clip" form field.' });
      return;
    }

    cleanupPaths.push(request.file.path);

    const clipType = normalizeClipType(request.body.clipType);
    const durationSeconds = Number(request.body.durationSeconds || 0);
    const createdAt = request.body.createdAt
      ? new Date(Number(request.body.createdAt)).toISOString()
      : new Date().toISOString();
    const reelName = normalizeOptionalReelName(request.body.reelName);

    const result =
      clipType === 'talking'
        ? await saveFacecamClip({ file: request.file, durationSeconds, createdAt, reelName })
        : await saveBrollClip({ file: request.file, durationSeconds, createdAt, cleanupPaths, reelName });

    response.json(result);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  } finally {
    await Promise.all(cleanupPaths.map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
  }
});

app.listen(PORT, () => {
  console.log(`Reelify upload server listening on http://localhost:${PORT}`);
});

async function saveFacecamClip({ file, durationSeconds, createdAt, reelName }) {
  const box = await createBoxClient();
  const reelsFolder = await box.getReelsFolder();
  const reelFolder = reelName
    ? await box.getReelFolderByName(reelsFolder.id, reelName)
    : await box.createNextReelFolder(reelsFolder.id);
  const facecamFolder = await box.ensureFolder(reelFolder.id, 'facecam');
  await box.ensureFolder(reelFolder.id, 'broll');

  const uploadedVideo = await box.uploadFileOrVersion(facecamFolder.id, 'facecam.mp4', file.path, file.mimetype);

  const transcribeWorkDir = path.join(WORK_DIR, `transcribe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let transcriptResult = null;
  let transcriptError = null;

  try {
    console.log(`[facecam] transcribing ${path.basename(file.path)} (${durationSeconds}s)`);
    transcriptResult = await transcribeVideo({ videoPath: file.path, workDir: transcribeWorkDir });
    console.log(`[facecam] transcribed in ${transcriptResult.elapsedMs}ms (${transcriptResult.text.length} chars)`);
  } catch (error) {
    transcriptError = error;
    console.error(`[facecam] transcription failed: ${getPublicErrorMessage(error)}`);
  } finally {
    await fs.rm(transcribeWorkDir, { recursive: true, force: true }).catch(() => {});
  }

  const transcriptText = transcriptResult?.text || '';
  const transcriptJson = transcriptResult
    ? {
        status: 'complete',
        text: transcriptResult.text,
        segments: transcriptResult.segments,
        words: transcriptResult.words,
        language: transcriptResult.language,
        duration: transcriptResult.duration,
        model: transcriptResult.model,
        created_at: createdAt,
        transcribed_at: new Date().toISOString(),
      }
    : {
        status: 'failed',
        text: '',
        segments: [],
        words: [],
        error: transcriptError ? getPublicErrorMessage(transcriptError) : 'Unknown transcription error',
        created_at: createdAt,
        transcribed_at: new Date().toISOString(),
      };

  const transcriptTextFile = await box.uploadTextOrVersion(
    facecamFolder.id,
    'transcript.txt',
    transcriptText ? `${transcriptText}\n` : 'Transcript unavailable.\n',
    'text/plain'
  );
  const transcriptJsonFile = await box.uploadJsonOrVersion(
    facecamFolder.id,
    'transcript.json',
    transcriptJson
  );

  const transcriptStatus = transcriptJson.status;

  const manifest = await box.upsertManifest(reelFolder.id, (currentManifest) => ({
    ...baseManifest(currentManifest, reelFolder.name),
    facecam: {
      file_id: uploadedVideo.id,
      file_name: uploadedVideo.name,
      path: `/reels/${reelFolder.name}/facecam/facecam.mp4`,
      duration_seconds: durationSeconds,
      transcript_text_file_id: transcriptTextFile.id,
      transcript_json_file_id: transcriptJsonFile.id,
      transcript_status: transcriptStatus,
      transcript_preview: transcriptText.slice(0, 280),
      transcript_error: transcriptStatus === 'failed' ? transcriptJson.error : null,
      uploaded_at: new Date().toISOString(),
    },
  }));
  const reel = await box.getReelSummary(reelFolder);

  return {
    ok: true,
    clipType: 'talking',
    reelName: reelFolder.name,
    reel,
    boxPath: `/reels/${reelFolder.name}/facecam/facecam.mp4`,
    uploadedFile: miniItem(uploadedVideo),
    manifestFile: miniItem(manifest),
    transcriptStatus,
    transcriptPreview: transcriptText.slice(0, 280),
    transcriptError: transcriptStatus === 'failed' ? transcriptJson.error : null,
  };
}

async function saveBrollClip({ file, durationSeconds, createdAt, cleanupPaths, reelName }) {
  const box = await createBoxClient();
  const reelsFolder = await box.getReelsFolder();
  const reelFolder = reelName
    ? await box.getReelFolderByName(reelsFolder.id, reelName)
    : await box.getLatestOrCreateReelFolder(reelsFolder.id);
  const brollFolder = await box.ensureFolder(reelFolder.id, 'broll');
  const clipFolder = await box.createNextClipFolder(brollFolder.id);
  const uploadedVideo = await box.uploadFileOrVersion(clipFolder.id, 'clip.mp4', file.path, file.mimetype);

  const workDir = path.join(WORK_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cleanupPaths.push(workDir);
  await fs.mkdir(workDir, { recursive: true });

  const storyboard = await createTinyStoryboard(file.path, workDir);
  let metadata;

  try {
    metadata = await tagBrollWithOpenAI({
      storyboardPath: storyboard.path,
      storyboardBytes: storyboard.bytes,
      durationSeconds,
      createdAt,
      boxFileId: uploadedVideo.id,
      boxPath: `/reels/${reelFolder.name}/broll/${clipFolder.name}/clip.mp4`,
    });
  } catch (error) {
    metadata = fallbackBrollMetadata({
      error,
      durationSeconds,
      createdAt,
      boxFileId: uploadedVideo.id,
      boxPath: `/reels/${reelFolder.name}/broll/${clipFolder.name}/clip.mp4`,
      storyboardBytes: storyboard.bytes,
    });
  }

  const metadataFile = await box.uploadJsonOrVersion(clipFolder.id, 'metadata.json', metadata);
  const manifest = await box.upsertManifest(reelFolder.id, (currentManifest) => {
    const nextManifest = baseManifest(currentManifest, reelFolder.name);
    const nextClip = {
      clip_id: clipFolder.name,
      file_id: uploadedVideo.id,
      file_name: uploadedVideo.name,
      metadata_file_id: metadataFile.id,
      path: `/reels/${reelFolder.name}/broll/${clipFolder.name}/clip.mp4`,
      metadata_path: `/reels/${reelFolder.name}/broll/${clipFolder.name}/metadata.json`,
      tagging_status: metadata.tagging_status || 'complete',
      summary: metadata.summary,
      tags: [
        ...metadata.setting,
        ...metadata.subjects,
        ...metadata.actions,
        ...metadata.visual_style,
      ],
      duration_seconds: durationSeconds,
      uploaded_at: new Date().toISOString(),
    };

    const existingIndex = nextManifest.broll.findIndex((clip) => clip.clip_id === clipFolder.name);
    if (existingIndex >= 0) {
      nextManifest.broll[existingIndex] = nextClip;
    } else {
      nextManifest.broll.push(nextClip);
    }

    return nextManifest;
  });
  const reel = await box.getReelSummary(reelFolder);

  return {
    ok: true,
    clipType: 'broll',
    reelName: reelFolder.name,
    reel,
    clipName: clipFolder.name,
    boxPath: `/reels/${reelFolder.name}/broll/${clipFolder.name}/clip.mp4`,
    uploadedFile: miniItem(uploadedVideo),
    metadataFile: miniItem(metadataFile),
    manifestFile: miniItem(manifest),
    metadata,
  };
}

async function createBoxClient() {
  assertBoxConfig();
  const accessToken = await getBoxAccessToken();

  async function boxFetch(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Box API ${response.status}: ${parseBoxError(body)}`);
    }

    return response;
  }

  async function listFolderItems(folderId) {
    const url = new URL(`${BOX_API_BASE}/folders/${folderId}/items`);
    url.searchParams.set('fields', 'id,type,name');
    url.searchParams.set('limit', '1000');

    const response = await boxFetch(url);
    const payload = await response.json();

    return payload.entries || [];
  }

  async function findChild(parentFolderId, name, type) {
    const items = await listFolderItems(parentFolderId);
    return items.find((item) => item.type === type && item.name === name) || null;
  }

  async function ensureFolder(parentFolderId, name) {
    const existingFolder = await findChild(parentFolderId, name, 'folder');
    if (existingFolder) {
      return existingFolder;
    }

    const response = await boxFetch(`${BOX_API_BASE}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, parent: { id: parentFolderId } }),
    });

    return response.json();
  }

  async function createNextReelFolder(reelsFolderId) {
    const items = await listFolderItems(reelsFolderId);
    const nextIndex = nextNumericIndex(items, /^reel_(\d+)$/);
    const reelFolder = await ensureFolder(reelsFolderId, `reel_${String(nextIndex).padStart(3, '0')}`);
    await ensureFolder(reelFolder.id, 'facecam');
    await ensureFolder(reelFolder.id, 'broll');

    return reelFolder;
  }

  async function getReelFolderByName(reelsFolderId, reelName) {
    const reelFolder = await findChild(reelsFolderId, reelName, 'folder');

    if (!reelFolder || !/^reel_\d+$/.test(reelFolder.name)) {
      throw new Error(`Reel not found: ${reelName}`);
    }

    await ensureFolder(reelFolder.id, 'facecam');
    await ensureFolder(reelFolder.id, 'broll');

    return reelFolder;
  }

  async function getLatestOrCreateReelFolder(reelsFolderId) {
    const items = await listFolderItems(reelsFolderId);
    const reelFolders = items
      .filter((item) => item.type === 'folder' && /^reel_\d+$/.test(item.name))
      .sort((left, right) => left.name.localeCompare(right.name));

    if (reelFolders.length > 0) {
      return reelFolders[reelFolders.length - 1];
    }

    return createNextReelFolder(reelsFolderId);
  }

  async function listReels(reelsFolderId) {
    const items = await listFolderItems(reelsFolderId);
    const reelFolders = items
      .filter((item) => item.type === 'folder' && /^reel_\d+$/.test(item.name))
      .sort((left, right) => right.name.localeCompare(left.name));

    return Promise.all(reelFolders.map((reelFolder) => getReelSummary(reelFolder)));
  }

  async function getReelSummary(reelFolder) {
    const reelItems = await listFolderItems(reelFolder.id);
    const facecamFolder = reelItems.find((item) => item.type === 'folder' && item.name === 'facecam') || null;
    const brollFolder = reelItems.find((item) => item.type === 'folder' && item.name === 'broll') || null;
    const manifestFile = reelItems.find((item) => item.type === 'file' && item.name === 'reel_manifest.json') || null;
    let hasFacecam = false;
    let brollCount = 0;

    if (facecamFolder) {
      const facecamItems = await listFolderItems(facecamFolder.id);
      hasFacecam = facecamItems.some((item) => item.type === 'file' && item.name === 'facecam.mp4');
    }

    if (brollFolder) {
      const brollItems = await listFolderItems(brollFolder.id);
      brollCount = brollItems.filter((item) => item.type === 'folder' && /^clip_\d+$/.test(item.name)).length;
    }

    return {
      id: reelFolder.id,
      type: reelFolder.type,
      name: reelFolder.name,
      path: `/reels/${reelFolder.name}`,
      hasFacecam,
      brollCount,
      manifestFileId: manifestFile?.id || null,
    };
  }

  async function createNextClipFolder(brollFolderId) {
    const items = await listFolderItems(brollFolderId);
    const nextIndex = nextNumericIndex(items, /^clip_(\d+)$/);

    return ensureFolder(brollFolderId, `clip_${String(nextIndex).padStart(3, '0')}`);
  }

  async function getReelsFolder() {
    if (process.env.BOX_REELS_FOLDER_ID) {
      return {
        id: process.env.BOX_REELS_FOLDER_ID,
        type: 'folder',
        name: 'reels',
      };
    }

    const rootFolderId =
      process.env.BOX_REELS_ROOT_FOLDER_ID ||
      process.env.BOX_RAW_FOLDER_ID ||
      process.env.BOX_OUTPUT_FOLDER_ID;

    return ensureFolder(rootFolderId, 'reels');
  }

  async function uploadFileOrVersion(folderId, name, filePath, mimeType = 'application/octet-stream') {
    const existingFile = await findChild(folderId, name, 'file');
    const bytes = await fs.readFile(filePath);

    if (existingFile) {
      return uploadBufferVersion(existingFile.id, name, bytes, mimeType);
    }

    return uploadBuffer(folderId, name, bytes, mimeType);
  }

  async function uploadTextIfMissing(folderId, name, text, mimeType) {
    const existingFile = await findChild(folderId, name, 'file');
    if (existingFile) {
      return existingFile;
    }

    return uploadBuffer(folderId, name, Buffer.from(text), mimeType);
  }

  async function uploadJsonIfMissing(folderId, name, data) {
    const existingFile = await findChild(folderId, name, 'file');
    if (existingFile) {
      return existingFile;
    }

    return uploadJson(folderId, name, data);
  }

  async function uploadJsonOrVersion(folderId, name, data) {
    const existingFile = await findChild(folderId, name, 'file');
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);

    if (existingFile) {
      return uploadBufferVersion(existingFile.id, name, bytes, 'application/json');
    }

    return uploadBuffer(folderId, name, bytes, 'application/json');
  }

  async function uploadJson(folderId, name, data) {
    return uploadBuffer(folderId, name, Buffer.from(`${JSON.stringify(data, null, 2)}\n`), 'application/json');
  }

  async function uploadBuffer(folderId, name, bytes, mimeType) {
    const formData = new FormData();
    formData.append('attributes', JSON.stringify({ name, parent: { id: folderId } }));
    formData.append('file', new Blob([bytes], { type: mimeType }), name);

    const response = await boxFetch(`${BOX_UPLOAD_BASE}/files/content`, {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();

    return payload.entries?.[0] || payload;
  }

  async function uploadBufferVersion(fileId, name, bytes, mimeType) {
    const formData = new FormData();
    formData.append('attributes', JSON.stringify({ name }));
    formData.append('file', new Blob([bytes], { type: mimeType }), name);

    const response = await boxFetch(`${BOX_UPLOAD_BASE}/files/${fileId}/content`, {
      method: 'POST',
      body: formData,
    });
    const payload = await response.json();

    return payload.entries?.[0] || payload;
  }

  async function downloadJsonFile(fileId) {
    const response = await boxFetch(`${BOX_API_BASE}/files/${fileId}/content`);
    const text = await response.text();

    return JSON.parse(text);
  }

  async function downloadFile(fileId, destPath) {
    const response = await boxFetch(`${BOX_API_BASE}/files/${fileId}/content`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(destPath, buffer);
    return { path: destPath, bytes: buffer.length };
  }

  async function upsertManifest(reelFolderId, updater) {
    const existingManifestFile = await findChild(reelFolderId, 'reel_manifest.json', 'file');
    const existingManifest = existingManifestFile
      ? await downloadJsonFile(existingManifestFile.id).catch(() => null)
      : null;
    const nextManifest = updater(existingManifest);

    return uploadJsonOrVersion(reelFolderId, 'reel_manifest.json', nextManifest);
  }

  async function downloadManifest(reelFolderId) {
    const existingManifestFile = await findChild(reelFolderId, 'reel_manifest.json', 'file');
    if (!existingManifestFile) return null;
    return downloadJsonFile(existingManifestFile.id).catch(() => null);
  }

  async function uploadTextOrVersion(folderId, name, text, mimeType = 'text/plain') {
    const existingFile = await findChild(folderId, name, 'file');
    const bytes = Buffer.from(text);

    if (existingFile) {
      return uploadBufferVersion(existingFile.id, name, bytes, mimeType);
    }

    return uploadBuffer(folderId, name, bytes, mimeType);
  }

  return {
    createNextClipFolder,
    createNextReelFolder,
    downloadFile,
    downloadManifest,
    ensureFolder,
    getLatestOrCreateReelFolder,
    getReelFolderByName,
    getReelSummary,
    getReelsFolder,
    listReels,
    uploadFileOrVersion,
    uploadJsonIfMissing,
    uploadJsonOrVersion,
    uploadTextIfMissing,
    uploadTextOrVersion,
    upsertManifest,
  };
}

async function getBoxAccessToken() {
  if (process.env.BOX_DEVELOPER_TOKEN) {
    return process.env.BOX_DEVELOPER_TOKEN;
  }

  const now = Date.now();
  if (boxTokenCache && boxTokenCache.expiresAt > now + 60_000) {
    return boxTokenCache.accessToken;
  }

  const boxSubjectType = process.env.BOX_SUBJECT_TYPE || 'enterprise';
  const boxSubjectId = process.env.BOX_SUBJECT_ID || process.env.BOX_ENTERPRISE_ID;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.BOX_CLIENT_ID,
    client_secret: process.env.BOX_CLIENT_SECRET,
    box_subject_type: boxSubjectType,
    box_subject_id: boxSubjectId,
  });

  const response = await fetch('https://api.box.com/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`Box auth failed: ${payload?.error_description || payload?.error || response.status}`);
  }

  boxTokenCache = {
    accessToken: payload.access_token,
    expiresAt: now + Math.max(60, Number(payload.expires_in || 3600) - 60) * 1000,
  };

  return boxTokenCache.accessToken;
}

async function createTinyStoryboard(videoPath, workDir) {
  const storyboardPath = path.join(workDir, 'storyboard.jpg');
  const filter = 'fps=1/2,scale=256:-2,tile=3x2:padding=6:margin=6:color=black';

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-vf',
      filter,
      '-frames:v',
      '1',
      '-q:v',
      '10',
      storyboardPath,
    ]);
  } catch {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=512:-2',
      '-q:v',
      '10',
      storyboardPath,
    ]);
  }

  const stats = await fs.stat(storyboardPath);

  return {
    path: storyboardPath,
    bytes: stats.size,
  };
}

async function tagBrollWithOpenAI({
  storyboardPath,
  storyboardBytes,
  durationSeconds,
  createdAt,
  boxFileId,
  boxPath,
}) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing.');
  }

  const storyboardBase64 = await fs.readFile(storyboardPath, 'base64');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text:
                'Tag this b-roll video for later automated reel assembly. The image is a tiny 3x2 storyboard contact sheet sampled from the video. Infer only from what is visible. Return concise searchable metadata. If uncertain, use empty arrays and lower confidence.',
            },
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${storyboardBase64}`,
              detail: 'low',
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'broll_metadata',
          strict: true,
          schema: brollMetadataSchema(),
        },
      },
    }),
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(`OpenAI tagging failed: ${payload?.error?.message || response.status}`);
  }

  const parsed = JSON.parse(extractOutputText(payload));

  return {
    schema_version: 1,
    tagging_status: 'complete',
    clip_type: 'broll',
    generated_at: new Date().toISOString(),
    openai_model: OPENAI_MODEL,
    source: {
      original_box_file_id: boxFileId,
      original_box_path: boxPath,
      original_uploaded_to_box: true,
      storyboard_uploaded_to_box: false,
      storyboard_sent_to_openai: true,
      storyboard_bytes: storyboardBytes,
      duration_seconds: durationSeconds,
      recorded_at: createdAt,
    },
    ...parsed,
  };
}

function brollMetadataSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'summary',
      'setting',
      'subjects',
      'actions',
      'visual_style',
      'camera',
      'usable_for',
      'search_text',
      'confidence',
      'notes',
    ],
    properties: {
      summary: {
        type: 'string',
        description: 'One sentence description of what appears to happen in the clip.',
      },
      setting: {
        type: 'array',
        items: { type: 'string' },
        description: 'Environment tags such as kitchen, street, desk, gym, outdoor, indoor.',
      },
      subjects: {
        type: 'array',
        items: { type: 'string' },
        description: 'Visible people, objects, products, props, or landmarks.',
      },
      actions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Visible actions or motion cues.',
      },
      visual_style: {
        type: 'array',
        items: { type: 'string' },
        description: 'Composition, lighting, mood, color, or texture tags.',
      },
      camera: {
        type: 'object',
        additionalProperties: false,
        required: ['shot_type', 'movement', 'angle'],
        properties: {
          shot_type: {
            type: 'string',
            enum: ['wide', 'medium', 'close-up', 'detail', 'mixed', 'unknown'],
          },
          movement: {
            type: 'string',
            enum: ['static', 'pan', 'tilt', 'handheld', 'push-in', 'pull-out', 'mixed', 'unknown'],
          },
          angle: {
            type: 'string',
            enum: ['eye-level', 'high-angle', 'low-angle', 'overhead', 'mixed', 'unknown'],
          },
        },
      },
      usable_for: {
        type: 'array',
        items: { type: 'string' },
        description: 'Narrative uses such as intro, transition, proof, product demo, lifestyle, workspace.',
      },
      search_text: {
        type: 'string',
        description: 'Dense plain text combining useful search terms for retrieval.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
      },
      notes: {
        type: 'string',
        description: 'Short uncertainty notes. Empty string if none.',
      },
    },
  };
}

function fallbackBrollMetadata({ error, durationSeconds, createdAt, boxFileId, boxPath, storyboardBytes }) {
  return {
    schema_version: 1,
    tagging_status: 'error',
    clip_type: 'broll',
    generated_at: new Date().toISOString(),
    openai_model: OPENAI_MODEL,
    source: {
      original_box_file_id: boxFileId,
      original_box_path: boxPath,
      original_uploaded_to_box: true,
      storyboard_uploaded_to_box: false,
      storyboard_sent_to_openai: false,
      storyboard_bytes: storyboardBytes,
      duration_seconds: durationSeconds,
      recorded_at: createdAt,
    },
    summary: 'B-roll clip uploaded, but visual tagging failed.',
    setting: [],
    subjects: [],
    actions: [],
    visual_style: [],
    camera: {
      shot_type: 'unknown',
      movement: 'unknown',
      angle: 'unknown',
    },
    usable_for: [],
    search_text: '',
    confidence: 0,
    notes: getPublicErrorMessage(error),
  };
}

function extractOutputText(payload) {
  if (payload?.output_text) {
    return payload.output_text;
  }

  for (const item of payload?.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) {
        return content.text;
      }
    }
  }

  throw new Error('OpenAI response did not include output text.');
}

function baseManifest(currentManifest, reelName) {
  return {
    schema_version: 1,
    reel_id: reelName,
    updated_at: new Date().toISOString(),
    facecam: currentManifest?.facecam || null,
    broll: Array.isArray(currentManifest?.broll) ? currentManifest.broll : [],
  };
}

function normalizeClipType(value) {
  if (value === 'talking' || value === 'broll') {
    return value;
  }

  throw new Error('clipType must be "talking" or "broll".');
}

function normalizeOptionalReelName(value) {
  if (!value) {
    return '';
  }

  if (typeof value !== 'string' || !/^reel_\d+$/.test(value)) {
    throw new Error('reelName must look like "reel_001".');
  }

  return value;
}

function nextNumericIndex(items, pattern) {
  const maxIndex = items.reduce((max, item) => {
    if (item.type !== 'folder') {
      return max;
    }

    const match = item.name.match(pattern);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

  return maxIndex + 1;
}

function hasBoxConfig() {
  const hasRootFolder = Boolean(
    process.env.BOX_REELS_FOLDER_ID ||
      process.env.BOX_REELS_ROOT_FOLDER_ID ||
      process.env.BOX_RAW_FOLDER_ID ||
      process.env.BOX_OUTPUT_FOLDER_ID
  );
  const hasDeveloperToken = Boolean(process.env.BOX_DEVELOPER_TOKEN);
  const hasClientCredentials = Boolean(
    process.env.BOX_CLIENT_ID &&
      process.env.BOX_CLIENT_SECRET &&
      (process.env.BOX_SUBJECT_ID || process.env.BOX_ENTERPRISE_ID)
  );

  return hasRootFolder && (hasDeveloperToken || hasClientCredentials);
}

function assertBoxConfig() {
  const missing = [];

  if (!process.env.BOX_DEVELOPER_TOKEN) {
    for (const key of ['BOX_CLIENT_ID', 'BOX_CLIENT_SECRET']) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }

    if (!process.env.BOX_SUBJECT_ID && !process.env.BOX_ENTERPRISE_ID) {
      missing.push('BOX_SUBJECT_ID or BOX_ENTERPRISE_ID');
    }
  }

  if (
    !process.env.BOX_REELS_FOLDER_ID &&
    !process.env.BOX_REELS_ROOT_FOLDER_ID &&
    !process.env.BOX_RAW_FOLDER_ID &&
    !process.env.BOX_OUTPUT_FOLDER_ID
  ) {
    missing.push('BOX_REELS_FOLDER_ID or BOX_REELS_ROOT_FOLDER_ID');
  }

  if (missing.length > 0) {
    throw new Error(`Missing server env: ${missing.join(', ')}`);
  }
}

function parseBoxError(body) {
  try {
    const payload = JSON.parse(body);
    return payload.message || payload.code || body;
  } catch {
    return body;
  }
}

function getPublicErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unexpected server error.';
}

function miniItem(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name,
  };
}
