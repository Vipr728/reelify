import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the built assets resolve under Electron's file:// protocol.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
