import fs from 'node:fs';
import OpenAI from 'openai';
import { loadEnv } from './env.js';

// The user gives us either a script (text) or a talking-head video.
// If it's already text, pass through. If it's a video/audio file, run Whisper.
// We standardize on a single transcript string before the niche step.

export type TranscribeInput =
  | { kind: 'script'; text: string }
  | { kind: 'video'; filePath: string };

export type TranscribeResult = {
  text: string;
  source: 'user-script' | 'user-video-transcribed';
};

export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  if (input.kind === 'script') {
    return { text: input.text.trim(), source: 'user-script' };
  }

  const env = loadEnv();
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  if (!fs.existsSync(input.filePath)) {
    throw new Error(`video file not found: ${input.filePath}`);
  }

  // Whisper-1 is the cheap, reliable ASR. 25MB limit; the app should cap clips.
  const file = fs.createReadStream(input.filePath);
  const res = await client.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'text',
  });

  const text = (typeof res === 'string' ? res : (res as { text: string }).text).trim();
  return { text, source: 'user-video-transcribed' };
}
