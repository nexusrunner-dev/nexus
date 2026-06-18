import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the whole process.
export const prisma = new PrismaClient({
  log: ["warn", "error"],
});

// Small helpers for the key/value Setting table.
export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}
