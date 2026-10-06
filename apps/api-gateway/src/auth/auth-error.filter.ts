/**
 * Maps `AuthError` onto the HTTP contract.
 *
 * Separate from `HttpExceptionFilter` because the two answer different
 * questions. That filter decides what an *unexpected* failure looks like — a 500
 * with no internal detail leaked. This one decides the status and canonical code
 * for a failure the system anticipated, so it maps `ErrorCode` through
 * `HTTP_STATUS_BY_ERROR_CODE` rather than hard-coding numbers. A new auth error
 * therefore cannot drift out of sync with the published contract.
 *
 * Registered globally in `main.ts`, not per controller: an `AuthError` thrown from
 * anywhere — a future API-key guard, a service method called by another module —
 * should render identically.
 */
import { Catch, Logger, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ErrorCode, HTTP_STATUS_BY_ERROR_CODE } from '@orbitoz/shared-types';
import { AuthError } from './auth.errors.js';
import { requestIdOf } from '../tenancy/request-locals.js';

@Catch(AuthError)
export class AuthErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(AuthErrorFilter.name);

  catch(exception: AuthError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = requestIdOf(response);

    const status = HTTP_STATUS_BY_ERROR_CODE[exception.code as ErrorCode] ?? 500;

    // 5xx means the mapping itself is wrong or something genuinely unexpected
    // happened; either way the operator needs it. 4xx is routine and would be
    // noise at error level.
    if (status >= 500) {
      this.logger.error(`Auth error ${exception.code} on request ${requestId}`, exception.stack);
    } else {
      this.logger.debug(
        `Auth error ${exception.code} on request ${requestId}: ${exception.message}`,
      );
    }

    response.status(status).json({
      error: exception.code,
      message: exception.message,
      requestId,
    });
  }
}
