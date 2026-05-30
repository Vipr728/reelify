import fs from 'node:fs';
import path from 'node:path';
import { transcribe } from './transcribe.js';
import { inferNiche } from './niche.js';
import { findTopCreators } from './creators.js';
import { scrapeCreators } from './scrape.js';
import { quantifyPosts } from './quantify.js';
import { aggregateByCreator } from './aggregate.js';
import { synthesizeRecipe } from './synthesize.js';
import { runApifyPipeline } from './pipeline.js';

// Usage:
//   tsx src/cli.ts                              # full pipeline, script from stdin
//   tsx src/cli.ts --script "..."               # full pipeline from a flag
//   tsx src/cli.ts --video clip.mp4             # transcribe a video first
//   tsx src/cli.ts --skip-quantify              # stop after scrape (fast)
//   tsx src/cli.ts transcribe path/to/clip.mp4
//   tsx src/cli.ts niche "transcript here"
//   tsx src/cli.ts creators '<niche-json>'
//   tsx src/cli.ts scrape '<creators-json>'
//   tsx src/cli.ts quantify '<posts-json>'
//   tsx src/cli.ts aggregate '<report-json-with-features>'

const OUT_DIR = path.resolve('out');

function writeOut(name: string, data: unknown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `${name}-${ts}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function parseFlags(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

async function readJsonArg(rest: string[]): Promise<unknown> {
  const raw = rest.join(' ').trim() || (await readStdin());
  if (!raw) throw new Error('no JSON input — pass as arg or pipe to stdin');
  return JSON.parse(raw);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (!cmd || cmd.startsWith('--')) {
    const flags = parseFlags(process.argv.slice(2));
    const input = flags.video
      ? ({ kind: 'video' as const, filePath: String(flags.video) })
      : ({
          kind: 'script' as const,
          text: typeof flags.script === 'string' ? flags.script : await readStdin(),
        });

    if (input.kind === 'script' && !input.text) {
      console.error('no script provided. use --script "..." | --video <path> | pipe stdin');
      process.exit(2);
    }

    const report = await runApifyPipeline(input, {
      skipQuantify: flags['skip-quantify'] === true,
      skipSynthesize: flags['skip-synthesize'] === true,
      quantifyConcurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
    });
    const out = writeOut('report', report);
    console.error(`wrote ${out}`);
    if (report.recipe) {
      const recipeOut = writeOut('recipe', report.recipe);
      console.error(`wrote ${recipeOut}`);
    }
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (cmd === 'transcribe') {
    const filePath = rest[0];
    if (!filePath) throw new Error('usage: transcribe <video-file>');
    console.log(JSON.stringify(await transcribe({ kind: 'video', filePath }), null, 2));
    return;
  }
  if (cmd === 'niche') {
    const text = rest.join(' ').trim() || (await readStdin());
    if (!text) throw new Error('usage: niche "<transcript>"');
    console.log(JSON.stringify(await inferNiche(text), null, 2));
    return;
  }
  if (cmd === 'creators') {
    const niche = (await readJsonArg(rest)) as Parameters<typeof findTopCreators>[0];
    console.log(JSON.stringify(await findTopCreators(niche), null, 2));
    return;
  }
  if (cmd === 'scrape') {
    const creators = (await readJsonArg(rest)) as Parameters<typeof scrapeCreators>[0];
    console.log(JSON.stringify(await scrapeCreators(creators), null, 2));
    return;
  }
  if (cmd === 'quantify') {
    const posts = (await readJsonArg(rest)) as Parameters<typeof quantifyPosts>[0];
    console.log(JSON.stringify(await quantifyPosts(posts), null, 2));
    return;
  }
  if (cmd === 'aggregate') {
    const report = (await readJsonArg(rest)) as {
      creators: Parameters<typeof aggregateByCreator>[0];
      posts: Parameters<typeof aggregateByCreator>[1];
      per_video_features: Parameters<typeof aggregateByCreator>[2];
    };
    if (!report?.per_video_features) {
      throw new Error('aggregate: report must include per_video_features (run quantify first)');
    }
    console.log(
      JSON.stringify(
        aggregateByCreator(report.creators, report.posts, report.per_video_features),
        null,
        2,
      ),
    );
    return;
  }
  if (cmd === 'synthesize') {
    const report = (await readJsonArg(rest)) as Parameters<typeof synthesizeRecipe>[0];
    if (!report?.per_creator) {
      throw new Error('synthesize: report must include per_creator (run aggregate first)');
    }
    console.log(JSON.stringify(await synthesizeRecipe(report), null, 2));
    return;
  }

  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
