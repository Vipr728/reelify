const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const OpenAI = require('openai');

const execFileAsync = promisify(execFile);

const WHISPER_MODEL = process.env.OPENAI_WHISPER_MODEL || 'whisper-1';

async function extractAudio(videoPath, workDir) {
  const audioPath = path.join(workDir, `audio-${Date.now()}.mp3`);
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libmp3lame',
      '-q:a', '9',
      audioPath,
    ],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  return audioPath;
}

async function transcribeVideo({ videoPath, workDir }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  if (!fs.existsSync(videoPath)) {
    throw new Error(`video file not found: ${videoPath}`);
  }

  await fsPromises.mkdir(workDir, { recursive: true });
  const audioPath = await extractAudio(videoPath, workDir);

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const startedAt = Date.now();
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: WHISPER_MODEL,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment', 'word'],
    });
    const elapsedMs = Date.now() - startedAt;

    const segments = Array.isArray(response.segments)
      ? response.segments.map((segment) => ({
          id: segment.id,
          start: segment.start,
          end: segment.end,
          text: segment.text,
        }))
      : [];
    const words = Array.isArray(response.words)
      ? response.words.map((word) => ({
          start: word.start,
          end: word.end,
          word: word.word,
        }))
      : [];

    return {
      text: (response.text || '').trim(),
      segments,
      words,
      language: response.language || null,
      duration: typeof response.duration === 'number' ? response.duration : null,
      model: WHISPER_MODEL,
      elapsedMs,
    };
  } finally {
    await fsPromises.rm(audioPath, { force: true }).catch(() => {});
  }
}

module.exports = { transcribeVideo, extractAudio };
