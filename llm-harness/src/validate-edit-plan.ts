import { readFile } from "node:fs/promises";
import { z } from "zod";

import { EditPlanSchema, summarizeEditPlan } from "./schema";

async function main(): Promise<void> {
  const filePath = process.argv[2] ?? "llm-harness/fixtures/edit-plan.example.json";
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  const plan = EditPlanSchema.parse(raw);

  console.log(`Valid edit plan: ${filePath}`);
  console.log(summarizeEditPlan(plan));
}

main().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    console.error("Invalid edit plan:");
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
