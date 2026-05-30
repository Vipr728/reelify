import fs from 'node:fs/promises';
import path from 'node:path';
import { quantifyLocalFile, quantifyPosts } from '../src/quantify.js';
import type { ScrapedPost, VideoFeatures } from '../src/types.js';

// Local quantify test loop. No API keys, no Apify, no OpenAI.
//
//   npm run test:quantify -- --file ./my-reel.mp4          # one local file
//   npm run test:quantify -- --url  https://.../clip.mp4   # one remote URL
//   npm run test:quantify -- --posts fixtures/sample-posts.json
//   npm run test:quantify                                  # picks first .mp4 in ./test-clips/

function parseFlags(argv: string[]) {
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      f[a.slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return f;
}

function summarize(f: VideoFeatures) {
  if (f.skipped) {
    console.log(`  SKIPPED: ${f.skipped}`);
    return;
  }
  console.log(
    `  duration=${f.duration_s.toFixed(1)}s  cuts=${f.cut_count}  cuts/10s=${f.cuts_per_10s.toFixed(2)}` +
      `  avg_scene=${f.avg_scene_duration_s.toFixed(1)}s  longest=${f.longest_scene_s.toFixed(1)}s  short_scenes=${(f.short_scenes_ratio * 100).toFixed(0)}%`,
  );
  console.log(
    `  captions: present=${f.captions.present}  pos=${f.captions.position}` +
      `  size=${f.captions.avg_size_px.toFixed(0)}px  coverage=${(f.captions.coverage_rate * 100).toFixed(0)}%`,
  );
  console.log(
    `  audio: has=${f.audio.has_audio}  pattern=${f.audio.pattern}` +
      `  intro=${f.audio.intro_active}  mid=${f.audio.mid_active}  outro=${f.audio.outro_active}`,
  );
}

async function findDefaultClip(): Promise<string | null> {
  try {
    const dir = path.resolve('test-clips');
    const entries = await fs.readdir(dir);
    const mp4 = entries.find((e) => e.toLowerCase().endsWith('.mp4'));
    return mp4 ? path.join(dir, mp4) : null;
  } catch {
    return null;
  }
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));

  if (flags.posts) {
    const raw = await fs.readFile(flags.posts, 'utf8');
    const posts = JSON.parse(raw) as ScrapedPost[];
    const real = posts.filter((p) => p.video_url && !p.video_url.startsWith('REPLACE_'));
    if (real.length === 0) {
      console.error(
        `no posts with a real video_url. edit ${flags.posts} and replace REPLACE_WITH_... entries first.`,
      );
      process.exit(2);
    }
    console.log(`quantifying ${real.length} post(s)...`);
    const features = await quantifyPosts(real, { concurrency: 2 });
    for (let i = 0; i < real.length; i++) {
      console.log(`\n[${i + 1}] ${real[i].post_url}`);
      summarize(features[i]);
    }
    console.log('\n--- full JSON ---');
    console.log(JSON.stringify(features, null, 2));
    return;
  }

  if (flags.url) {
    const post: ScrapedPost = {
      creator_handle: 'test',
      post_url: flags.url,
      shortcode: 'test',
      video_url: flags.url,
    };
    console.log(`quantifying ${flags.url}...`);
    const [f] = await quantifyPosts([post], { concurrency: 1 });
    summarize(f);
    console.log('\n--- full JSON ---');
    console.log(JSON.stringify(f, null, 2));
    return;
  }

  const file = flags.file || (await findDefaultClip());
  if (!file) {
    console.error(
      'no input. pass one of:\n' +
        '  --file ./my-reel.mp4\n' +
        '  --url  https://.../clip.mp4\n' +
        '  --posts fixtures/sample-posts.json\n' +
        'or drop an mp4 into ./test-clips/',
    );
    process.exit(2);
  }

  try {
    await fs.access(file);
  } catch {
    console.error(`file not found: ${file}`);
    process.exit(2);
  }

  console.log(`quantifying ${file}...`);
  const f = await quantifyLocalFile(file);
  summarize(f);
  console.log('\n--- full JSON ---');
  console.log(JSON.stringify(f, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
