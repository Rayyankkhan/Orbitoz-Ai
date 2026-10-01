/**
 * Unauthenticated liveness and readiness.
 *
 * Deliberately free of tenant middleware: an infrastructure health check has no
 * Host header worth resolving, and requiring one would mark the service
 * unhealthy during a DNS incident when the service itself is fine.
 */
import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '@orbitoz/database';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: string; databaseLatencyMs: number }> {
    const databaseLatencyMs = await this.prisma.ping();
    return { status: 'ok', databaseLatencyMs };
  }
}
