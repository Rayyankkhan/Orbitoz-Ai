import { Worker } from 'bullmq';
import { createPrismaClient } from '@orbitoz/database';
import type { BaseJob, InferenceJobPayload } from '@orbitoz/shared-types';
import { loadEnv } from './config/env.js';
import { createRedisConnection } from './queues/connection.js';
import { QUEUE_NAMES } from './queues/inference.queue.js';
import { InferenceProcessor } from './processors/inference.processor.js';

export function startWorker(): Worker {
  const env = loadEnv();
  const connection = createRedisConnection(env.redis.url);
  const prisma = createPrismaClient({ connectionString: env.database.url });
  const processor = new InferenceProcessor(prisma);

  const worker = new Worker<BaseJob<InferenceJobPayload>>(
    QUEUE_NAMES.AiInference,
    async (job) => processor.process(job),
    { connection, concurrency: env.worker.concurrency, limiter: { max: 50, duration: 1_000 } },
  );

  worker.on('failed', (job, error) => {
    console.error(`Job ${job?.id ?? 'unknown'} failed: ${error.message}`);
  });
  worker.on('error', (error) => {
    console.error(`Worker error: ${error.message}`);
  });

  return worker;
}
