import { z } from 'zod';

const schema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  TAVILY_API_KEY: z.string().min(1),
  APIFY_TOKEN: z.string().min(1),
  APIFY_IG_PROFILE_ACTOR: z.string().default('apify/instagram-profile-scraper'),
  APIFY_POSTS_PER_PROFILE: z.coerce.number().int().positive().default(10),
  TAVILY_TOP_N: z.coerce.number().int().positive().default(5),
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
