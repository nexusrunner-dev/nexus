import type { FastifyInstance } from "fastify";
import { analyzeToken } from "../services/analysis.js";
import { isValidSolanaAddress } from "../lib/solana.js";

export default async function analysisRoutes(app: FastifyInstance) {
  // "Why is this coin pumping?" — paste a mint address, get an explanation.
  app.post("/analyze", async (req, reply) => {
    const body = (req.body ?? {}) as { address?: string };
    const address = body.address?.trim();
    if (!isValidSolanaAddress(address)) {
      return reply.code(400).send({ error: "invalid Solana address" });
    }
    try {
      const result = await analyzeToken(address);
      return result;
    } catch (err) {
      app.log.error(err);
      return reply.code(502).send({ error: "analysis failed", detail: String(err) });
    }
  });
}
