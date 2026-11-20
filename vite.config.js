import { defineConfig } from "vite";

// Tauri expects a fixed port and fails if it is not available.
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "es2021", outDir: "dist", emptyOutDir: true },
});
