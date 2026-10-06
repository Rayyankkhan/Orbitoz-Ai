/**
 * Approval module wiring.
 *
 * ---------------------------------------------------------------------------
 * ROUTING AND TENANT RESOLUTION
 * ---------------------------------------------------------------------------
 * Unlike `AuthModule`, this module adds no middleware of its own: `AppModule`
 * already applies `TenantMiddleware` to every route except `/health`, so the
 * approval routes resolve a tenant the same way every other route does. Adding a
 * second `configure` here would be a chance to get the exclusions wrong.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIGNATURE SERVICE IS BUILT BY A FACTORY
 * ---------------------------------------------------------------------------
 * Same reason `TokenService` is: it takes validated configuration rather than
 * reading `process.env` in its constructor, so every secret in the process is
 * read in exactly one place — `env.ts` — and a test can construct one with an
 * explicit key without mutating the environment.
 *
 * Its constructor also enforces a minimum key length. `env.ts` already rejects
 * short secrets, and that is a defence in depth rather than a duplicate: `env.ts`
 * can be bypassed by a caller of `loadEnv(source)` in a test, and a one-byte HMAC
 * key produces signatures that verify perfectly.
 */
import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { EnvService } from '../config/env.service.js';
import { QueueProducer } from '../queues/queue-producer.js';
import { ApprovalController } from './approval.controller.js';
import { ApprovalService } from './approval.service.js';
import { ApprovalSignatureService } from './approval-signature.service.js';
import { ApprovalTokenService } from './approval-token.service.js';

@Module({
  imports: [TenancyModule],
  controllers: [ApprovalController],
  providers: [
    ApprovalService,
    ApprovalTokenService,
    QueueProducer,
    {
      provide: ApprovalSignatureService,
      useFactory: (env: EnvService): ApprovalSignatureService =>
        new ApprovalSignatureService({
          secret: env.value.approvals.signingSecret,
          toleranceSeconds: env.value.approvals.signatureToleranceSeconds,
        }),
      inject: [EnvService],
    },
  ],
  // Exported so a future module (a notification service that emails the link, an
  // inference controller that gates jobs) can create approvals without reaching
  // into this module's internals.
  exports: [ApprovalService, ApprovalTokenService, QueueProducer],
})
export class ApprovalModule {}
