// Pure JS module: turns a validated EditPlan into FFmpeg args.
// No I/O, no Box, no OpenAI — only string and array manipulation so it stays unit-testable.
//
// Public API:
//   buildRenderPlan(plan, { inputPaths, subtitlePath }) → { inputs, args }
//     - plan         : EditPlan JSON (already validated upstream)
//     - inputPaths   : Map<assetId, localFilePath>  (caller provides downloaded files)
//     - subtitlePath : path to the .ass file (built via buildSubtitles)
//     Returns the full ffmpeg argv (excluding the leading "ffmpeg") and the
//     resolved inputs for logging.
//
//   buildSubtitles(plan) → string  (.ass file content)

const path = require('node:path');

function buildRenderPlan(plan, { inputPaths, subtitlePath }) {
  const assetById = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const videoItems = collectVideoItems(plan);
  const audioItems = collectAudioItems(plan);

  // Each unique asset becomes one ffmpeg -i input. Items that reuse it go
  // through split / asplit so each item has its own labeled stream.
  const inputAssetIds = [...new Set([...videoItems, ...audioItems].map((item) => item.assetId))];
  const inputIndexByAssetId = new Map(inputAssetIds.map((id, index) => [id, index]));

  const filterParts = [];

  // Base canvas: solid black, 1080×1920 @ 30fps (or whatever the plan asks for).
  filterParts.push(
    `color=c=black:s=${plan.output.width}x${plan.output.height}:r=${plan.output.fps}:d=${formatTime(plan.output.durationSec)}[base0]`,
  );

  // Split / asplit one entry per item that reuses an asset.
  const videoStreamByItem = splitInputs(filterParts, videoItems, inputIndexByAssetId, 'v');
  const audioStreamByItem = splitInputs(filterParts, audioItems, inputIndexByAssetId, 'a');

  // For each video item: trim, reset PTS, scale to layout, optional crop, shift to timelineIn.
  const overlayInputs = videoItems.map((item) => {
    const inStream = videoStreamByItem.get(item.itemKey);
    const outStream = `[v_${safeLabel(item.itemKey)}]`;
    const chain = buildVideoItemChain(item.item, assetById.get(item.assetId), inStream, outStream);
    filterParts.push(chain);
    return { item, label: outStream };
  });

  // Sort overlays by zIndex (lower first), then composite onto base.
  overlayInputs.sort((a, b) => a.item.zIndex - b.item.zIndex);
  let currentBase = '[base0]';
  overlayInputs.forEach((entry, index) => {
    const nextBase = index === overlayInputs.length - 1 && !subtitlePath ? '[vout]' : `[base${index + 1}]`;
    const { layout } = entry.item.item;
    const enable = `enable='between(t,${formatTime(entry.item.item.timelineInSec)},${formatTime(entry.item.item.timelineOutSec)})'`;
    const alpha = entry.item.item.opacity < 1 ? `:alpha=1:format=auto` : '';
    filterParts.push(
      `${currentBase}${entry.label}overlay=x=${Math.round(layout.x)}:y=${Math.round(layout.y)}:${enable}${alpha}:eof_action=pass${nextBase}`,
    );
    currentBase = nextBase;
  });

  // If no video items at all, base = output.
  if (overlayInputs.length === 0) {
    filterParts.push(`[base0]null${subtitlePath ? '[premask]' : '[vout]'}`);
    currentBase = subtitlePath ? '[premask]' : '[vout]';
  }

  // Captions: apply ASS subtitle filter as the final video step.
  if (subtitlePath) {
    const escapedPath = escapeFilterPath(subtitlePath);
    filterParts.push(`${currentBase}subtitles='${escapedPath}'[vout]`);
  }

  // Audio: trim, asetpts reset, adelay to timelineIn, volume, fades.
  const audioOutputs = audioItems.map((item) => {
    const inStream = audioStreamByItem.get(item.itemKey);
    const outStream = `[a_${safeLabel(item.itemKey)}]`;
    const chain = buildAudioItemChain(item.item, inStream, outStream);
    filterParts.push(chain);
    return outStream;
  });

  let hasAudio = false;
  if (audioOutputs.length > 0) {
    if (audioOutputs.length === 1) {
      filterParts.push(`${audioOutputs[0]}anull[aout]`);
    } else {
      filterParts.push(
        `${audioOutputs.join('')}amix=inputs=${audioOutputs.length}:duration=longest:dropout_transition=0[aout]`,
      );
    }
    hasAudio = true;
  }

  // Build the argv.
  const args = ['-y'];
  inputAssetIds.forEach((assetId) => {
    const filePath = inputPaths.get(assetId);
    if (!filePath) throw new Error(`Missing input file for assetId=${assetId}`);
    args.push('-i', filePath);
  });
  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[vout]');
  if (hasAudio) {
    args.push('-map', '[aout]');
  }
  args.push(
    '-r', String(plan.output.fps),
    '-s', `${plan.output.width}x${plan.output.height}`,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );
  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  } else {
    args.push('-an');
  }
  args.push('-t', formatTime(plan.output.durationSec));

  return {
    inputs: inputAssetIds.map((id) => ({ assetId: id, path: inputPaths.get(id) })),
    args,
    hasAudio,
    filterComplex: filterParts.join(';'),
  };
}

function collectVideoItems(plan) {
  const result = [];
  plan.tracks.video.forEach((track) => {
    track.items.forEach((item) => {
      result.push({
        track,
        item,
        assetId: item.assetId,
        zIndex: track.zIndex,
        itemKey: `${track.id}__${item.id}`,
      });
    });
  });
  return result;
}

function collectAudioItems(plan) {
  const result = [];
  plan.tracks.audio.forEach((track) => {
    track.items.forEach((item) => {
      result.push({
        track,
        item,
        assetId: item.assetId,
        itemKey: `${track.id}__${item.id}`,
      });
    });
  });
  // Talking-head video items with audio: "keep" feed an implicit dialogue stream.
  plan.tracks.video.forEach((track) => {
    track.items.forEach((item) => {
      const asset = plan.assets.find((a) => a.id === item.assetId);
      if (!asset || asset.kind !== 'talking_head') return;
      if (item.audio === 'mute') return;
      // Synthesize an audio item that mirrors the video timing — exact match by
      // construction (playbackRate must be 1.0 for video audio to survive).
      if (Math.abs(item.playbackRate - 1.0) > 0.001) return;
      result.push({
        track: { id: `${track.id}_audio`, role: 'dialogue' },
        item: {
          id: `${item.id}_audio`,
          assetId: item.assetId,
          sourceInSec: item.sourceInSec,
          sourceOutSec: item.sourceOutSec,
          timelineInSec: item.timelineInSec,
          timelineOutSec: item.timelineOutSec,
          volumeDb: 0,
          fadeInSec: 0,
          fadeOutSec: 0,
        },
        assetId: item.assetId,
        itemKey: `${track.id}_audio__${item.id}_audio`,
      });
    });
  });
  return result;
}

function splitInputs(filterParts, items, inputIndexByAssetId, kind) {
  const usagesByAsset = new Map();
  items.forEach((entry) => {
    const list = usagesByAsset.get(entry.assetId) || [];
    list.push(entry.itemKey);
    usagesByAsset.set(entry.assetId, list);
  });

  const streamByItem = new Map();
  for (const [assetId, itemKeys] of usagesByAsset.entries()) {
    const inputIndex = inputIndexByAssetId.get(assetId);
    const sourceLabel = `[${inputIndex}:${kind}]`;
    if (itemKeys.length === 1) {
      streamByItem.set(itemKeys[0], sourceLabel);
      continue;
    }
    const splitFilter = kind === 'v' ? 'split' : 'asplit';
    const outLabels = itemKeys.map((key) => `[${kind}src_${safeLabel(key)}]`);
    filterParts.push(`${sourceLabel}${splitFilter}=${itemKeys.length}${outLabels.join('')}`);
    itemKeys.forEach((key, index) => streamByItem.set(key, outLabels[index]));
  }
  return streamByItem;
}

function buildVideoItemChain(item, asset, inStream, outStream) {
  const filters = [];
  filters.push(`trim=start=${formatTime(item.sourceInSec)}:end=${formatTime(item.sourceOutSec)}`);
  filters.push('setpts=PTS-STARTPTS');

  // Layout: scale + optional crop. Modes:
  //   cover   → scale-up to fill layout box, crop center
  //   contain → scale-down to fit, transparent pad to layout box (use pad with black bg)
  //   stretch → scale to exact dims
  const lw = Math.round(item.layout.width);
  const lh = Math.round(item.layout.height);
  if (item.layout.crop) {
    const { crop } = item.layout;
    filters.push(`crop=${Math.round(crop.width)}:${Math.round(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)}`);
    filters.push(`scale=${lw}:${lh}`);
  } else if (item.layout.mode === 'cover') {
    filters.push(`scale=${lw}:${lh}:force_original_aspect_ratio=increase`);
    filters.push(`crop=${lw}:${lh}`);
  } else if (item.layout.mode === 'contain') {
    filters.push(`scale=${lw}:${lh}:force_original_aspect_ratio=decrease`);
    filters.push(`pad=${lw}:${lh}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
  } else {
    // stretch
    filters.push(`scale=${lw}:${lh}`);
  }

  if (Math.abs(item.playbackRate - 1.0) > 0.001) {
    filters.push(`setpts=PTS/${item.playbackRate}`);
  }
  if (item.opacity < 1) {
    filters.push(`format=yuva420p,colorchannelmixer=aa=${item.opacity}`);
  }
  // Shift to timelineIn so overlay aligns.
  filters.push(`setpts=PTS+${formatTime(item.timelineInSec)}/TB`);

  return `${inStream}${filters.join(',')}${outStream}`;
}

function buildAudioItemChain(item, inStream, outStream) {
  const filters = [];
  filters.push(`atrim=start=${formatTime(item.sourceInSec)}:end=${formatTime(item.sourceOutSec)}`);
  filters.push('asetpts=PTS-STARTPTS');
  const delayMs = Math.round(item.timelineInSec * 1000);
  if (delayMs > 0) {
    filters.push(`adelay=delays=${delayMs}:all=1`);
  }
  if (Math.abs(item.volumeDb) > 0.001) {
    filters.push(`volume=${item.volumeDb}dB`);
  }
  if (item.fadeInSec > 0.001) {
    filters.push(`afade=t=in:st=${formatTime(item.timelineInSec)}:d=${formatTime(item.fadeInSec)}`);
  }
  if (item.fadeOutSec > 0.001) {
    const fadeStart = item.timelineOutSec - item.fadeOutSec;
    filters.push(`afade=t=out:st=${formatTime(fadeStart)}:d=${formatTime(item.fadeOutSec)}`);
  }
  return `${inStream}${filters.join(',')}${outStream}`;
}

// ----- ASS subtitle generation -----

function buildSubtitles(plan) {
  const stylesById = new Map(plan.styles.captions.map((style) => [style.id, style]));
  const lines = [];

  lines.push('[Script Info]');
  lines.push('ScriptType: v4.00+');
  lines.push(`PlayResX: ${plan.output.width}`);
  lines.push(`PlayResY: ${plan.output.height}`);
  lines.push('WrapStyle: 2');
  lines.push('ScaledBorderAndShadow: yes');
  lines.push('');

  lines.push('[V4+ Styles]');
  lines.push('Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding');
  for (const style of plan.styles.captions) {
    lines.push(`Style: ${assStyleName(style.id)},${formatStyleRow(style, plan.output)}`);
  }
  lines.push('');

  lines.push('[Events]');
  lines.push('Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text');

  plan.tracks.captions.forEach((track) => {
    track.items.forEach((item) => {
      const style = stylesById.get(item.styleId);
      if (!style) return;
      const text = renderCaptionText(item, style);
      lines.push(
        `Dialogue: ${track.zIndex || 0},${assTime(item.timelineInSec)},${assTime(item.timelineOutSec)},${assStyleName(style.id)},,0,0,0,,${text}`,
      );
    });
  });

  return lines.join('\n') + '\n';
}

function formatStyleRow(style, output) {
  const primary = hexToAssColor(style.color);
  const secondary = hexToAssColor(style.highlightColor);
  const outline = hexToAssColor(style.strokeColor);
  const back = hexToAssColor(style.backgroundColor);
  const bold = style.fontWeight === 'bold' || style.fontWeight === 'black' ? -1 : 0;
  const alignment = assAlignment(style.align);

  // Position: ASS Alignment + Margins from the edges. We compute margins from
  // (x, y) interpreting them as the anchor point in PlayRes coordinates.
  // For bottom-anchored (Align 1/2/3) the MarginV is from bottom = output.height - y.
  const marginV = clampInt(output.height - style.y - style.fontSizePx, 0, output.height);
  const marginL = clampInt(style.x, 0, output.width);
  const marginR = clampInt(output.width - style.x - style.maxWidthPx, 0, output.width);

  return [
    style.fontFamily,
    style.fontSizePx,
    primary,
    secondary,
    outline,
    back,
    bold,
    0,
    0,
    0,
    100,
    100,
    0,
    0,
    1,
    style.strokeWidthPx,
    0,
    alignment,
    marginL,
    marginR,
    marginV,
    1,
  ].join(',');
}

function renderCaptionText(item, style) {
  // Apply case transform on a per-token basis so {\\r} resets cleanly.
  const transform = caseTransformer(style.case);
  if (!item.tokens || item.tokens.length === 0) {
    return escapeAssText(transform(item.text));
  }
  // Render tokens in order. Highlight tokens get \\c override to secondary color.
  const parts = item.tokens.map((token, index) => {
    const text = escapeAssText(transform(token.text));
    if (token.highlight) {
      return `{\\c${hexToAssColor(style.highlightColor)}}${text}{\\r}`;
    }
    return text;
  });
  // Tokens are likely whitespace-separated already; join with no extra spaces.
  return parts.join('');
}

function caseTransformer(mode) {
  if (mode === 'upper') return (text) => text.toUpperCase();
  if (mode === 'sentence') {
    return (text) => text.length > 0 ? text[0].toUpperCase() + text.slice(1).toLowerCase() : text;
  }
  return (text) => text;
}

function escapeAssText(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function hexToAssColor(hex) {
  if (!hex) return '&H00FFFFFF';
  const cleaned = hex.replace('#', '').trim();
  if (cleaned.length === 6) {
    const r = cleaned.slice(0, 2);
    const g = cleaned.slice(2, 4);
    const b = cleaned.slice(4, 6);
    return `&H00${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
  }
  if (cleaned.length === 8) {
    const a = cleaned.slice(0, 2);
    const r = cleaned.slice(2, 4);
    const g = cleaned.slice(4, 6);
    const b = cleaned.slice(6, 8);
    return `&H${a.toUpperCase()}${b.toUpperCase()}${g.toUpperCase()}${r.toUpperCase()}`;
  }
  return '&H00FFFFFF';
}

function assAlignment(align) {
  if (align === 'left') return 1;
  if (align === 'right') return 3;
  return 2; // center
}

function assTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const centi = Math.floor((secs - Math.floor(secs)) * 100);
  return `${hours}:${String(mins).padStart(2, '0')}:${String(Math.floor(secs)).padStart(2, '0')}.${String(centi).padStart(2, '0')}`;
}

function assStyleName(id) {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function safeLabel(value) {
  return String(value).replace(/[^A-Za-z0-9_]/g, '_');
}

function formatTime(seconds) {
  return Number(seconds).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function escapeFilterPath(filePath) {
  // FFmpeg's filter graph parser needs Windows paths special-cased: backslashes
  // become forward slashes and the drive colon is escaped (C: → C\:).
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.replace(/:/g, '\\:');
}

module.exports = {
  buildRenderPlan,
  buildSubtitles,
  // exported for tests
  _internals: { buildVideoItemChain, buildAudioItemChain, hexToAssColor, assTime, escapeFilterPath },
};
