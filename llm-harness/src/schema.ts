import { z } from "zod";

const EPSILON = 0.001;

export const AspectRatioSchema = z.enum(["9:16", "1:1", "16:9", "4:5"]);
export const AssetKindSchema = z.enum(["talking_head", "broll", "music", "sfx"]);
export const CaptionCaseSchema = z.enum(["preserve", "sentence", "upper"]);
export const CaptionAnimationSchema = z.enum(["none", "pop", "karaoke"]);
export const LayoutModeSchema = z.enum(["cover", "contain", "stretch"]);

export const RecipeSchema = z
  .object({
    durationSec: z.number(),
    pacing: z.string(),
    pacingPattern: z.string(),
    captions: z.string(),
    broll: z.string(),
    audio: z.string(),
    hook: z.string(),
    summary: z.string(),
    source: z.string().nullable(),
  })
  .strict();

export const ReelContextSchema = z
  .object({
    id: z.string(),
    boxFolderId: z.string().nullable(),
    boxPath: z.string(),
    manifest: z.unknown(),
  })
  .strict();

export const ContextAssetSchema = z
  .object({
    id: z.string(),
    kind: AssetKindSchema,
    uri: z.string(),
    boxFileId: z.string().nullable(),
    boxPath: z.string().nullable(),
    durationSec: z.number(),
    description: z.string(),
    transcript: z.string(),
    metadata: z.unknown(),
  })
  .strict();

export const EditContextSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    reel: ReelContextSchema,
    request: z.string(),
    output: z
      .object({
        aspectRatio: AspectRatioSchema,
        width: z.number(),
        height: z.number(),
        fps: z.number(),
        targetDurationSec: z.number(),
      })
      .strict(),
    assets: z.array(ContextAssetSchema),
    recipe: RecipeSchema,
    style: z
      .object({
        pacing: z.enum(["slow", "medium", "fast"]),
        captionCase: CaptionCaseSchema,
        captionAnimation: CaptionAnimationSchema,
        brollDensity: z.enum(["none", "light", "medium", "heavy"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((context, ctx) => {
    requireNonEmpty(ctx, ["request"], context.request, "request is required");
    requirePositive(ctx, ["output", "width"], context.output.width, "output.width must be positive");
    requirePositive(ctx, ["output", "height"], context.output.height, "output.height must be positive");
    requirePositive(ctx, ["output", "fps"], context.output.fps, "output.fps must be positive");
    requirePositive(
      ctx,
      ["output", "targetDurationSec"],
      context.output.targetDurationSec,
      "output.targetDurationSec must be positive",
    );

    if (context.assets.length === 0) {
      addIssue(ctx, ["assets"], "at least one asset is required");
    }

    const assetIds = new Set<string>();
    context.assets.forEach((asset, index) => {
      requireNonEmpty(ctx, ["assets", index, "id"], asset.id, "asset.id is required");
      requireNonEmpty(ctx, ["assets", index, "uri"], asset.uri, "asset.uri is required");
      requirePositive(ctx, ["assets", index, "durationSec"], asset.durationSec, "asset.durationSec must be positive");
      if (asset.boxFileId !== null) {
        requireNonEmpty(ctx, ["assets", index, "boxFileId"], asset.boxFileId, "boxFileId must not be empty");
      }
      if (assetIds.has(asset.id)) {
        addIssue(ctx, ["assets", index, "id"], `duplicate asset id: ${asset.id}`);
      }
      assetIds.add(asset.id);
    });
  });

export const AssetSchema = z
  .object({
    id: z.string(),
    kind: AssetKindSchema,
    uri: z.string(),
    boxFileId: z.string().nullable(),
    boxPath: z.string().nullable(),
    durationSec: z.number(),
  })
  .strict();

export const CropSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

export const LayoutSchema = z
  .object({
    mode: LayoutModeSchema,
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    crop: CropSchema.nullable(),
  })
  .strict();

export const VideoItemSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    sourceInSec: z.number(),
    sourceOutSec: z.number(),
    timelineInSec: z.number(),
    timelineOutSec: z.number(),
    playbackRate: z.number(),
    opacity: z.number(),
    audio: z.enum(["keep", "mute"]),
    layout: LayoutSchema,
  })
  .strict();

export const AudioItemSchema = z
  .object({
    id: z.string(),
    assetId: z.string(),
    sourceInSec: z.number(),
    sourceOutSec: z.number(),
    timelineInSec: z.number(),
    timelineOutSec: z.number(),
    volumeDb: z.number(),
    fadeInSec: z.number(),
    fadeOutSec: z.number(),
  })
  .strict();

export const CaptionTokenSchema = z
  .object({
    text: z.string(),
    timelineInSec: z.number(),
    timelineOutSec: z.number(),
    highlight: z.boolean(),
  })
  .strict();

export const CaptionItemSchema = z
  .object({
    id: z.string(),
    timelineInSec: z.number(),
    timelineOutSec: z.number(),
    text: z.string(),
    tokens: z.array(CaptionTokenSchema),
    styleId: z.string(),
  })
  .strict();

export const VideoTrackSchema = z
  .object({
    id: z.string(),
    role: z.enum(["main", "overlay"]),
    zIndex: z.number(),
    items: z.array(VideoItemSchema),
  })
  .strict();

export const AudioTrackSchema = z
  .object({
    id: z.string(),
    role: z.enum(["dialogue", "music", "sfx"]),
    items: z.array(AudioItemSchema),
  })
  .strict();

export const CaptionTrackSchema = z
  .object({
    id: z.string(),
    role: z.literal("captions"),
    zIndex: z.number(),
    items: z.array(CaptionItemSchema),
  })
  .strict();

export const CaptionStyleSchema = z
  .object({
    id: z.string(),
    fontFamily: z.string(),
    fontSizePx: z.number(),
    fontWeight: z.enum(["regular", "medium", "bold", "black"]),
    color: z.string(),
    highlightColor: z.string(),
    backgroundColor: z.string(),
    strokeColor: z.string(),
    strokeWidthPx: z.number(),
    x: z.number(),
    y: z.number(),
    maxWidthPx: z.number(),
    align: z.enum(["left", "center", "right"]),
    case: CaptionCaseSchema,
    animation: CaptionAnimationSchema,
  })
  .strict();

export const EditPlanSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    output: z
      .object({
        aspectRatio: AspectRatioSchema,
        width: z.number(),
        height: z.number(),
        fps: z.number(),
        durationSec: z.number(),
      })
      .strict(),
    assets: z.array(AssetSchema),
    styles: z
      .object({
        captions: z.array(CaptionStyleSchema),
      })
      .strict(),
    tracks: z
      .object({
        video: z.array(VideoTrackSchema),
        audio: z.array(AudioTrackSchema),
        captions: z.array(CaptionTrackSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    validateOutput(ctx, plan.output);
    validateAssets(ctx, plan.assets);
    validateStyles(ctx, plan);
    validateTracks(ctx, plan);
  });

export type EditContext = z.infer<typeof EditContextSchema>;
export type EditPlan = z.infer<typeof EditPlanSchema>;
export type VideoItem = z.infer<typeof VideoItemSchema>;
export type AudioItem = z.infer<typeof AudioItemSchema>;
export type CaptionItem = z.infer<typeof CaptionItemSchema>;

export function parseEditContext(input: unknown): EditContext {
  return EditContextSchema.parse(input);
}

export function parseEditPlan(input: unknown): EditPlan {
  return EditPlanSchema.parse(input);
}

export function summarizeEditPlan(plan: EditPlan): string {
  const videoItems = plan.tracks.video.reduce((total, track) => total + track.items.length, 0);
  const audioItems = plan.tracks.audio.reduce((total, track) => total + track.items.length, 0);
  const captionItems = plan.tracks.captions.reduce((total, track) => total + track.items.length, 0);

  return [
    `duration=${plan.output.durationSec}s`,
    `assets=${plan.assets.length}`,
    `videoItems=${videoItems}`,
    `audioItems=${audioItems}`,
    `captionItems=${captionItems}`,
  ].join(" ");
}

export function assertPlanCompatibleWithContext(plan: EditPlan, context: EditContext): void {
  const contextAssets = new Map(context.assets.map((asset) => [asset.id, asset]));
  const errors: string[] = [];

  if (plan.output.aspectRatio !== context.output.aspectRatio) {
    errors.push("plan.output.aspectRatio must match context.output.aspectRatio");
  }
  if (plan.output.width !== context.output.width) {
    errors.push("plan.output.width must match context.output.width");
  }
  if (plan.output.height !== context.output.height) {
    errors.push("plan.output.height must match context.output.height");
  }
  if (plan.output.fps !== context.output.fps) {
    errors.push("plan.output.fps must match context.output.fps");
  }
  if (plan.output.durationSec > context.output.targetDurationSec + EPSILON) {
    errors.push("plan.output.durationSec must be less than or equal to context.output.targetDurationSec");
  }

  for (const asset of plan.assets) {
    const contextAsset = contextAssets.get(asset.id);
    if (!contextAsset) {
      errors.push(`plan asset does not exist in context: ${asset.id}`);
      continue;
    }
    if (asset.kind !== contextAsset.kind) {
      errors.push(`plan asset kind does not match context for ${asset.id}`);
    }
    if (asset.uri !== contextAsset.uri) {
      errors.push(`plan asset uri does not match context for ${asset.id}`);
    }
    if (asset.boxFileId !== contextAsset.boxFileId) {
      errors.push(`plan asset boxFileId does not match context for ${asset.id}`);
    }
    if (asset.boxPath !== contextAsset.boxPath) {
      errors.push(`plan asset boxPath does not match context for ${asset.id}`);
    }
    if (Math.abs(asset.durationSec - contextAsset.durationSec) > EPSILON) {
      errors.push(`plan asset durationSec does not match context for ${asset.id}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Plan is not compatible with input context:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
}

function validateOutput(ctx: z.RefinementCtx, output: EditPlan["output"]): void {
  requirePositive(ctx, ["output", "width"], output.width, "output.width must be positive");
  requirePositive(ctx, ["output", "height"], output.height, "output.height must be positive");
  requirePositive(ctx, ["output", "fps"], output.fps, "output.fps must be positive");
  requirePositive(ctx, ["output", "durationSec"], output.durationSec, "output.durationSec must be positive");
}

function validateAssets(ctx: z.RefinementCtx, assets: EditPlan["assets"]): void {
  if (assets.length === 0) {
    addIssue(ctx, ["assets"], "at least one asset is required");
  }

  const ids = new Set<string>();
  assets.forEach((asset, index) => {
    requireNonEmpty(ctx, ["assets", index, "id"], asset.id, "asset.id is required");
    requireNonEmpty(ctx, ["assets", index, "uri"], asset.uri, "asset.uri is required");
    requirePositive(ctx, ["assets", index, "durationSec"], asset.durationSec, "asset.durationSec must be positive");
    if (asset.boxFileId !== null) {
      requireNonEmpty(ctx, ["assets", index, "boxFileId"], asset.boxFileId, "boxFileId must not be empty");
    }
    if (ids.has(asset.id)) {
      addIssue(ctx, ["assets", index, "id"], `duplicate asset id: ${asset.id}`);
    }
    ids.add(asset.id);
  });
}

function validateStyles(ctx: z.RefinementCtx, plan: EditPlan): void {
  if (plan.styles.captions.length === 0) {
    addIssue(ctx, ["styles", "captions"], "at least one caption style is required");
  }

  const styleIds = new Set<string>();
  plan.styles.captions.forEach((style, index) => {
    requireNonEmpty(ctx, ["styles", "captions", index, "id"], style.id, "caption style id is required");
    requireNonEmpty(
      ctx,
      ["styles", "captions", index, "fontFamily"],
      style.fontFamily,
      "caption style fontFamily is required",
    );
    requirePositive(
      ctx,
      ["styles", "captions", index, "fontSizePx"],
      style.fontSizePx,
      "caption style fontSizePx must be positive",
    );
    requirePositive(
      ctx,
      ["styles", "captions", index, "maxWidthPx"],
      style.maxWidthPx,
      "caption style maxWidthPx must be positive",
    );
    requireNonNegative(
      ctx,
      ["styles", "captions", index, "strokeWidthPx"],
      style.strokeWidthPx,
      "caption style strokeWidthPx must be non-negative",
    );
    if (styleIds.has(style.id)) {
      addIssue(ctx, ["styles", "captions", index, "id"], `duplicate caption style id: ${style.id}`);
    }
    styleIds.add(style.id);
  });
}

function validateTracks(ctx: z.RefinementCtx, plan: EditPlan): void {
  if (plan.tracks.video.length === 0) {
    addIssue(ctx, ["tracks", "video"], "at least one video track is required");
  }
  if (plan.tracks.captions.length === 0) {
    addIssue(ctx, ["tracks", "captions"], "at least one captions track is required");
  }

  const assetById = new Map(plan.assets.map((asset) => [asset.id, asset]));
  const captionStyleIds = new Set(plan.styles.captions.map((style) => style.id));
  const trackIds = new Set<string>();
  const itemIds = new Set<string>();

  plan.tracks.video.forEach((track, trackIndex) => {
    validateTrackId(ctx, ["tracks", "video", trackIndex, "id"], track.id, trackIds);
    validateNoOverlaps(ctx, ["tracks", "video", trackIndex, "items"], track.items);

    track.items.forEach((item, itemIndex) => {
      const path = ["tracks", "video", trackIndex, "items", itemIndex];
      validateItemId(ctx, [...path, "id"], item.id, itemIds);
      validateTimedAssetItem(ctx, path, item, assetById, plan.output.durationSec);
      validatePlaybackDuration(ctx, path, item);
      validateVideoAssetKind(ctx, [...path, "assetId"], item.assetId, assetById);
      validateLayout(ctx, [...path, "layout"], item.layout, plan.output);
      requirePositive(ctx, [...path, "playbackRate"], item.playbackRate, "playbackRate must be positive");
      validateRange(ctx, [...path, "opacity"], item.opacity, 0, 1, "opacity must be between 0 and 1");
    });
  });

  plan.tracks.audio.forEach((track, trackIndex) => {
    validateTrackId(ctx, ["tracks", "audio", trackIndex, "id"], track.id, trackIds);
    validateNoOverlaps(ctx, ["tracks", "audio", trackIndex, "items"], track.items);

    track.items.forEach((item, itemIndex) => {
      const path = ["tracks", "audio", trackIndex, "items", itemIndex];
      validateItemId(ctx, [...path, "id"], item.id, itemIds);
      validateTimedAssetItem(ctx, path, item, assetById, plan.output.durationSec);
      validateMatchedDuration(ctx, path, item);
      validateAudioAssetKind(ctx, [...path, "assetId"], item.assetId, assetById);
      requireNonNegative(ctx, [...path, "fadeInSec"], item.fadeInSec, "fadeInSec must be non-negative");
      requireNonNegative(ctx, [...path, "fadeOutSec"], item.fadeOutSec, "fadeOutSec must be non-negative");
    });
  });

  plan.tracks.captions.forEach((track, trackIndex) => {
    validateTrackId(ctx, ["tracks", "captions", trackIndex, "id"], track.id, trackIds);
    validateNoOverlaps(ctx, ["tracks", "captions", trackIndex, "items"], track.items);

    track.items.forEach((item, itemIndex) => {
      const path = ["tracks", "captions", trackIndex, "items", itemIndex];
      validateItemId(ctx, [...path, "id"], item.id, itemIds);
      validateTimelineWindow(ctx, path, item.timelineInSec, item.timelineOutSec, plan.output.durationSec);
      requireNonEmpty(ctx, [...path, "text"], item.text, "caption text is required");
      if (!captionStyleIds.has(item.styleId)) {
        addIssue(ctx, [...path, "styleId"], `caption style does not exist: ${item.styleId}`);
      }
      validateCaptionTokens(ctx, [...path, "tokens"], item);
    });
  });
}

function validateTimedAssetItem(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  item: VideoItem | AudioItem,
  assetById: Map<string, EditPlan["assets"][number]>,
  outputDurationSec: number,
): void {
  const asset = assetById.get(item.assetId);
  if (!asset) {
    addIssue(ctx, [...path, "assetId"], `asset does not exist: ${item.assetId}`);
    return;
  }

  validateTimelineWindow(ctx, path, item.timelineInSec, item.timelineOutSec, outputDurationSec);
  validateSourceWindow(ctx, path, item.sourceInSec, item.sourceOutSec, asset.durationSec);
}

function validateTimelineWindow(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  timelineInSec: number,
  timelineOutSec: number,
  outputDurationSec: number,
): void {
  requireNonNegative(ctx, [...path, "timelineInSec"], timelineInSec, "timelineInSec must be non-negative");
  if (timelineOutSec <= timelineInSec + EPSILON) {
    addIssue(ctx, [...path, "timelineOutSec"], "timelineOutSec must be greater than timelineInSec");
  }
  if (timelineOutSec > outputDurationSec + EPSILON) {
    addIssue(ctx, [...path, "timelineOutSec"], "timelineOutSec must be within output.durationSec");
  }
}

function validateSourceWindow(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  sourceInSec: number,
  sourceOutSec: number,
  assetDurationSec: number,
): void {
  requireNonNegative(ctx, [...path, "sourceInSec"], sourceInSec, "sourceInSec must be non-negative");
  if (sourceOutSec <= sourceInSec + EPSILON) {
    addIssue(ctx, [...path, "sourceOutSec"], "sourceOutSec must be greater than sourceInSec");
  }
  if (sourceOutSec > assetDurationSec + EPSILON) {
    addIssue(ctx, [...path, "sourceOutSec"], "sourceOutSec must be within asset.durationSec");
  }
}

function validateCaptionTokens(ctx: z.RefinementCtx, path: Array<string | number>, caption: CaptionItem): void {
  let previousOut = caption.timelineInSec;
  caption.tokens.forEach((token, index) => {
    const tokenPath = [...path, index];
    requireNonEmpty(ctx, [...tokenPath, "text"], token.text, "caption token text is required");
    if (token.timelineInSec < caption.timelineInSec - EPSILON) {
      addIssue(ctx, [...tokenPath, "timelineInSec"], "token timelineInSec must be within caption timing");
    }
    if (token.timelineOutSec > caption.timelineOutSec + EPSILON) {
      addIssue(ctx, [...tokenPath, "timelineOutSec"], "token timelineOutSec must be within caption timing");
    }
    if (token.timelineOutSec <= token.timelineInSec + EPSILON) {
      addIssue(ctx, [...tokenPath, "timelineOutSec"], "token timelineOutSec must be greater than timelineInSec");
    }
    if (token.timelineInSec < previousOut - EPSILON) {
      addIssue(ctx, [...tokenPath, "timelineInSec"], "caption tokens must be ordered and non-overlapping");
    }
    previousOut = token.timelineOutSec;
  });
}

function validatePlaybackDuration(ctx: z.RefinementCtx, path: Array<string | number>, item: VideoItem): void {
  if (item.playbackRate <= 0) {
    return;
  }

  const sourceDuration = item.sourceOutSec - item.sourceInSec;
  const timelineDuration = item.timelineOutSec - item.timelineInSec;
  const expectedTimelineDuration = sourceDuration / item.playbackRate;
  if (Math.abs(timelineDuration - expectedTimelineDuration) > 0.05) {
    addIssue(ctx, [...path, "timelineOutSec"], "video timeline duration must match source duration and playbackRate");
  }
}

function validateMatchedDuration(ctx: z.RefinementCtx, path: Array<string | number>, item: AudioItem): void {
  const sourceDuration = item.sourceOutSec - item.sourceInSec;
  const timelineDuration = item.timelineOutSec - item.timelineInSec;
  if (Math.abs(timelineDuration - sourceDuration) > 0.05) {
    addIssue(ctx, [...path, "timelineOutSec"], "audio timeline duration must match source duration");
  }
}

function validateLayout(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  layout: z.infer<typeof LayoutSchema>,
  output: EditPlan["output"],
): void {
  requireNonNegative(ctx, [...path, "x"], layout.x, "layout.x must be non-negative");
  requireNonNegative(ctx, [...path, "y"], layout.y, "layout.y must be non-negative");
  requirePositive(ctx, [...path, "width"], layout.width, "layout.width must be positive");
  requirePositive(ctx, [...path, "height"], layout.height, "layout.height must be positive");
  if (layout.x + layout.width > output.width + EPSILON) {
    addIssue(ctx, [...path, "width"], "layout must fit within output.width");
  }
  if (layout.y + layout.height > output.height + EPSILON) {
    addIssue(ctx, [...path, "height"], "layout must fit within output.height");
  }

  if (layout.crop) {
    requireNonNegative(ctx, [...path, "crop", "x"], layout.crop.x, "crop.x must be non-negative");
    requireNonNegative(ctx, [...path, "crop", "y"], layout.crop.y, "crop.y must be non-negative");
    requirePositive(ctx, [...path, "crop", "width"], layout.crop.width, "crop.width must be positive");
    requirePositive(ctx, [...path, "crop", "height"], layout.crop.height, "crop.height must be positive");
  }
}

function validateVideoAssetKind(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  assetId: string,
  assetById: Map<string, EditPlan["assets"][number]>,
): void {
  const asset = assetById.get(assetId);
  if (asset && asset.kind !== "talking_head" && asset.kind !== "broll") {
    addIssue(ctx, path, `video item asset must be talking_head or broll: ${assetId}`);
  }
}

function validateAudioAssetKind(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  assetId: string,
  assetById: Map<string, EditPlan["assets"][number]>,
): void {
  const asset = assetById.get(assetId);
  if (asset && asset.kind !== "talking_head" && asset.kind !== "music" && asset.kind !== "sfx") {
    addIssue(ctx, path, `audio item asset must be talking_head, music, or sfx: ${assetId}`);
  }
}

function validateNoOverlaps<T extends { timelineInSec: number; timelineOutSec: number }>(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  items: T[],
): void {
  const sorted = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.timelineInSec - b.item.timelineInSec);

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.item.timelineInSec < previous.item.timelineOutSec - EPSILON) {
      addIssue(ctx, [...path, current.index, "timelineInSec"], "items on the same track must not overlap");
    }
  }
}

function validateTrackId(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  id: string,
  trackIds: Set<string>,
): void {
  requireNonEmpty(ctx, path, id, "track id is required");
  if (trackIds.has(id)) {
    addIssue(ctx, path, `duplicate track id: ${id}`);
  }
  trackIds.add(id);
}

function validateItemId(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  id: string,
  itemIds: Set<string>,
): void {
  requireNonEmpty(ctx, path, id, "item id is required");
  if (itemIds.has(id)) {
    addIssue(ctx, path, `duplicate item id: ${id}`);
  }
  itemIds.add(id);
}

function validateRange(
  ctx: z.RefinementCtx,
  path: Array<string | number>,
  value: number,
  min: number,
  max: number,
  message: string,
): void {
  if (value < min || value > max) {
    addIssue(ctx, path, message);
  }
}

function requirePositive(ctx: z.RefinementCtx, path: Array<string | number>, value: number, message: string): void {
  if (value <= 0) {
    addIssue(ctx, path, message);
  }
}

function requireNonNegative(ctx: z.RefinementCtx, path: Array<string | number>, value: number, message: string): void {
  if (value < 0) {
    addIssue(ctx, path, message);
  }
}

function requireNonEmpty(ctx: z.RefinementCtx, path: Array<string | number>, value: string, message: string): void {
  if (value.trim().length === 0) {
    addIssue(ctx, path, message);
  }
}

function addIssue(ctx: z.RefinementCtx, path: Array<string | number>, message: string): void {
  ctx.addIssue({
    code: "custom",
    path,
    message,
  });
}
