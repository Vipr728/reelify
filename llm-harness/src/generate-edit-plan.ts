import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { createBoxClientFromEnv } from "./box-client";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import { assertPlanCompatibleWithContext, EditContextSchema, EditPlanSchema, summarizeEditPlan } from "./schema";

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
        format: zodTextFormat(EditPlanSchema, "edit_plan"),
      },
    });

    if (!response.output_parsed) {
      previousError = "OpenAI returned no parsed edit plan.";
      continue;
    }

    try {
      const parsedPlan = EditPlanSchema.parse(response.output_parsed);
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
