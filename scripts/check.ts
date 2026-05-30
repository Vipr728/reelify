import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Load .env if present.
try {
  (process as { loadEnvFile?: (p: string) => void }).loadEnvFile?.('.env');
} catch {
  /* fine */
}

const exec = promisify(execFile);

const REQUIRED_ENV = ['OPENAI_API_KEY', 'TAVILY_API_KEY', 'APIFY_TOKEN'] as const;
const OPTIONAL_ENV = ['APIFY_IG_PROFILE_ACTOR', 'APIFY_POSTS_PER_PROFILE', 'TAVILY_TOP_N'] as const;

function mask(v: string | undefined): string {
  if (!v) return '(unset)';
  if (v.length < 10) return '***';
  return `${v.slice(0, 4)}…${v.slice(-3)} (len ${v.length})`;
}

async function tool(bin: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await exec(bin, ['-version']);
    return (stdout || stderr).split('\n')[0];
  } catch {
    return null;
  }
}

async function tmpWritable(): Promise<boolean> {
  const p = path.join(os.tmpdir(), `reelify-check-${Date.now()}.txt`);
  try {
    await fs.writeFile(p, 'ok');
    await fs.rm(p);
    return true;
  } catch {
    return false;
  }
}

function row(ok: boolean, label: string, detail: string) {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label.padEnd(30)} ${detail}`);
}

(async () => {
  let pass = true;

  console.log('\n--- env ---');
  for (const k of REQUIRED_ENV) {
    const v = process.env[k];
    row(!!v, k, mask(v));
    if (!v) pass = false;
  }
  for (const k of OPTIONAL_ENV) {
    row(true, k, process.env[k] ?? '(default)');
  }

  console.log('\n--- tools ---');
  const ffmpeg = await tool('ffmpeg');
  row(!!ffmpeg, 'ffmpeg', ffmpeg ?? 'not on PATH — `brew install ffmpeg`');
  if (!ffmpeg) pass = false;
  const ffprobe = await tool('ffprobe');
  row(!!ffprobe, 'ffprobe', ffprobe ?? 'not on PATH (bundled with ffmpeg)');
  if (!ffprobe) pass = false;

  console.log('\n--- fs ---');
  const w = await tmpWritable();
  row(w, 'tmp dir', `${os.tmpdir()}${w ? '' : ' (not writable)'}`);
  if (!w) pass = false;

  console.log('\n--- fixtures ---');
  const fixDir = path.resolve('fixtures');
  let fixOk = true;
  for (const f of ['sample-script.txt', 'sample-niche.json', 'sample-creators.json', 'sample-posts.json', 'sample-report.json']) {
    try {
      await fs.access(path.join(fixDir, f));
      row(true, f, 'present');
    } catch {
      row(false, f, 'missing');
      fixOk = false;
    }
  }
  if (!fixOk) pass = false;

  console.log('');
  console.log(pass ? 'ready. try: npm run test:aggregate' : 'fix items above before running the pipeline');
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
