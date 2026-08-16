import { AppError } from '../../../shared/errors/AppError.js';
import { newId } from '../../../shared/utils/index.js';

/**
 * Attaches a correlation id to every request and logs its outcome
 * (roadmap 18). The id flows into the command handler, into the event's
 * `correlationId` field, and back to the client in `x-correlation-id`, so a
 * single dashboard action can be traced from browser to stored event.
 */
export function requestLogger(logger) {
  return (req, res, next) => {
    const correlationId = req.get('x-correlation-id') ?? newId();
    req.correlationId = correlationId;
    res.set('x-correlation-id', correlationId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level]('HTTP request completed.', {
        correlationId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        // The CQRS side this request was served by - handy when reading logs.
        side: req.cqrsSide ?? 'n/a',
      });
    });

    next();
  };
}

/** Marks which half of the CQRS split handled a request, for logs and headers. */
export function tagCqrsSide(side) {
  return (req, res, next) => {
    req.cqrsSide = side;
    res.set('x-cqrs-side', side);
    next();
  };
}

/**
 * Wraps an async route handler so a rejected promise reaches the error
 * middleware instead of hanging the request. Express 4 does not do this itself.
 */
export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

/**
 * Fixed-window rate limiter for the command surface (roadmap 16).
 *
 * In-process and therefore per-instance; a multi-instance deployment would move
 * the counter to Redis. Documented rather than silently assumed to be enough.
 */
export function rateLimiter({ windowMs, maxRequests, enabled = true, logger }) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs).unref?.();

  return (req, res, next) => {
    if (!enabled) return next();

    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      logger?.warn('Rate limit exceeded.', { path: req.originalUrl, retryAfterSeconds: retryAfter });
      res.set('retry-after', String(retryAfter));
      return res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: `Too many requests. Retry in ${retryAfter}s.`,
        },
      });
    }

    return next();
  };
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}.`,
    },
  });
}

/**
 * Centralised error handler (roadmap 9.2, 16 "Safe errors").
 *
 * Known `AppError`s carry their own status and safe payload. Anything else is
 * assumed to be a genuine defect: it is logged in full server-side and reduced
 * to a generic 500 for the client, so stack traces, MongoDB internals and file
 * paths never cross the network.
 */
export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity.
  return (error, req, res, next) => {
    const correlationId = req.correlationId ?? null;

    if (error instanceof AppError) {
      const level = error.status >= 500 ? 'error' : 'warn';
      logger[level]('Request failed with a handled error.', {
        correlationId,
        code: error.code,
        status: error.status,
        path: req.originalUrl,
        message: error.message,
      });
      return res.status(error.status).json({ ...error.toJSON(), correlationId });
    }

    if (error?.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON.' },
        correlationId,
      });
    }

    logger.error('Unhandled error while serving a request.', {
      correlationId,
      path: req.originalUrl,
      message: error?.message,
      stack: error?.stack,
    });

    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred. The failure has been logged.',
      },
      correlationId,
    });
  };
}
