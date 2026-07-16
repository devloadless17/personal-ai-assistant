import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';

/**
 * Turns a ZodError (from a `schema.parse(body)` in a controller) into a clean
 * 400 with the field messages, instead of a generic 500. Registered globally.
 */
@Catch(ZodError)
export class ZodExceptionFilter implements ExceptionFilter {
  catch(exception: ZodError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const message = exception.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      error: 'Bad Request',
      message,
    });
  }
}
