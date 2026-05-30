import { readFile } from 'node:fs/promises';

import { runApifyPipeline } from './pipeline.js';

async function main() {
  const args = process.argv.slice(2);
  const flags = parseFlags(args);
  const script = await readScript(flags);

  if (!script) {
    throw new Error('pipeline:json requires --script, --script-file, or stdin.');
  }

  // Belt-and-suspenders: while the pipeline runs, redirect ANY write to
  // process.stdout into process.stderr. Some deps (tesseract.js progress logs,
  // emscripten printfs, etc.) write to stdout and would mix into our JSON
  // output, which the host parses verbatim. Restore for the final write.
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    return (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  let report;
  try {
    report = await runApifyPipeline(
      { kind: 'script', text: script },
      {
        skipQuantify: flags['skip-quantify'] === true,
        skipSynthesize: flags['skip-synthesize'] === true,
        quantifyConcurrency:
          typeof flags.concurrency === 'string' ? Number(flags.concurrency) : undefined,
      },
    );
  } finally {
    process.stdout.write = realStdoutWrite;
  }

  realStdoutWrite(`${JSON.stringify(report, null, 2)}\n`);
}

function parseFlags(args: string[]) {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      continue;
    }

    const key = arg.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }

  return flags;
}

async function readScript(flags: Record<string, string | boolean>): Promise<string> {
  if (typeof flags.script === 'string') {
    return flags.script.trim();
  }

  if (typeof flags['script-file'] === 'string') {
    return (await readFile(flags['script-file'], 'utf8')).trim();
  }

  if (process.stdin.isTTY) {
    return '';
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8').trim();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
