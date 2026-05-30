// Seed trend_cache with a handful of trending-reel rows + embeddings.
// Run once before the demo so the "Apify is down" fallback path is never empty.
//   node scripts/seed_trends.mjs
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY

import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Replace these with real captions you scraped once via Apify, or keep as-is.
const TRENDS = [
  { caption: "POV: you finally fix the bug at 2am", hashtags: ["devlife", "coding"], views: 1800000, duration_s: 11 },
  { caption: "3 things I wish I knew before my first startup", hashtags: ["startup", "founder"], views: 920000, duration_s: 18 },
  { caption: "Day in the life building an app solo", hashtags: ["buildinpublic", "indiehacker"], views: 640000, duration_s: 22 },
  { caption: "This editing trick doubled my views", hashtags: ["editing", "creator"], views: 2100000, duration_s: 9 },
  { caption: "Stop scrolling if you make content", hashtags: ["contentcreator", "tips"], views: 1500000, duration_s: 14 },
];

async function embed(text) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: text }),
  });
  return (await r.json()).data[0].embedding;
}

for (const t of TRENDS) {
  const embedding = await embed(`${t.caption} ${t.hashtags.join(" ")}`);
  const { error } = await sb.from("trend_cache").insert({ ...t, query: "seed", embedding });
  console.log(error ? `FAILED: ${t.caption} ${error.message}` : `seeded: ${t.caption}`);
}
console.log("Done.");
