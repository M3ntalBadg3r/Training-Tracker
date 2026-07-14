import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL!;

// Explicit pool sizing so concurrent report loads (each fires many sequential
// queries) don't saturate node-postgres' default of 10 connections. Tunable
// via DATABASE_POOL_MAX. The timeouts free idle connections and fail fast
// (rather than hang) when the pool is exhausted under load.
const poolMax = Number(process.env.DATABASE_POOL_MAX) || 20;

const adapter = new PrismaPg({
  connectionString,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export default prisma;
export type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
