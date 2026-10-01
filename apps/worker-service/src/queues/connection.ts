/**
 * Redis connections.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on any connection it uses for
 * blocking commands. Leaving it at the ioredis default makes the worker fail at
 * startup with a timeout that looks like a Redis outage.
 */
import { Redis } from 'ioredis';

export function createRedisConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
