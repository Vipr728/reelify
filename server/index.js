const cors = require('cors');
const dotenv = require('dotenv');
const express = require('express');
const multer = require('multer');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

dotenv.config({ quiet: true });

const execFileAsync = promisify(execFile);
const app = express();
const PORT = Number(process.env.REELIFY_SERVER_PORT || 8787);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(__dirname, '.tmp');
const UPLOAD_DIR = path.join(TMP_ROOT, 'uploads');
const WORK_DIR = path.join(TMP_ROOT, 'work');
const PLAN_WORK_DIR = path.join(WORK_DIR, 'plans');
const APIFY_INTEGRATION_DIR = path.join(PROJECT_ROOT, 'apify-integration');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const BOX_API_BASE = 'https://api.box.com/2.0';
const BOX_UPLOAD_BASE = 'https://upload.box.com/api/2.0';
const OPENAI_MODEL = process.env.OPENAI_BROLL_MODEL || 'gpt-4.1-mini';
const APIFY_QUANTIFY_CONCURRENCY = Number(process.env.APIFY_QUANTIFY_CONCURRENCY || 3);

fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
fsSync.mkdirSync(WORK_DIR, { recursive: true });
fsSync.mkdirSync(PLAN_WORK_DIR, { recursive: true });

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
    apifyConfigured: Boolean(process.env.OPENAI_API_KEY && process.env.TAVILY_API_KEY && process.env.APIFY_TOKEN),
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
    const transcriptText = normalizeOptionalText(request.body.transcriptText);
    const transcriptJson = parseOptionalJson(request.body.transcriptJson);

    const result =
      clipType === 'talking'
        ? await saveFacecamClip({ file: request.file, durationSeconds, createdAt, reelName, transcriptText, transcriptJson })
        : await saveBrollClip({ file: request.file, durationSeconds, createdAt, cleanupPaths, reelName });

    response.json(result);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  } finally {
    await Promise.all(cleanupPaths.map((targetPath) => fs.rm(targetPath, { recursive: true, force: true })));
  }
});

app.post('/api/reels/:reelName/edit-plan', async (request, response) => {
  try {
    const reelName = normalizeRequiredReelName(request.params.reelName);
    const result = await generateReelEditPlan({ reelName });

    response.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: getPublicErrorMessage(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Reelify upload server listening on http://localhost:${PORT}`);
});

async function saveFacecamClip({ file, durationSeconds, createdAt, reelName, transcriptText, transcriptJson }) {
  const box = await createBoxClient();
  const reelsFolder = await box.getReelsFolder();
  const reelFolder = reelName
    ? await box.getReelFolderByName(reelsFolder.id, reelName)
    : await box.createNextReelFolder(reelsFolder.id);
  const facecamFolder = await box.ensureFolder(reelFolder.id, 'facecam');
  await box.ensureFolder(reelFolder.id, 'broll');

  const uploadedVideo = await box.uploadFileOrVersion(facecamFolder.id, 'facecam.mp4', file.path, file.mimetype);
  const transcript = transcriptText
    ? transcriptFromRequest({ transcriptText, transcriptJson, createdAt, durationSeconds })
    : await transcribeFacecamVideo({ filePath: file.path, createdAt, durationSeconds });

  const transcriptTextFile = await box.uploadTextOrVersion(
    facecamFolder.id,
    'transcript.txt',
    `${transcript.text || 'Transcript unavailable.'}\n`,
    'text/plain'
  );
  const transcriptJsonFile = await box.uploadJsonOrVersion(facecamFolder.id, 'transcript.json', transcript.json);

  const manifest = await box.upsertManifest(reelFolder.id, (currentManifest) => ({
    ...baseManifest(currentManifest, reelFolder.name),
    facecam: {
      file_id: uploadedVideo.id,
      file_name: uploadedVideo.name,
      path: `/reels/${reelFolder.name}/facecam/facecam.mp4`,
      duration_seconds: durationSeconds,
      transcript_text_file_id: transcriptTextFile.id,
      transcript_json_file_id: transcriptJsonFile.id,
      transcript_status: transcript.json.status,
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
    transcriptTextFile: miniItem(transcriptTextFile),
    transcriptJsonFile: miniItem(transcriptJsonFile),
    transcriptStatus: transcript.json.status,
    manifestFile: miniItem(manifest),
  };
}

function transcriptFromRequest({ transcriptText, transcriptJson, createdAt, durationSeconds }) {
  const text = transcriptText.trim();
  const json = {
    status: 'complete',
    source: 'client-provided',
    text,
    segments: [],
    words: [],
    created_at: createdAt,
    duration_seconds: durationSeconds,
    ...(transcriptJson && typeof transcriptJson === 'object' ? transcriptJson : {}),
  };

  return { text, json };
}

async function transcribeFacecamVideo({ filePath, createdAt, durationSeconds }) {
  if (!process.env.OPENAI_API_KEY) {
    return pendingTranscript({
      status: 'pending',
      reason: 'OPENAI_API_KEY is missing.',
      createdAt,
      durationSeconds,
    });
  }

  const audioPath = path.join(WORK_DIR, `facecam-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);

  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      filePath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '9',
      audioPath,
    ]);

    const audioBytes = await fs.readFile(audioPath);
    const formData = new FormData();
    formData.append('file', new Blob([audioBytes], { type: 'audio/mpeg' }), 'facecam-audio.mp3');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'segment');
    formData.append('timestamp_granularities[]', 'word');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error?.message || `OpenAI transcription failed: ${response.status}`);
    }

    const text = String(payload?.text || '').trim();
    return {
      text,
      json: {
        status: text ? 'complete' : 'empty',
        source: 'openai-whisper',
        model: 'whisper-1',
        text,
        language: payload?.language || null,
        duration_seconds: durationSeconds,
        created_at: createdAt,
        transcribed_at: new Date().toISOString(),
        segments: Array.isArray(payload?.segments) ? payload.segments : [],
        words: Array.isArray(payload?.words) ? payload.words : [],
      },
    };
  } catch (error) {
    return pendingTranscript({
      status: 'error',
      reason: getPublicErrorMessage(error),
      createdAt,
      durationSeconds,
    });
  } finally {
    await fs.rm(audioPath, { force: true }).catch(() => {});
  }
}

function pendingTranscript({ status, reason, createdAt, durationSeconds }) {
  return {
    text: '',
    json: {
      status,
      reason,
      source: 'server',
      text: '',
      segments: [],
      words: [],
      created_at: createdAt,
      duration_seconds: durationSeconds,
    },
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

async function generateReelEditPlan({ reelName }) {
  const planStartedAt = Date.now();
  logPlan(reelName, 'start', 'received edit-plan request');
  assertPipelineConfig();

  logPlan(reelName, 'box', 'creating Box client and resolving reel folder');
  const box = await createBoxClient();
  const reelsFolder = await box.getReelsFolder();
  const reelFolder = await box.getReelFolderByName(reelsFolder.id, reelName);
  logPlan(reelName, 'box', `resolved reel folder ${reelFolder.name} (${reelFolder.id}) under reels folder ${reelsFolder.id}`);

  logPlan(reelName, 'transcript', 'loading facecam transcript from Box');
  const transcriptText = await readFacecamTranscriptText(box, reelFolder);
  logPlan(reelName, 'transcript', `loaded transcript (${transcriptText.length} chars)`);

  const runId = `${reelName}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = path.join(PLAN_WORK_DIR, runId);
  await fs.mkdir(runDir, { recursive: true });
  logPlan(reelName, 'debug', `run artifacts will be written to ${runDir}`);

  const transcriptPath = path.join(runDir, `script.${reelName}.txt`);
  await fs.writeFile(transcriptPath, transcriptText, 'utf8');
  logPlan(reelName, 'debug', `wrote script file ${transcriptPath}`);

  const apifyInput = {
    kind: 'script',
    text: transcriptText,
    scriptFile: transcriptPath,
    options: {
      quantifyConcurrency: Number.isFinite(APIFY_QUANTIFY_CONCURRENCY) ? APIFY_QUANTIFY_CONCURRENCY : 3,
    },
  };
  await debugLogPayload(runDir, '01-apify-input', apifyInput);

  logPlan(
    reelName,
    'apify',
    `starting creator pipeline (script chars=${transcriptText.length}, concurrency=${apifyInput.options.quantifyConcurrency})`,
  );
  const apifyReport = await runApifyPipelineForTranscript(transcriptPath);
  logPlan(reelName, 'apify', `finished creator pipeline: ${summarizeApifyReport(apifyReport)}`);
  await debugLogPayload(runDir, '02-apify-output-report', apifyReport);
  if (!apifyReport?.recipe) {
    throw new Error('Apify pipeline did not produce a recipe. Check creator scrape and quantify results.');
  }
  logPlan(reelName, 'apify', `recipe ready: ${summarizeRecipe(apifyReport.recipe)}`);
  await debugLogPayload(runDir, '03-apify-output-recipe', apifyReport.recipe);

  const apifyReportPath = path.join(runDir, `apify-report.${reelName}.json`);
  const apifyRecipePath = path.join(runDir, `apify-recipe.${reelName}.json`);
  const contextPath = path.join(runDir, `context.${reelName}.json`);
  const editPlanPath = path.join(runDir, `edit-plan.${reelName}.json`);

  await writeJsonFile(apifyReportPath, apifyReport);
  await writeJsonFile(apifyRecipePath, apifyReport.recipe);
  logPlan(reelName, 'files', `wrote local Apify report and recipe JSON`);

  logPlan(reelName, 'box', 'ensuring reel output folders in Box');
  const outputFolders = await ensureReelOutputFolders(box, reelFolder.id);
  logPlan(
    reelName,
    'box',
    `output folders ready: apify=${outputFolders.apify.id}, llm=${outputFolders.llm.id}, instructions=${outputFolders.editingInstructions.id}`,
  );

  logPlan(reelName, 'box', 'uploading Apify report and recipe to Box');
  const apifyReportFile = await box.uploadFileOrVersion(
    outputFolders.apify.id,
    `apify-report.${reelName}.json`,
    apifyReportPath,
    'application/json'
  );
  const apifyRecipeFile = await box.uploadFileOrVersion(
    outputFolders.apify.id,
    `apify-recipe.${reelName}.json`,
    apifyRecipePath,
    'application/json'
  );
  logPlan(reelName, 'box', `uploaded Apify files: report=${apifyReportFile.id}, recipe=${apifyRecipeFile.id}`);

  logPlan(reelName, 'llm-context', 'building llm-harness context from Box assets + Apify recipe');
  await runLocalCommand('npm', [
    'run',
    'llm:context:box',
    '--',
    '--reel',
    reelName,
    '--recipe',
    apifyRecipePath,
    '--output',
    contextPath,
  ], { cwd: PROJECT_ROOT, label: 'llm:context:box', streamStdout: true });

  const contextJson = JSON.parse(await fs.readFile(contextPath, 'utf8'));
  logPlan(reelName, 'llm-context', `context built: ${summarizeContext(contextJson)}`);
  await debugLogPayload(runDir, '04-llm-harness-input-context', {
    command: 'npm run llm:context:box',
    recipeFile: apifyRecipePath,
    context: contextJson,
  });

  logPlan(reelName, 'box', 'uploading llm-harness context to Box');
  const contextFile = await box.uploadFileOrVersion(
    outputFolders.llm.id,
    `context.${reelName}.json`,
    contextPath,
    'application/json'
  );
  logPlan(reelName, 'box', `uploaded llm context ${contextFile.id}`);

  logPlan(reelName, 'llm-plan', 'generating final edit-plan JSON with llm-harness');
  await runLocalCommand('npm', [
    'run',
    'llm:plan',
    '--',
    '--input',
    contextPath,
    '--output',
    editPlanPath,
    '--no-box-upload',
  ], { cwd: PROJECT_ROOT, label: 'llm:plan', streamStdout: true });

  const editPlan = JSON.parse(await fs.readFile(editPlanPath, 'utf8'));
  const editPlanSummary = summarizeEditPlan(editPlan);
  logPlan(reelName, 'llm-plan', `edit plan generated: ${formatSummary(editPlanSummary)}`);
  await debugLogPayload(runDir, '05-llm-harness-output-edit-plan', {
    command: 'npm run llm:plan',
    inputFile: contextPath,
    outputFile: editPlanPath,
    editPlan,
  });
  logPlan(reelName, 'box', 'uploading final edit-plan JSON to Box');
  const editPlanFile = await box.uploadFileOrVersion(
    outputFolders.editingInstructions.id,
    `edit-plan.${reelName}.json`,
    editPlanPath,
    'application/json'
  );
  logPlan(reelName, 'box', `uploaded edit plan ${editPlanFile.id}`);

  logPlan(reelName, 'manifest', 'updating reel manifest with latest edit-plan file IDs');
  const manifestFile = await box.upsertManifest(reelFolder.id, (currentManifest) => {
    const nextManifest = baseManifest(currentManifest, reelFolder.name);
    return {
      ...nextManifest,
      outputs: {
        ...(nextManifest.outputs || {}),
        latest_edit_plan: {
          status: 'complete',
          generated_at: new Date().toISOString(),
          apify_report_file_id: apifyReportFile.id,
          apify_recipe_file_id: apifyRecipeFile.id,
          llm_context_file_id: contextFile.id,
          edit_plan_file_id: editPlanFile.id,
          edit_plan_path: `/reels/${reelFolder.name}/outputs/editing instructions/edit-plan.${reelName}.json`,
        },
      },
    };
  });
  const reel = await box.getReelSummary(reelFolder);
  logPlan(reelName, 'done', `completed in ${formatDurationMs(Date.now() - planStartedAt)}`);

  return {
    reelName,
    reel,
    transcriptChars: transcriptText.length,
    apify: {
      niche: apifyReport.niche,
      creators: apifyReport.creators?.length || 0,
      posts: apifyReport.posts?.length || 0,
      analyzedVideos: (apifyReport.per_creator || []).reduce((total, creator) => total + (creator.videos_analyzed || 0), 0),
    },
    files: {
      apifyReport: miniItem(apifyReportFile),
      apifyRecipe: miniItem(apifyRecipeFile),
      context: miniItem(contextFile),
      editPlan: miniItem(editPlanFile),
      manifest: miniItem(manifestFile),
    },
    debugDir: runDir,
    editPlan: editPlanSummary,
  };
}

async function readFacecamTranscriptText(box, reelFolder) {
  const reelItems = await box.listFolderItems(reelFolder.id);
  const facecamFolder = reelItems.find((item) => item.type === 'folder' && item.name === 'facecam');
  if (!facecamFolder) {
    throw new Error(`Missing facecam folder for ${reelFolder.name}.`);
  }

  const facecamItems = await box.listFolderItems(facecamFolder.id);
  const transcriptTextFile = facecamItems.find((item) => item.type === 'file' && item.name === 'transcript.txt');
  const transcriptJsonFile = facecamItems.find((item) => item.type === 'file' && item.name === 'transcript.json');
  const transcriptText = transcriptTextFile ? await box.downloadTextFile(transcriptTextFile.id) : '';

  if (isUsableTranscript(transcriptText)) {
    return transcriptText.trim();
  }

  const transcriptJson = transcriptJsonFile ? await box.downloadJsonFile(transcriptJsonFile.id).catch(() => null) : null;
  const jsonText = typeof transcriptJson?.text === 'string' ? transcriptJson.text : '';
  if (isUsableTranscript(jsonText)) {
    return jsonText.trim();
  }

  const status = transcriptJson?.status ? ` status=${transcriptJson.status}` : '';
  const reason = transcriptJson?.reason ? ` reason=${transcriptJson.reason}` : '';
  throw new Error(`Facecam transcript is not ready for ${reelFolder.name}.${status}${reason}`);
}

async function runApifyPipelineForTranscript(transcriptPath) {
  const concurrency = Number.isFinite(APIFY_QUANTIFY_CONCURRENCY) ? APIFY_QUANTIFY_CONCURRENCY : 3;
  const { stdout } = await runLocalCommand('npm', [
    'run',
    '--silent',
    'pipeline:json',
    '--',
    '--script-file',
    transcriptPath,
    '--concurrency',
    String(concurrency),
  ], { cwd: APIFY_INTEGRATION_DIR, label: 'apify:pipeline', streamStdout: false });

  return parseJsonFromCommandStdout(stdout);
}

async function ensureReelOutputFolders(box, reelFolderId) {
  const outputs = await box.ensureFolder(reelFolderId, 'outputs');
  const apify = await box.ensureFolder(outputs.id, 'apify');
  const llm = await box.ensureFolder(outputs.id, 'llm-harness');
  const editingInstructions = await box.ensureFolder(outputs.id, 'editing instructions');

  return { outputs, apify, llm, editingInstructions };
}

async function runLocalCommand(command, args, { cwd, label = command, streamStdout = false }) {
  const startedAt = Date.now();
  const renderedCommand = `${command} ${args.join(' ')}`;
  console.log(`[reelify:command:${label}] start ${renderedCommand} (cwd=${cwd})`);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk);
      if (streamStdout) {
        process.stdout.write(prefixLines(`[reelify:command:${label}:stdout] `, chunk.toString()));
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      process.stderr.write(prefixLines(`[reelify:command:${label}:stderr] `, chunk.toString()));
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const elapsed = formatDurationMs(Date.now() - startedAt);

      if (code === 0) {
        console.log(`[reelify:command:${label}] done in ${elapsed}`);
        resolve({ stdout, stderr });
        return;
      }

      const exitLabel = signal ? `signal ${signal}` : `exit ${code}`;
      reject(
        new Error(
          [
            `${renderedCommand} failed (${exitLabel}) after ${elapsed}.`,
            stderr ? `stderr tail:\n${tail(stderr, 4000)}` : '',
            stdout ? `stdout tail:\n${tail(stdout, 4000)}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
      );
    });
  });
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function parseJsonFromCommandStdout(stdout) {
  const text = stdout.trim();
  if (!text) {
    throw new Error('Expected JSON on stdout, but command produced no stdout.');
  }

  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }

    throw new Error(`Expected JSON on stdout, but got:\n${text.slice(0, 1000)}`);
  }
}

async function debugLogPayload(runDir, label, payload) {
  const filePath = path.join(runDir, `${label}.json`);
  await writeJsonFile(filePath, payload);
  console.log(`\n[reelify:pipeline] ${label} saved to ${filePath}`);
  console.log(`[reelify:pipeline] ${label} BEGIN`);
  console.log(JSON.stringify(payload, null, 2));
  console.log(`[reelify:pipeline] ${label} END\n`);
}

function logPlan(reelName, stage, message) {
  console.log(`[reelify:plan:${reelName}:${stage}] ${new Date().toISOString()} ${message}`);
}

function summarizeApifyReport(report) {
  const perCreator = Array.isArray(report?.per_creator) ? report.per_creator : [];
  const analyzedVideos = perCreator.reduce((total, creator) => total + (creator.videos_analyzed || 0), 0);
  return [
    `niche=${report?.niche?.label || 'unknown'}`,
    `creators=${report?.creators?.length || 0}`,
    `posts=${report?.posts?.length || 0}`,
    `features=${report?.per_video_features?.length || 0}`,
    `analyzedVideos=${analyzedVideos}`,
  ].join(' ');
}

function summarizeRecipe(recipe) {
  if (!recipe) {
    return 'missing';
  }

  return [
    `duration=${recipe.target_duration_s ?? recipe.durationSec ?? 'unknown'}s`,
    `cuts=${recipe.pacing?.total_cuts ?? 'unknown'}`,
    `captions=${recipe.captions?.present ?? 'unknown'}`,
    `broll=${recipe.broll?.count ?? 'unknown'}`,
    `music=${recipe.audio?.music ?? 'unknown'}`,
  ].join(' ');
}

function summarizeContext(context) {
  const assets = Array.isArray(context?.assets) ? context.assets : [];
  const brollCount = assets.filter((asset) => asset.kind === 'broll').length;
  const transcriptChars = assets
    .filter((asset) => asset.kind === 'talking_head')
    .reduce((total, asset) => total + String(asset.transcript || '').length, 0);

  return [
    `reel=${context?.reel?.id || 'unknown'}`,
    `assets=${assets.length}`,
    `broll=${brollCount}`,
    `transcriptChars=${transcriptChars}`,
    `target=${context?.output?.targetDurationSec || 'unknown'}s`,
  ].join(' ');
}

function formatSummary(summary) {
  return Object.entries(summary)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function formatDurationMs(ms) {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  return `${(ms / 1000).toFixed(1)}s`;
}

function prefixLines(prefix, text) {
  return text
    .split(/(\r?\n)/)
    .map((part) => (part === '\n' || part === '\r\n' || part === '' ? part : `${prefix}${part}`))
    .join('');
}

function tail(text, maxChars) {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function summarizeEditPlan(editPlan) {
  const videoItems = editPlan.tracks?.video?.reduce((total, track) => total + (track.items?.length || 0), 0) || 0;
  const audioItems = editPlan.tracks?.audio?.reduce((total, track) => total + (track.items?.length || 0), 0) || 0;
  const captionItems = editPlan.tracks?.captions?.reduce((total, track) => total + (track.items?.length || 0), 0) || 0;

  return {
    durationSec: editPlan.output?.durationSec || 0,
    assets: editPlan.assets?.length || 0,
    videoItems,
    audioItems,
    captionItems,
  };
}

function isUsableTranscript(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    return false;
  }

  return !/^Transcript (pending|unavailable)\.?$/i.test(text);
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

  async function uploadTextOrVersion(folderId, name, text, mimeType) {
    const existingFile = await findChild(folderId, name, 'file');
    const bytes = Buffer.from(text);

    if (existingFile) {
      return uploadBufferVersion(existingFile.id, name, bytes, mimeType);
    }

    return uploadBuffer(folderId, name, bytes, mimeType);
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

  async function downloadTextFile(fileId) {
    const response = await boxFetch(`${BOX_API_BASE}/files/${fileId}/content`);
    return response.text();
  }

  async function upsertManifest(reelFolderId, updater) {
    const existingManifestFile = await findChild(reelFolderId, 'reel_manifest.json', 'file');
    const existingManifest = existingManifestFile
      ? await downloadJsonFile(existingManifestFile.id).catch(() => null)
      : null;
    const nextManifest = updater(existingManifest);

    return uploadJsonOrVersion(reelFolderId, 'reel_manifest.json', nextManifest);
  }

  return {
    createNextClipFolder,
    createNextReelFolder,
    downloadJsonFile,
    downloadTextFile,
    ensureFolder,
    findChild,
    getLatestOrCreateReelFolder,
    getReelFolderByName,
    getReelSummary,
    getReelsFolder,
    listFolderItems,
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
    outputs: currentManifest?.outputs || null,
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

function normalizeRequiredReelName(value) {
  if (typeof value !== 'string' || !/^reel_\d+$/.test(value)) {
    throw new Error('reelName must look like "reel_001".');
  }

  return value;
}

function normalizeOptionalText(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function parseOptionalJson(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    return value;
  }

  if (typeof value !== 'string') {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

function assertPipelineConfig() {
  assertBoxConfig();

  const missing = [];
  for (const key of ['OPENAI_API_KEY', 'TAVILY_API_KEY', 'APIFY_TOKEN']) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing edit-plan pipeline env: ${missing.join(', ')}`);
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
