import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";

import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts";
import { assertPlanCompatibleWithContext, EditContextSchema, EditPlanSchema, summarizeEditPlan } from "./schema";

type CliOptions = {
  inputPath: string;
  outputPath: string;
  model: string;
};

const DEFAULT_INPUT = "llm-harness/fixtures/context.example.json";
const DEFAULT_OUTPUT = "llm-harness/out/edit-plan.json";
const DEFAULT_MODEL = "gpt-4o-2024-08-06";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const inputJson = JSON.parse(await readFile(options.inputPath, "utf8"));
  const context = EditContextSchema.parse(inputJson);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate an edit plan.");
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.parse({
    model: options.model,
    input: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: buildUserPrompt(context),
      },
    ],
    text: {
      format: zodTextFormat(EditPlanSchema, "edit_plan"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI returned no parsed edit plan.");
  }

  const plan = EditPlanSchema.parse(response.output_parsed);
  assertPlanCompatibleWithContext(plan, context);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  console.log(`Wrote ${options.outputPath}`);
  console.log(summarizeEditPlan(plan));
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
      ].join("\n"),
    );
    process.exit(0);
  }

  return {
    inputPath: readFlag(args, "--input") ?? DEFAULT_INPUT,
    outputPath: readFlag(args, "--output") ?? DEFAULT_OUTPUT,
    model: readFlag(args, "--model") ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
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
  if (error instanceof z.ZodError) {
    console.error("Validation failed:");
    for (const issue of error.issues) {
      console.error(`- ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  } else if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
