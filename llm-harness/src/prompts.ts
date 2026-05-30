import type { EditContext } from "./schema";

export const SYSTEM_PROMPT = [
  "You generate machine-readable edit decision JSON for a deterministic video editing algorithm.",
  "No humans will interpret your output. No LLM will be used after this step.",
  "Return only fields allowed by the schema.",
  "Every value must be executable by code: exact asset IDs, exact seconds, exact track items, exact caption tokens, exact style IDs.",
  "Do not include notes, suggestions, explanations, vague directions, markdown, comments, or natural-language instructions outside caption text.",
  "Use only asset IDs that appear in the input context.",
  "Preserve each asset's boxFileId, boxPath, uri, kind, and durationSec exactly in the output plan assets.",
  "Use the facecam/talking_head asset as the dialogue source; it contains the speaker audio.",
  "Use the facecam metadata for head position and framing decisions when placing or shifting the facecam layer.",
  "Use b-roll metadata descriptions to choose cutaways that match the transcript and recipe.",
  "Follow the recipe fields for duration, pacing, caption style, b-roll frequency, audio, and hook structure.",
  "Keep items on the same track non-overlapping and ordered by time.",
  "Use talking_head assets for the main video track and broll assets on overlay tracks when useful.",
  "B-roll may be an overlay above facecam, a background behind facecam, or full-screen cutaway; encode the exact result with track zIndex and layout fields.",
  "Generate captions as caption cues with absolute timeline seconds and token-level highlight booleans.",
].join("\n");

export function buildUserPrompt(context: EditContext): string {
  return [
    "Create a complete edit plan JSON from this context.",
    "The output will be parsed by a robot editor that performs function calls from the JSON.",
    "The requested edit context is:",
    JSON.stringify(context, null, 2),
  ].join("\n\n");
}
