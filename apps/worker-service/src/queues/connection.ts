/**
 * Redis connections for BullMQ.
 *
 * Two things are true of the installed driver and both are load-bearing:
 *
 *  - **BullMQ needs `maxRetriesPerRequest: null`** on any connection used for a
 *    blocking command. Left at ioredis's default, a worker fails at startup with a
 *    timeout that reads like a Redis outage — Redis is fine, and the worker's own
 *    blocking call is what exhausted the budget. BullMQ logs a warning rather than
 *    throwing when handed options instead of an instance, which is the worse case:
 *    the misconfiguration is invisible until production.
 *  - **ioredis 6 has no per-client connection pool.** `maxConnections` is still
 *    accepted into `options` and silently ignored — one `Redis` instance is exactly
 *    one TCP connection. Verified against the installed 6.0.0: a client built with
 *    `maxConnections: 8` opens one socket, not eight.
 *
 * That second point is why this module exports small named factories instead of a
 * tunable pool size. Connection count here is a function of *how many clients are
 * created*, and BullMQ creates two per Worker (a blocking one and one for
 * commands), so the budget is enforced by `TenantWorker.maxTenants` — which
 * refuses new tenants rather than opening sockets until Redis refuses them. A
 * `maxConnections` knob on this module would be a setting that reads like a
 * control and does nothing.
 */
import { Redis } from 'ioredis';

export interface RedisConnectionOptions {
  /**
   * Command timeout in milliseconds.
   *
   * Omitted for anything that issues blocking commands: a timeout applied to the
   * whole connection would also apply to the blocking pop, which is meant to wait
   * indefinitely. {@link createQueueRedisConnection} takes one; a connection handed
   * to a BullMQ `Worker` must not carry it — BullMQ strips `commandTimeout` from
   * the client it duplicates for blocking anyway, which is why one factory serves
   * both roles.
   */
  readonly commandTimeoutMs?: number;
}

/**
 * The default command timeout for producer-side connections.
 *
 * 10s is generous for `LPUSH`/`SADD` and short enough that a stalled connection
 * surfaces within a client request's own patience.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * A connection for queue producers and registry operations.
 *
 * Gets a command timeout, because an enqueue that hangs on a half-open socket is
 * worse than one that fails: the caller is waiting on a request, and an error lets
 * it tell the client what happened. BullMQ never issues blocking commands here.
 */
export function createQueueRedisConnection(
  url: string,
  options: RedisConnectionOptions = {},
): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    commandTimeout: options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  });
}
