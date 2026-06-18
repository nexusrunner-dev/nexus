import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During local dev, proxy /api and /webhooks to the backend so the dashboard
// and API share an origin (no CORS fuss).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  preview: {
    port: 4173,
  },
});
