const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { buildRenderPlan, buildSubtitles, _internals } = require('./filter-graph');

const fixturePath = path.join(__dirname, '__fixtures__', 'edit-plan.json');
const plan = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const inputPaths = new Map([
  ['facecam-1', '/tmp/facecam.mp4'],
  ['broll-1', '/tmp/broll1.mp4'],
  ['broll-2', '/tmp/broll2.mp4'],
]);

test('buildRenderPlan: produces ffmpeg args with one -i per unique asset', () => {
  const result = buildRenderPlan(plan, { inputPaths, subtitlePath: '/tmp/captions.ass' });
  const inputArgIndices = result.args
    .map((arg, index) => (arg === '-i' ? index : -1))
    .filter((index) => index >= 0);
  assert.equal(inputArgIndices.length, 3, 'one -i per unique asset');
  assert.deepEqual(
    inputArgIndices.map((i) => result.args[i + 1]),
    ['/tmp/facecam.mp4', '/tmp/broll1.mp4', '/tmp/broll2.mp4'],
  );
});

test('buildRenderPlan: maps [vout] and [aout] when audio exists', () => {
  const result = buildRenderPlan(plan, { inputPaths, subtitlePath: '/tmp/captions.ass' });
  assert.ok(result.args.includes('[vout]'), 'maps [vout]');
  // talking_head with audio: "keep" + playbackRate=1 → synthesized dialogue → audio output
  assert.ok(result.args.includes('[aout]'), 'maps [aout] from talking_head dialogue');
  assert.equal(result.hasAudio, true);
});

test('buildRenderPlan: includes subtitles filter when a path is given', () => {
  const result = buildRenderPlan(plan, { inputPaths, subtitlePath: '/tmp/captions.ass' });
  assert.match(result.filterComplex, /subtitles='/);
});

test('buildRenderPlan: skips subtitles filter when null', () => {
  const result = buildRenderPlan(plan, { inputPaths, subtitlePath: null });
  assert.doesNotMatch(result.filterComplex, /subtitles=/);
  assert.match(result.filterComplex, /\[vout\]/);
});

test('buildRenderPlan: video output is H.264 1080x1920 @ 30fps', () => {
  const result = buildRenderPlan(plan, { inputPaths, subtitlePath: null });
  assert.ok(result.args.includes('libx264'));
  assert.ok(result.args.includes('1080x1920'));
  assert.deepEqual(
    result.args.slice(result.args.indexOf('-r'), result.args.indexOf('-r') + 2),
    ['-r', '30'],
  );
});

test('buildRenderPlan: applies cover-mode crop chain', () => {
  const result = buildRenderPlan(plan, { inputPaths, subtitlePath: null });
  // facecam-1 uses cover mode → must include "force_original_aspect_ratio=increase" then crop=1080:1920
  assert.match(result.filterComplex, /force_original_aspect_ratio=increase/);
  assert.match(result.filterComplex, /crop=1080:1920/);
});

test('buildSubtitles: returns a valid ASS header', () => {
  const ass = buildSubtitles(plan);
  assert.match(ass, /^\[Script Info\]/);
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /PlayResY: 1920/);
  assert.match(ass, /\[V4\+ Styles\]/);
  assert.match(ass, /\[Events\]/);
});

test('buildSubtitles: renders highlight token with secondary color override', () => {
  const ass = buildSubtitles(plan);
  // highlightColor #F7D94C → BGR is 4CD9F7 → &H004CD9F7 (trailing & is optional)
  assert.match(ass, /\\c&H004CD9F7/);
});

test('buildSubtitles: applies uppercase case transform', () => {
  const ass = buildSubtitles(plan);
  assert.match(ass, /HELLO/);
  assert.match(ass, /WORLD/);
});

test('hexToAssColor: converts RGB to ASS BGR with alpha', () => {
  assert.equal(_internals.hexToAssColor('#FF0000'), '&H000000FF');
  assert.equal(_internals.hexToAssColor('#00FF00'), '&H0000FF00');
  assert.equal(_internals.hexToAssColor('#0000FF'), '&H00FF0000');
  assert.equal(_internals.hexToAssColor('#FFFFFF'), '&H00FFFFFF');
});

test('assTime: hh:mm:ss.cc format', () => {
  assert.equal(_internals.assTime(0), '0:00:00.00');
  assert.equal(_internals.assTime(65.42), '0:01:05.42');
  assert.equal(_internals.assTime(3661.5), '1:01:01.50');
});

test('escapeFilterPath: escapes Windows drive colon', () => {
  assert.equal(
    _internals.escapeFilterPath('C:\\Users\\test\\file.ass'),
    'C\\:/Users/test/file.ass',
  );
});
