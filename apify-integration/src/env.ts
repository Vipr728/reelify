import { z } from 'zod';

// Load .env if present (Node >= 20.6). No-op if file or method is missing.
try {
  (process as { loadEnvFile?: (p: string) => void }).loadEnvFile?.('.env');
} catch {
  /* missing .env is fine — env may be exported in the shell instead */
}

const schema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().min(1),
  APIFY_TOKEN: z.string().min(1),
  APIFY_IG_ACTOR: z.string().default('apify/instagram-reel-scraper'),
  // 1 post per creator × 3 creators = 3 reels analyzed. Lean by default to
  // dodge Instagram blocks and keep wall-clock under a minute.
  APIFY_POSTS_PER_PROFILE: z.coerce.number().int().positive().default(1),
  TAVILY_TOP_N: z.coerce.number().int().positive().default(3),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing/invalid env: ${missing}. Copy .env.example to .env.`);
  }
  return parsed.data;
}
