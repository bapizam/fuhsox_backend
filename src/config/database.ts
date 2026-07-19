import { PrismaClient, Prisma } from '@prisma/client';
import mongoose from 'mongoose';
import { env } from './env';
import logger from '@lib/logger';

const logLevels: Prisma.LogLevel[] = env.NODE_ENV === 'development'
  ? ['query', 'warn', 'error']
  : ['error'];

const prismaClientOptions = { log: logLevels };

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient(prismaClientOptions);

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabases(): Promise<void> {
  await prisma.$connect();
  logger.info('PostgreSQL connected');

  mongoose.set('strictQuery', true);

  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  });

  logger.info('MongoDB connected');
}

export async function disconnectDatabases(): Promise<void> {
  await prisma.$disconnect();
  await mongoose.disconnect();
  logger.info('Databases disconnected');
}

mongoose.connection.on('error', (err) => {
  logger.error({ err }, 'MongoDB connection error');
});

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

export default prisma;
