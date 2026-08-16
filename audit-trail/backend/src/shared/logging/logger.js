/**
 * Structured JSON logger (roadmap 18 - Logging and Observability).
 *
 * Dependency-free on purpose: one fewer supply-chain surface, and the output is
 * already machine-parseable for any log shipper.
 *
 * Redaction: keys that commonly carry secrets are masked before serialisation,
 * so a careless `logger.info('config', env)` cannot leak a connection string.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const REDACTED_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'mongodb_uri',
  'mongodburi',
  'connectionstring',
]);

function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[REDACTED_KEYS.has(key.toLowerCase()) ? key : key] = REDACTED_KEYS.has(key.toLowerCase())
      ? '[REDACTED]'
      : redact(val, depth + 1);
  }
  return out;
}

export function createLogger({ level = 'info', service = 'audit-trail', stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, message, context) {
    if (LEVELS[levelName] > threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      level: levelName,
      service,
      message,
      ...(context ? redact(context) : {}),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  }

  const logger = {
    level,
    error: (msg, ctx) => emit('error', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    debug: (msg, ctx) => emit('debug', msg, ctx),
    /** Returns a logger that stamps every record with fixed context (e.g. correlationId). */
    child(boundContext) {
      return {
        ...logger,
        error: (msg, ctx) => emit('error', msg, { ...boundContext, ...ctx }),
        warn: (msg, ctx) => emit('warn', msg, { ...boundContext, ...ctx }),
        info: (msg, ctx) => emit('info', msg, { ...boundContext, ...ctx }),
        debug: (msg, ctx) => emit('debug', msg, { ...boundContext, ...ctx }),
        child: (extra) => logger.child({ ...boundContext, ...extra }),
      };
    },
  };

  return logger;
}

/** A logger that swallows everything - used by tests to keep output readable. */
export const silentLogger = {
  level: 'silent',
  error() {},
  warn() {},
  info() {},
  debug() {},
  child() {
    return silentLogger;
  },
};
