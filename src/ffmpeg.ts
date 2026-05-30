import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Thin wrappers around system ffmpeg / ffprobe. Both must be on PATH.
// (See README — `brew install ffmpeg` on mac.)

// ffmpeg writes status info to stderr and exits 0 on success. When it does fail,
// the rejection carries `stderr` — we grab that for parsing too.
async function runFfmpeg(args: string[]): Promise<string> {
  try {
    const { stderr } = await exec('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64 });
    return stderr;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    if (e.stderr) return e.stderr;
    throw err;
  }
}

async function runFfprobe(args: string[]): Promise<string> {
  const { stdout } = await exec('ffprobe', args, { maxBuffer: 1024 * 1024 * 16 });
  return stdout;
}

export async function getDuration(file: string): Promise<number> {
  const out = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'json',
    file,
  ]);
  const dur = parseFloat(JSON.parse(out).format?.duration ?? '0');
  if (!Number.isFinite(dur) || dur <= 0) throw new Error(`bad duration for ${file}`);
  return dur;
}

export async function getDimensions(file: string): Promise<{ w: number; h: number }> {
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    file,
  ]);
  const s = JSON.parse(out).streams?.[0];
  if (!s?.width || !s?.height) throw new Error(`no video stream in ${file}`);
  return { w: s.width, h: s.height };
}

export async function hasAudioStream(file: string): Promise<boolean> {
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type',
    '-of', 'json',
    file,
  ]);
  return !!JSON.parse(out).streams?.length;
}

// Scene-cut timestamps via ffmpeg's `scene` filter.
// threshold ~ 0.3 catches hard cuts; lower picks up softer transitions too.
export async function detectCutTimes(file: string, threshold = 0.3): Promise<number[]> {
  const stderr = await runFfmpeg([
    '-i', file,
    '-filter:v', `select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ]);
  const times: number[] = [];
  for (const line of stderr.split('\n')) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (m) times.push(parseFloat(m[1]));
  }
  return times;
}

// Silence intervals via `silencedetect`.
// noise: dB below which we call it silence. d: minimum silence duration to report.
export async function detectSilenceIntervals(
  file: string,
  noiseDb = -30,
  minDurS = 0.4,
): Promise<{ start: number; end: number }[]> {
  const stderr = await runFfmpeg([
    '-i', file,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDurS}`,
    '-f', 'null', '-',
  ]);
  const intervals: { start: number; end: number }[] = [];
  let curStart: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = line.match(/silence_start:\s*([\d.]+)/);
    if (s) {
      curStart = parseFloat(s[1]);
      continue;
    }
    const e = line.match(/silence_end:\s*([\d.]+)/);
    if (e && curStart !== null) {
      intervals.push({ start: curStart, end: parseFloat(e[1]) });
      curStart = null;
    }
  }
  return intervals;
}

export async function extractFrame(file: string, atSeconds: number, outPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-ss', String(atSeconds),
    '-i', file,
    '-frames:v', '1',
    '-q:v', '2',
    outPath,
  ]);
}
