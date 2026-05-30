/* ============ REELIFY — runtime config ============ */
// The desktop renderer talks to the local Express server (server/index.js),
// which holds the Box client + OpenAI key and shells out to the apify pipeline.
// Override with VITE_REELIFY_API_URL at build time if the server moves.

export const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_REELIFY_API_URL) ||
  "http://localhost:8787";

// When true, screens that can't reach the backend fall back to bundled demo
// data (src/data.js) so the app is still demonstrable offline. Each screen
// shows a visible "demo data" notice in that case.
export const ALLOW_DEMO_FALLBACK = true;
