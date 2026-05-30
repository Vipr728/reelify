import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import OpenAI from 'openai';
import { loadEnv } from './env.js';

// The user gives us either a script (text) or a talking-head video.
// If it's text, pass through. If it's a video, ffmpeg strips the audio down to
// a small mono 16kHz mp3 first — Whisper has a 25MB upload cap, raw mp4s blow
// it, and the audio is all Whisper needs anyway.

export type TranscribeInput =
  | { kind: 'script'; text: string }
  | { kind: 'video'; filePath: string };

export type TranscribeResult = {
  text: string;
  source: 'user-script' | 'user-video-transcribed';
};

function extractAudio(videoPath: string): Promise<string> {
  const out = path.join(
    os.tmpdir(),
    `reelify-whisper-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
  );
  return new Promise((resolve, reject) => {
    const proc = execFile(
      'ffmpeg',
      [
        '-y',
        '-i', videoPath,
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-c:a', 'libmp3lame',
        '-q:a', '9',
        out,
      ],
      { maxBuffer: 1024 * 1024 * 16 },
      (err) => (err ? reject(err) : resolve(out)),
    );
    proc.on('error', reject);
  });
}

export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  if (input.kind === 'script') {
    return { text: input.text.trim(), source: 'user-script' };
  }

  const env = loadEnv();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  if (!fs.existsSync(input.filePath)) {
    throw new Error(`video file not found: ${input.filePath}`);
  }

  const audioPath = await extractAudio(input.filePath);
  try {
    const res = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: 'whisper-1',
      response_format: 'text',
    });
    const text = (typeof res === 'string' ? res : (res as { text: string }).text).trim();
    return { text, source: 'user-video-transcribed' };
  } finally {
    await fs.promises.rm(audioPath, { force: true }).catch(() => {});
  }
}
