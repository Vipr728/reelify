// Reelify desktop — preload. No privileged APIs are exposed to the renderer;
// the app is a self-contained UI prototype. Kept for contextIsolation hygiene
// and as the seam for future IPC (Box import, render pipeline, etc.).
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("reelify", {
  platform: process.platform,
});
