import dotenv from "dotenv";

dotenv.config({ quiet: true });

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { BoxClient, createBoxClientFromEnv, type BoxItem } from "./box-client";
import { DEFAULT_RECIPE } from "./default-recipe";
import { parseRecipeInput } from "./recipe";
import { EditContextSchema, type EditContext } from "./schema";

type CliOptions = {
  reelId: string;
  outputPath: string;
  rootFolderId: string;
  reelFolderId?: string;
  rootFolderName: string;
  reelsFolderName: string;
  recipePath?: string;
};

type ResolvedReel = {
  folderId: string;
  boxPath: string;
};

const DEFAULT_REEL_ID = "reel_001";
const DEFAULT_OUTPUT = "llm-harness/out/context.reel_001.json";
const DEFAULT_ROOT_FOLDER_NAME = "Reelify-Hackathon";
const DEFAULT_REELS_FOLDER_NAME = "reels";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env);
  const box = createBoxClientFromEnv(process.env);
  const reel = options.reelFolderId
    ? { folderId: options.reelFolderId, boxPath: `/${options.reelId}` }
    : await resolveReelFolder(box, options);

  const context = await buildEditContextFromBoxReel(box, reel, options);
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");

  console.log(`Wrote ${options.outputPath}`);
  console.log(`reel=${context.reel.id} assets=${context.assets.length} boxPath=${context.reel.boxPath}`);
}

export async function buildEditContextFromBoxReel(
  box: BoxClient,
  reel: ResolvedReel,
  options: Pick<CliOptions, "reelId" | "recipePath">,
): Promise<EditContext> {
  const reelItems = await box.listFolderItems(reel.folderId);
  const facecamFolder = requireFolder(reelItems, "facecam", reel.boxPath);
  const brollFolder = requireFolder(reelItems, "broll", reel.boxPath);
  const manifestFile = requireFile(reelItems, "reel_manifest.json", reel.boxPath);

  const manifest = await box.downloadJsonFile(manifestFile.id);
  const recipe = options.recipePath
    ? parseRecipeInput(JSON.parse(await readFile(options.recipePath, "utf8")), options.recipePath)
    : DEFAULT_RECIPE;

  const facecamItems = await box.listFolderItems(facecamFolder.id);
  const facecamFile = requireFile(facecamItems, "facecam.mp4", `${reel.boxPath}/facecam`);
  const transcriptTextFile = await findFileOrNull(box, facecamFolder.id, "transcript.txt");
  const transcriptMetadataFile =
    (await findFileOrNull(box, facecamFolder.id, "transcript.json")) ??
    (await findFileOrNull(box, facecamFolder.id, "metadata.json"));

  const transcript = transcriptTextFile ? await box.downloadTextFile(transcriptTextFile.id) : "";
  const facecamMetadata = transcriptMetadataFile ? await box.downloadJsonFile(transcriptMetadataFile.id) : {};

  const brollItems = await box.listFolderItems(brollFolder.id);
  const brollClipFolders = brollItems
    .filter((item) => item.type === "folder")
    .sort((a, b) => a.name.localeCompare(b.name));

  const brollAssets: EditContext["assets"] = [];
  for (const clipFolder of brollClipFolders) {
    const clipPath = `${reel.boxPath}/broll/${clipFolder.name}`;
    const clipItems = await box.listFolderItems(clipFolder.id);
    const clipFile = requireFile(clipItems, "clip.mp4", clipPath);
    const metadataFile = requireFile(clipItems, "metadata.json", clipPath);
    const metadata = await box.downloadJsonFile(metadataFile.id);
    const durationSec = readDurationSec(metadata, ...findManifestCandidates(manifest, clipFolder.name));

    brollAssets.push({
      id: clipFolder.name,
      kind: "broll",
      uri: `box://files/${clipFile.id}`,
      boxFileId: clipFile.id,
      boxPath: `${clipPath}/clip.mp4`,
      durationSec,
      description: readDescription(metadata, clipFolder.name),
      transcript: "",
      metadata,
    });
  }

  const context = EditContextSchema.parse({
    schemaVersion: "1.0",
    reel: {
      id: options.reelId,
      boxFolderId: reel.folderId,
      boxPath: reel.boxPath,
      manifest,
    },
    request: recipe.summary,
    output: {
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      targetDurationSec: recipe.durationSec,
    },
    assets: [
      {
        id: "facecam",
        kind: "talking_head",
        uri: `box://files/${facecamFile.id}`,
        boxFileId: facecamFile.id,
        boxPath: `${reel.boxPath}/facecam/facecam.mp4`,
        durationSec: readDurationSec(facecamMetadata, ...findManifestCandidates(manifest, "facecam")),
        description: "Primary facecam video with dialogue audio.",
        transcript: (transcript.trim() || findFirstString(facecamMetadata, ["transcript", "text", "fullText"]) || "").trim(),
        metadata: facecamMetadata,
      },
      ...brollAssets,
    ],
    recipe,
    style: {
      pacing: "medium",
      captionCase: "sentence",
      captionAnimation: "pop",
      brollDensity: "medium",
    },
  });

  return context;
}

async function resolveReelFolder(box: BoxClient, options: CliOptions): Promise<ResolvedReel> {
  const candidates = [
    [options.reelId],
    [options.reelsFolderName, options.reelId],
    [options.rootFolderName, options.reelsFolderName, options.reelId],
  ];

  for (const segments of candidates) {
    const resolved = await resolveFolderPath(box, options.rootFolderId, segments);
    if (resolved) {
      return {
        folderId: resolved.id,
        boxPath: `/${segments.join("/")}`,
      };
    }
  }

  throw new Error(
    `Could not find reel folder ${options.reelId}. Tried ${candidates.map((segments) => `/${segments.join("/")}`).join(", ")} from Box folder ${options.rootFolderId}.`,
  );
}

async function resolveFolderPath(
  box: BoxClient,
  startFolderId: string,
  segments: string[],
): Promise<BoxItem | null> {
  let current: BoxItem = { id: startFolderId, type: "folder", name: "" };

  for (const segment of segments) {
    const next = await box.findFolder(current.id, segment);
    if (!next) {
      return null;
    }
    current = next;
  }

  return current;
}

function parseArgs(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Usage:",
        "  npm run llm:context:box -- --reel reel_001 --output llm-harness/out/context.reel_001.json",
        "",
        "Options:",
        "  --reel <id>                Reel folder name. Defaults to reel_001.",
        "  --output <path>            Output context JSON file.",
        "  --root-folder-id <id>      Starting Box folder. Defaults to BOX_REELS_ROOT_FOLDER_ID, BOX_REELS_FOLDER_ID, or BOX_RAW_FOLDER_ID.",
        "  --reel-folder-id <id>      Direct Box folder ID for the reel.",
        "  --root-folder-name <name>  Defaults to Reelify-Hackathon.",
        "  --reels-folder-name <name> Defaults to reels.",
        "  --recipe <path>            Optional flat harness recipe or Apify recipe JSON.",
      ].join("\n"),
    );
    process.exit(0);
  }

  const reelId = readFlag(args, "--reel") ?? DEFAULT_REEL_ID;
  const rootFolderId =
    readFlag(args, "--root-folder-id") ??
    env.BOX_REELS_ROOT_FOLDER_ID ??
    env.BOX_REELS_FOLDER_ID ??
    env.BOX_RAW_FOLDER_ID;

  if (!rootFolderId) {
    throw new Error("Missing Box root folder. Set BOX_REELS_ROOT_FOLDER_ID, BOX_REELS_FOLDER_ID, or BOX_RAW_FOLDER_ID.");
  }

  return {
    reelId,
    outputPath: readFlag(args, "--output") ?? `llm-harness/out/context.${reelId}.json`,
    rootFolderId,
    reelFolderId: readFlag(args, "--reel-folder-id"),
    rootFolderName: readFlag(args, "--root-folder-name") ?? DEFAULT_ROOT_FOLDER_NAME,
    reelsFolderName: readFlag(args, "--reels-folder-name") ?? DEFAULT_REELS_FOLDER_NAME,
    recipePath: readFlag(args, "--recipe"),
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

function requireFolder(items: BoxItem[], name: string, parentPath: string): BoxItem {
  const item = items.find((entry) => entry.type === "folder" && entry.name === name);
  if (!item) {
    throw new Error(`Missing Box folder: ${parentPath}/${name}`);
  }
  return item;
}

function requireFile(items: BoxItem[], name: string, parentPath: string): BoxItem {
  const item = items.find((entry) => entry.type === "file" && entry.name === name);
  if (!item) {
    throw new Error(`Missing Box file: ${parentPath}/${name}`);
  }
  return item;
}

async function findFileOrNull(box: BoxClient, folderId: string, name: string): Promise<BoxItem | null> {
  return box.findFile(folderId, name);
}

function readDurationSec(...sources: unknown[]): number {
  for (const source of sources) {
    const value = findFirstNumber(source, [
      "durationSec",
      "durationSeconds",
      "duration_seconds",
      "duration",
      "lengthSec",
      "length_seconds",
      "clipDurationSec",
    ]);
    if (value && value > 0) {
      return value;
    }
  }

  throw new Error("Could not infer durationSec from Box metadata or reel manifest.");
}

function findManifestCandidates(manifest: unknown, targetName: string): unknown[] {
  const candidates: unknown[] = [];
  collectManifestCandidates(manifest, targetName, candidates);
  return candidates;
}

function collectManifestCandidates(value: unknown, targetName: string, candidates: unknown[]): void {
  if (typeof value !== "object" || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectManifestCandidates(entry, targetName, candidates);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if (record[targetName]) {
    candidates.push(record[targetName]);
  }

  const identityValues = [record.id, record.name, record.clipId, record.assetId, record.folderName];
  if (identityValues.some((identity) => identity === targetName)) {
    candidates.push(record);
  }

  for (const nested of Object.values(record)) {
    collectManifestCandidates(nested, targetName, candidates);
  }
}

function readDescription(metadata: unknown, fallback: string): string {
  const strings = [
    findFirstString(metadata, ["description", "summary", "visualDescription", "caption", "title"]),
    readStringArray(metadata, ["tags", "keywords", "labels"])?.join(", "),
  ].filter((value): value is string => Boolean(value?.trim()));

  return strings.length > 0 ? strings.join(" · ") : fallback;
}

function findFirstNumber(value: unknown, keys: string[]): number | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findFirstNumber(entry, keys);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "number") {
      return record[key] as number;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedValue = findFirstNumber(nested, keys);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function findFirstString(value: unknown, keys: string[]): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findFirstString(entry, keys);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }

  for (const nested of Object.values(record)) {
    const nestedValue = findFirstString(nested, keys);
    if (nestedValue !== null) {
      return nestedValue;
    }
  }

  return null;
}

function readStringArray(value: unknown, keys: string[]): string[] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const entry = record[key];
    if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      return entry;
    }
  }

  return null;
}

main().catch((error: unknown) => {
  if (error instanceof z.ZodError) {
    console.error("Box context validation failed:");
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
