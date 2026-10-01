/**
 * Normalises error responses.
 *
 * Without this, Nest leaks internal messages in 500 bodies. The client gets a
 * stable `{ error, message, requestId }` shape and the operator gets the stack,
 * so neither has to choose between safety and debuggability.
 */
import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class HttpExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = (response.locals.requestId as string | undefined) ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: unknown }).message ?? exception.message);
      response.status(status).json({ error: HttpStatus[status] ?? 'Error', message, requestId });
      return;
    }

    this.logger.error(`Unhandled error (request ${requestId})`, exception as Error);
    response.status(500).json({
      error: 'InternalServerError',
      message: 'An unexpected error occurred.',
      requestId,
    });
  }
}
