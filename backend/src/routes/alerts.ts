import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";

export default async function alertsRoutes(app: FastifyInstance) {
  // Recent alert feed for the dashboard.
  app.get<{ Querystring: { limit?: string; type?: string } }>(
    "/alerts",
    async (req) => {
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const type = req.query.type;
      return prisma.alert.findMany({
        where: type ? { type: type as any } : undefined,
        orderBy: { createdAt: "desc" },
        take: limit,
      });
    },
  );
}
