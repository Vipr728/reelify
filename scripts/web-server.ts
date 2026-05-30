import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import busboy from 'busboy';
import { transcribe } from '../src/transcribe.js';
import { inferNiche } from '../src/niche.js';
import { findTopCreators } from '../src/creators.js';
import { scrapeCreators } from '../src/scrape.js';
import { quantifyPosts } from '../src/quantify.js';
import { aggregateByCreator } from '../src/aggregate.js';
import { synthesizeRecipe } from '../src/synthesize.js';
import type { CreatorPatternReport } from '../src/types.js';

// Tiny local web app over the Apify pipeline. NOT for prod — no auth, no
// throttling, hits the real OpenAI / Tavily / Apify APIs. The browser uploads
// a talking-head video; we transcribe via Whisper, then stream stage events
// back as newline-delimited JSON.

try {
  (process as { loadEnvFile?: (p: string) => void }).loadEnvFile?.('.env');
} catch {
  /* fine */
}

const PORT = Number(process.env.PORT ?? 5173);
const PUBLIC_DIR = path.resolve('scripts/web');
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB raw mp4 — we strip audio to <1 MB before Whisper

type StageEvent =
  | { stage: 'start'; filename: string; bytes: number }
  | { stage: 'transcribe'; transcript: { text: string; source: string } }
  | { stage: 'niche'; niche: unknown }
  | { stage: 'creators'; creators: unknown }
  | { stage: 'scrape'; posts: unknown }
  | { stage: 'quantify'; features: unknown }
  | { stage: 'aggregate'; patterns: unknown }
  | { stage: 'recipe'; recipe: unknown; saved: { report: string; recipe: string } }
  | { stage: 'log'; message: string }
  | { stage: 'error'; error: string }
  | { stage: 'done' };

async function parseMultipart(
  req: http.IncomingMessage,
): Promise<{ fields: Record<string, string>; videoPath: string | null; filename: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
    const fields: Record<string, string> = {};
    let videoPath: string | null = null;
    let filename = '';
    let bytes = 0;
    let truncated = false;
    const fileWrites: Promise<void>[] = [];

    bb.on('field', (name, val) => {
      fields[name] = val;
    });

    bb.on('file', (name, stream, info) => {
      if (name !== 'video') {
        stream.resume();
        return;
      }
      filename = info.filename || 'upload.mp4';
      const ext = path.extname(filename) || '.mp4';
      const tmp = path.join(
        os.tmpdir(),
        `reelify-upload-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
      );
      videoPath = tmp;
      const ws = fs.createWriteStream(tmp);
      stream.on('data', (c: Buffer) => {
        bytes += c.length;
      });
      stream.on('limit', () => {
        truncated = true;
      });
      fileWrites.push(
        new Promise<void>((res, rej) => {
          ws.on('finish', () => res());
          ws.on('error', rej);
          stream.on('error', rej);
        }),
      );
      stream.pipe(ws);
    });

    bb.on('close', () => {
      Promise.all(fileWrites)
        .then(() => {
          if (truncated) {
            reject(new Error(`upload exceeded ${MAX_UPLOAD_BYTES} bytes`));
            return;
          }
          resolve({ fields, videoPath, filename, bytes });
        })
        .catch(reject);
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

async function handleRun(req: http.IncomingMessage, res: http.ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (e: StageEvent) => {
    if (e.stage === 'error') console.error('[stage:error]', e.error);
    else if (e.stage === 'log') console.log('[log]', e.message);
    else console.log('[stage]', e.stage);
    res.write(JSON.stringify(e) + '\n');
  };

  let parsed: Awaited<ReturnType<typeof parseMultipart>>;
  try {
    parsed = await parseMultipart(req);
  } catch (err) {
    emit({ stage: 'error', error: `upload failed: ${err instanceof Error ? err.message : String(err)}` });
    res.end();
    return;
  }
  if (!parsed.videoPath) {
    emit({ stage: 'error', error: 'no video file in upload (field name must be "video")' });
    res.end();
    return;
  }

  const skipScrape = parsed.fields.skipScrape === 'true';
  const skipQuantify = parsed.fields.skipQuantify === 'true';

  try {
    emit({ stage: 'start', filename: parsed.filename, bytes: parsed.bytes });
    emit({ stage: 'log', message: `extracting audio + Whisper transcribe… (${(parsed.bytes / 1024 / 1024).toFixed(1)} MB upload)` });
    const t = await transcribe({ kind: 'video', filePath: parsed.videoPath });
    emit({ stage: 'transcribe', transcript: t });

    emit({ stage: 'log', message: 'inferring niche…' });
    const niche = await inferNiche(t.text);
    emit({ stage: 'niche', niche });

    emit({ stage: 'log', message: 'finding creators via Tavily…' });
    const creators = await findTopCreators(niche);
    emit({ stage: 'creators', creators });

    if (skipScrape) {
      emit({ stage: 'log', message: 'stopping (skipScrape).' });
      emit({ stage: 'done' });
      res.end();
      return;
    }

    emit({ stage: 'log', message: 'scraping posts via Apify (this takes minutes)…' });
    const posts = await scrapeCreators(creators);
    emit({ stage: 'scrape', posts });

    if (skipQuantify) {
      emit({ stage: 'log', message: 'stopping (skipQuantify).' });
      emit({ stage: 'done' });
      res.end();
      return;
    }

    emit({ stage: 'log', message: `quantifying ${posts.length} videos (ffmpeg + OCR)…` });
    const features = await quantifyPosts(posts, { concurrency: 3 });
    emit({ stage: 'quantify', features });

    emit({ stage: 'log', message: 'aggregating per-creator instructions…' });
    const patterns = aggregateByCreator(creators, posts, features);
    emit({ stage: 'aggregate', patterns });

    const report: CreatorPatternReport = {
      generated_at: new Date().toISOString(),
      source: { script_text: t.text, transcript_source: t.source },
      niche,
      creators,
      posts,
      per_video_features: features,
      per_creator: patterns,
    };

    const hasAnalyzed = patterns.some((p) => p.videos_analyzed > 0);
    let recipe: unknown = null;
    if (hasAnalyzed) {
      emit({ stage: 'log', message: 'synthesizing recipe for editor LLM (GPT)…' });
      recipe = await synthesizeRecipe(report);
      report.recipe = recipe as CreatorPatternReport['recipe'];
    } else {
      emit({ stage: 'log', message: 'skipping recipe synthesis — no analyzable videos.' });
    }

    const outDir = path.resolve('out');
    await fsp.mkdir(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(outDir, `report-${ts}.json`);
    const recipePath = path.join(outDir, `recipe-${ts}.json`);
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
    if (recipe) await fsp.writeFile(recipePath, JSON.stringify(recipe, null, 2));
    emit({ stage: 'log', message: `wrote ${path.relative(process.cwd(), reportPath)}${recipe ? ' + ' + path.relative(process.cwd(), recipePath) : ''}` });

    if (recipe) {
      emit({
        stage: 'recipe',
        recipe,
        saved: { report: reportPath, recipe: recipePath },
      });
    }

    emit({ stage: 'done' });
    res.end();
  } catch (err) {
    emit({ stage: 'error', error: err instanceof Error ? err.stack ?? err.message : String(err) });
    res.end();
  } finally {
    if (parsed.videoPath) await fsp.rm(parsed.videoPath, { force: true }).catch(() => {});
  }
}

const CT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const reqUrl = req.url ?? '/';
  const p = reqUrl === '/' ? '/index.html' : reqUrl.split('?')[0];
  const full = path.join(PUBLIC_DIR, p);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(full);
    res.writeHead(200, { 'Content-Type': CT[path.extname(full)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url ?? '/');
  if (req.method === 'POST' && parsed.pathname === '/api/run') {
    await handleRun(req, res);
    return;
  }
  if (req.method === 'GET') {
    await serveStatic(req, res);
    return;
  }
  res.writeHead(405);
  res.end('method not allowed');
});

function envSummary() {
  const mask = (v: string | undefined) => (v ? `${v.slice(0, 4)}…${v.slice(-3)} (len ${v.length})` : 'UNSET');
  return [
    `  OPENAI_API_KEY: ${mask(process.env.OPENAI_API_KEY)}`,
    `  TAVILY_API_KEY: ${mask(process.env.TAVILY_API_KEY)}`,
    `  APIFY_TOKEN:    ${mask(process.env.APIFY_TOKEN)}`,
    `  APIFY_IG_ACTOR: ${process.env.APIFY_IG_ACTOR ?? '(default apify/instagram-scraper)'}`,
    `  APIFY_POSTS_PER_PROFILE: ${process.env.APIFY_POSTS_PER_PROFILE ?? '(default 10)'}`,
    `  TAVILY_TOP_N: ${process.env.TAVILY_TOP_N ?? '(default 5)'}`,
  ].join('\n');
}

server.listen(PORT, () => {
  console.log(`\nReelify Apify test app: http://localhost:${PORT}\n`);
  console.log('env:\n' + envSummary() + '\n');
});
