/**
 * Worker entry point.
 *
 * A plain process rather than a Nest application: there is no HTTP surface, and
 * `@nestjs/bullmq` would add a container and a module graph to supervise a
 * single Worker instance. Revisit if the worker grows scheduled jobs or needs
 * an admin endpoint.
 */
import { Logger } from '@nestjs/common';
import { loadEnv } from './config/env.js';
import { QUEUE_NAMES } from './queues/inference.queue.js';
import { startWorker } from './worker.js';

const logger = new Logger('Worker');
const env = loadEnv();
logger.log(
  `Worker starting: concurrency=${env.worker.concurrency} queue=${QUEUE_NAMES.AiInference}`,
);

const worker = startWorker();

// BullMQ pauses rather than drops on SIGTERM, so jobs finish instead of
// failing on every deploy.
const shutdown = async (signal: string): Promise<void> => {
  logger.log(`${signal} received; draining worker`);
  await worker.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
