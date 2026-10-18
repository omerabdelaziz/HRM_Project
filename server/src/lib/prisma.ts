import { PrismaClient, Prisma } from '@prisma/client';
import { env } from '../config/env';

export const prisma = new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient | Tx;
export { Prisma };
