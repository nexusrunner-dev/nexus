import path from "node:path";
import fs from "node:fs";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { corsOrigins, features } from "./config.js";

import walletsRoutes from "./routes/wallets.js";
import watchlistRoutes from "./routes/watchlist.js";
import alertsRoutes from "./routes/alerts.js";
import settingsRoutes from "./routes/settings.js";
import analysisRoutes from "./routes/analysis.js";
import webhookRoutes from "./routes/webhooks.js";

export function buildServer() {
  const app = Fastify({
    logger: { level: "info" },
    bodyLimit: 5 * 1024 * 1024, // Helius batches can be large
  });

  app.register(cors, {
    origin: (origin, cb) => {
      // Allow no-origin (curl, server-to-server) and any configured dashboard.
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      cb(null, false);
    },
  });

  app.get("/health", async () => ({ ok: true, features }));

  // API routes under /api; webhook stays at root for a clean Helius URL.
  app.register(
    async (api) => {
      await api.register(walletsRoutes);
      await api.register(watchlistRoutes);
      await api.register(alertsRoutes);
      await api.register(settingsRoutes);
      await api.register(analysisRoutes);
    },
    { prefix: "/api" },
  );

  app.register(webhookRoutes);

  // Serve the built dashboard (production single-service deploy). The Docker
  // image places the compiled frontend in ./public. In local dev this folder
  // doesn't exist, so we skip it and the dashboard runs separately via Vite.
  const frontendDir = path.resolve(process.cwd(), process.env.FRONTEND_DIR || "public");
  if (fs.existsSync(path.join(frontendDir, "index.html"))) {
    app.register(fastifyStatic, { root: frontendDir, prefix: "/" });
    // Fallback any non-API GET to the SPA entry point.
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === "GET" &&
        !req.url.startsWith("/api") &&
        !req.url.startsWith("/webhooks")
      ) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
