import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { createBoxClientFromEnv } from "./box-client";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import {
  assertPlanCompatibleWithContext,
  EditContextSchema,
  EditPlan,
  EditPlanObjectSchema,
  EditPlanSchema,
  summarizeEditPlan,
} from "./schema";

// Must match EPSILON in schema.ts.
const TRIM_EPSILON = 0.001; // Must match EPSILON in schema.ts.
const MIN_TOKEN_DURATION = 0.02; // Minimum slice for a salvaged degenerate token (> TRIM_EPSILON).

// The model's caption timings are imperfect: cues derived from the full
// transcript can run past output.durationSec (the cut), and individual tokens
// can be zero-duration, out of order, or out of the caption window. The retry
// loop does not reliably correct these, so deterministically sanitize captions
// to satisfy the schema's caption rules:
//   - drop cues that start at/after the cut; clamp cue ends to the cut
//   - keep tokens ordered, non-overlapping, within the cue, and positive-length
//   - drop tokens that genuinely cannot fit before the cue ends
function sanitizeCaptions(plan: EditPlan): EditPlan {
  const duration = plan.output.durationSec;
  for (const track of plan.tracks.captions) {
    track.items = track.items
      .filter((item) => item.timelineInSec < duration - TRIM_EPSILON)
      .map((item) => {
        const captionIn = Math.max(0, item.timelineInSec);
        const captionOut = Math.min(item.timelineOutSec, duration);
        return { ...item, timelineInSec: captionIn, timelineOutSec: captionOut, tokens: item.tokens };
      })
      .filter((item) => item.timelineOutSec > item.timelineInSec + TRIM_EPSILON)
      .map((item) => ({ ...item, tokens: sanitizeTokens(item) }));
  }
  return plan;
}

// The model often emits video/audio items whose timeline length does not match
// their source window (and playbackRate, for video). The timeline windows drive
// video coverage, so they must be preserved: instead reconcile the SOURCE window
// (and video playbackRate) to the timeline, clamped to the asset's real duration.
function reconcileTrackDurations(plan: EditPlan): EditPlan {
  const assetDuration = new Map(plan.assets.map((asset) => [asset.id, asset.durationSec]));

  for (const track of plan.tracks.video) {
    for (const item of track.items) {
      const timelineDuration = item.timelineOutSec - item.timelineInSec;
      if (timelineDuration <= 0) continue;
      const rate = item.playbackRate > 0 ? item.playbackRate : 1;
      const maxSource = assetDuration.get(item.assetId) ?? Infinity;
      const sourceOut = Math.min(item.sourceInSec + timelineDuration * rate, maxSource);
      const sourceDuration = sourceOut - item.sourceInSec;
      if (sourceDuration <= 0) continue;
      item.sourceOutSec = sourceOut;
      // Keep timelineDuration === sourceDuration / playbackRate exact after any clamp.
      item.playbackRate = sourceDuration / timelineDuration;
    }
  }

  for (const track of plan.tracks.audio) {
    for (const item of track.items) {
      const timelineDuration = item.timelineOutSec - item.timelineInSec;
      if (timelineDuration <= 0) continue;
      const maxSource = assetDuration.get(item.assetId) ?? Infinity;
      const sourceOut = Math.min(item.sourceInSec + timelineDuration, maxSource);
      const sourceDuration = sourceOut - item.sourceInSec;
      if (sourceDuration <= 0) continue;
      item.sourceOutSec = sourceOut;
      // Audio has no playbackRate: match the timeline to the (possibly clamped)
      // source. This only ever shortens the item, so it cannot create overlaps.
      item.timelineOutSec = item.timelineInSec + sourceDuration;
    }
  }

  return plan;
}

function sanitizeTokens(caption: EditPlan["tracks"]["captions"][number]["items"][number]) {
  const captionIn = caption.timelineInSec;
  const captionOut = caption.timelineOutSec;
  const tokens: typeof caption.tokens = [];
  let previousOut = captionIn;
  for (const token of caption.tokens) {
    const timelineInSec = Math.min(Math.max(token.timelineInSec, previousOut), captionOut);
    let timelineOutSec = Math.min(token.timelineOutSec, captionOut);
    if (timelineOutSec < timelineInSec + MIN_TOKEN_DURATION) {
      timelineOutSec = Math.min(timelineInSec + MIN_TOKEN_DURATION, captionOut);
    }
    if (timelineOutSec <= timelineInSec + TRIM_EPSILON) {
      continue; // no room left before the cue ends; drop this token
    }
    tokens.push({ ...token, timelineInSec, timelineOutSec });
    previousOut = timelineOutSec;
  }
  return tokens;
}

type CliOptions = {
  inputPath: string;
  outputPath: string;
  model: string;
  uploadToBox: boolean;
};

const DEFAULT_INPUT = "llm-harness/fixtures/context.example.json";
const DEFAULT_OUTPUT = "llm-harness/out/edit-plan.json";
const DEFAULT_MODEL = "gpt-4o-2024-08-06";
const MAX_ATTEMPTS = 3;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const inputJson = JSON.parse(await readFile(options.inputPath, "utf8"));
  const context = EditContextSchema.parse(inputJson);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate an edit plan.");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let previousError: string | undefined;
  let plan = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await client.responses.parse({
      model: options.model,
      input: [
        {
          role: "system",
          content: SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: buildPromptForAttempt(context, previousError),
        },
      ],
      text: {
        format: zodTextFormat(EditPlanObjectSchema, "edit_plan"),
      },
    });

    if (!response.output_parsed) {
      previousError = "OpenAI returned no parsed edit plan.";
      continue;
    }

    try {
      const repaired = reconcileTrackDurations(sanitizeCaptions(response.output_parsed as EditPlan));
      const parsedPlan = EditPlanSchema.parse(repaired);
      assertPlanCompatibleWithContext(parsedPlan, context);
      plan = parsedPlan;
      break;
    } catch (error) {
      previousError = formatError(error);
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`Attempt ${attempt} failed validation; retrying with validation feedback.`);
      }
    }
  }

  if (!plan) {
    throw new Error(previousError ?? "Could not generate a valid edit plan.");
  }

  assertPlanCompatibleWithContext(plan, context);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  console.log(`Wrote ${options.outputPath}`);
  console.log(summarizeEditPlan(plan));

  if (options.uploadToBox) {
    const uploaded = await uploadEditPlanToBox(options.outputPath);
    console.log(
      `Uploaded Box edit instructions: ${uploaded.name} (${uploaded.id}) in folder ${uploaded.folderName} (${uploaded.folderId})`,
    );
  }
}

function buildPromptForAttempt(context: unknown, previousError: string | undefined): string {
  const prompt = buildUserPrompt(EditContextSchema.parse(context));
  if (!previousError) {
    return prompt;
  }

  return [
    prompt,
    "Your previous edit plan failed validation. Generate a complete replacement JSON plan.",
    "Validation feedback:",
    previousError,
  ].join("\n\n");
}

function parseArgs(args: string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Usage:",
        "  npm run llm:plan -- --input llm-harness/fixtures/context.example.json --output llm-harness/out/edit-plan.json",
        "",
        "Options:",
        "  --input <path>   Input context JSON file.",
        "  --output <path>  Output edit-plan JSON file.",
        "  --model <model>  OpenAI model. Defaults to OPENAI_MODEL or gpt-4o-2024-08-06.",
        "  --no-box-upload Do not upload the generated JSON to Box.",
      ].join("\n"),
    );
    process.exit(0);
  }

  return {
    inputPath: readFlag(args, "--input") ?? DEFAULT_INPUT,
    outputPath: readFlag(args, "--output") ?? DEFAULT_OUTPUT,
    model: readFlag(args, "--model") ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    uploadToBox: !args.includes("--no-box-upload"),
  };
}

async function uploadEditPlanToBox(outputPath: string): Promise<{
  id: string;
  name: string;
  folderId: string;
  folderName: string;
}> {
  const outputFolderId = process.env.BOX_OUTPUT_FOLDER_ID;
  if (!outputFolderId) {
    throw new Error("BOX_OUTPUT_FOLDER_ID is required because llm:plan uploads edit instructions to Box by default.");
  }

  const box = createBoxClientFromEnv(process.env);
  await box.ensureFolder(outputFolderId, "edited reels");
  const editingInstructionsFolder = await box.ensureFolder(outputFolderId, "editing instructions");
  const uploaded = await box.uploadFileOrVersion(editingInstructionsFolder.id, outputPath, "application/json");

  return {
    id: uploaded.id,
    name: uploaded.name,
    folderId: editingInstructionsFolder.id,
    folderName: editingInstructionsFolder.name,
  };
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(formatError(error));
  process.exit(1);
});

function formatError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return [
      "Validation failed:",
      ...error.issues.map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`),
    ].join("\n");
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
