import 'dotenv/config';

/**
 * Configuration is read exactly once, here (roadmap 9.3).
 *
 * No other module reads `process.env`; they receive config through dependency
 * injection. That is what makes the whole backend testable without setting
 * environment variables in the test process.
 */
function readString(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return fallback;
  }
  return raw;
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received '${raw}'.`);
  }
  return parsed;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

export function loadConfig(overrides = {}) {
  const config = {
    nodeEnv: readString('NODE_ENV', 'development'),
    port: readInt('PORT', 4000),

    /**
     * PERSISTENCE=mongo   -> real MongoDB (production / normal development)
     * PERSISTENCE=memory  -> in-process store implementing the same driver
     *                        surface. Lets the whole system (including the
     *                        worker and every test) run with no database
     *                        installed. See docs/database/DATABASE.md.
     */
    persistence: readString('PERSISTENCE', 'mongo'),
    mongodbUri: readString('MONGODB_URI', 'mongodb://127.0.0.1:27017'),
    mongodbDatabase: readString('MONGODB_DATABASE', 'audit_trail'),

    logLevel: readString('LOG_LEVEL', 'info'),
    corsOrigin: readString('CORS_ORIGIN', 'http://localhost:5173'),
    auth: {
      enabled: readBool('AUTH_ENABLED', true),
      /**
       * Signs session tokens. Leave unset in development and a random secret
       * is generated per boot (sessions then end at restart); set it in any
       * deployment where sessions must survive one.
       */
      tokenSecret: readString('AUTH_TOKEN_SECRET', ''),
      /** Session lifetime. 12 hours by default - about one working shift. */
      tokenTtlMs: readInt('AUTH_TOKEN_TTL_MS', 43_200_000),
      /**
       * Creates the two demo accounts the sign-in page offers, if they do not
       * already exist. Off unless explicitly enabled, because an account with a
       * published password should never appear in a deployment by accident.
       *
       * The accounts are ordinary accounts: they are created through
       * AuthService.register, so they get the same scrypt hashing, the same
       * validation and the same role rules as any other. There is no bypass.
       */
      seedDemoAccounts: readBool('AUTH_SEED_DEMO_ACCOUNTS', false),
    },

    /** Worker (roadmap 12.3). Polling + checkpoint, per roadmap 26. */
    worker: {
      enabled: readBool('WORKER_ENABLED', true),
      /** true = run inside the API process; false = run `npm run start:worker`. */
      inProcess: readBool('WORKER_IN_PROCESS', true),
      pollIntervalMs: readInt('WORKER_POLL_INTERVAL_MS', 500),
      batchSize: readInt('WORKER_BATCH_SIZE', 200),
      maxRetries: readInt('WORKER_MAX_RETRIES', 5),
      retryBackoffMs: readInt('WORKER_RETRY_BACKOFF_MS', 250),
      name: readString('WORKER_NAME', 'shipment-projection-worker'),
    },

    /**
     * Automatic temperature monitoring.
     *
     * `source` defaults to `simulated` so a fresh checkout demonstrates the
     * hourly monitoring, the breach path and the alert timeline without needing
     * hardware. Every reading it produces is stamped SIMULATED in its immutable
     * payload and labelled as such in the chart, the timeline and the PDF.
     * Set `SENSOR_SOURCE=none` for a deployment with no sensors - the monitor
     * then records nothing rather than inventing data.
     */
    sensors: {
      enabled: readBool('SENSOR_MONITOR_ENABLED', true),
      source: readString('SENSOR_SOURCE', 'simulated'),
      feedUrl: readString('SENSOR_FEED_URL', ''),
      timeoutMs: readInt('SENSOR_FEED_TIMEOUT_MS', 5000),
      /** The required hourly cadence. Lower it to demonstrate faster. */
      intervalMs: readInt('SENSOR_INTERVAL_MS', 3_600_000),
      /** How often the monitor looks for shipments that are due a reading. */
      sweepIntervalMs: readInt('SENSOR_SWEEP_INTERVAL_MS', 60_000),
      /** Bounds catch-up after downtime so a restart cannot flood a stream. */
      maxCatchUpReadings: readInt('SENSOR_MAX_CATCHUP', 48),
      excursionChance: Number(readString('SENSOR_EXCURSION_CHANCE', '0.08')),
    },

    /** Server-sent events - the near-real-time read-side push. */
    realtime: {
      enabled: readBool('REALTIME_ENABLED', true),
      heartbeatMs: readInt('REALTIME_HEARTBEAT_MS', 25_000),
    },

    /** Roadmap 16 - rate limiting on the command surface. */
    rateLimit: {
      enabled: readBool('RATE_LIMIT_ENABLED', true),
      windowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000),
      maxRequests: readInt('RATE_LIMIT_MAX_REQUESTS', 300),
    },

    /** Roadmap 17 - guard against unbounded replay/pagination. */
    limits: {
      maxEventsPerQuery: readInt('MAX_EVENTS_PER_QUERY', 5000),
      maxShipmentsPerPage: readInt('MAX_SHIPMENTS_PER_PAGE', 100),
    },

    ...overrides,
  };

  if (!['mongo', 'memory'].includes(config.persistence)) {
    throw new Error(`PERSISTENCE must be 'mongo' or 'memory', received '${config.persistence}'.`);
  }

  if (!['simulated', 'external', 'none'].includes(config.sensors.source)) {
    throw new Error(
      `SENSOR_SOURCE must be 'simulated', 'external' or 'none', received '${config.sensors.source}'.`
    );
  }
  if (config.sensors.source === 'external' && !config.sensors.feedUrl) {
    throw new Error('SENSOR_FEED_URL is required when SENSOR_SOURCE=external.');
  }

  return Object.freeze(config);
}

export const COLLECTIONS = Object.freeze({
  events: 'shipment_events',
  readModel: 'shipment_read_model',
  checkpoints: 'projection_checkpoints',
  counters: 'counters',
  /** Account records. Deliberately a separate collection from the Event Store. */
  users: 'users',
  deadLetters: 'projection_dead_letters',
});
