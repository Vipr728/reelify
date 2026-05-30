import fs from 'node:fs';
import path from 'node:path';
import { aggregateByCreator } from '../src/aggregate.js';
import type { CreatorPatternReport } from '../src/types.js';

// Runs aggregate against a saved report. No APIs, no ffmpeg.
//
//   npm run test:aggregate                           # uses fixtures/sample-report.json
//   npm run test:aggregate -- path/to/report.json    # any saved report with per_video_features

const arg = process.argv[2] || 'fixtures/sample-report.json';
const full = path.resolve(arg);

if (!fs.existsSync(full)) {
  console.error(`not found: ${full}`);
  process.exit(2);
}

const report = JSON.parse(fs.readFileSync(full, 'utf8')) as CreatorPatternReport;
if (!report.per_video_features) {
  console.error(`report at ${full} has no per_video_features. run quantify first.`);
  process.exit(2);
}

const patterns = aggregateByCreator(report.creators, report.posts, report.per_video_features);

console.log('--- per-creator instructions (what the harness reads) ---\n');
for (const p of patterns) {
  console.log(`@${p.creator.handle}  (${p.videos_analyzed} videos analyzed)`);
  console.log(p.instructions);
  console.log('');
}

console.log('--- full JSON ---');
console.log(JSON.stringify(patterns, null, 2));
