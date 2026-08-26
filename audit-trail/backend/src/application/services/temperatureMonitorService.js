import { SHIPMENT_STATES } from '../../domain/shipment/events/eventTypes.js';
import { replay } from '../../domain/shipment/reducers/shipmentReducer.js';
import { sleep } from '../../shared/utils/index.js';

/**
 * Automatic temperature monitoring.
 *
 * The requirement is that observations are recorded on an hourly cadence for
 * the duration a shipment is actually being monitored, without anyone typing a
 * number into a form. Three decisions make that work without damaging anything
 * the ledger guarantees:
 *
 * **1. It issues commands. It does not write events.**
 * The monitor calls `ShipmentCommandService.recordTemperature`, the same entry
 * point the HTTP API uses. So every automatic reading is loaded, folded,
 * version-checked, classified by the aggregate against the declared range and
 * appended by the Event Store - identically to a manual one. A background job
 * with a private path into the store would be exactly the hidden mutable
 * shortcut this project exists to argue against.
 *
 * **2. Classification still happens in the aggregate.**
 * The monitor never decides whether a reading is a breach. It supplies a
 * number; `recordTemperature` emits TEMPERATURE_RECORDED or TEMPERATURE_SPIKE.
 * That means one reading produces exactly one event, which is also what
 * satisfies "avoid duplicate alerts for the same reading" - there is no second
 * alerting pass that could fire twice.
 *
 * **3. The monitoring window is derived, not stored.**
 * A shipment is monitored from creation until it is unloaded, and never while
 * archived. Both are read from folded state, so a shipment that completes stops
 * being sampled without anything having to switch a flag off.
 */
export class TemperatureMonitorService {
  #eventStore;
  #commandService;
  #provider;
  #logger;
  #config;

  #running = false;
  #stopping = false;
  #loopPromise = null;

  #stats = {
    startedAt: null,
    sweeps: 0,
    readingsRecorded: 0,
    breachesRecorded: 0,
    shipmentsSkipped: 0,
    failures: 0,
    lastSweepAt: null,
    lastError: null,
  };

  constructor({ eventStore, shipmentCommandService, sensorProvider, logger, config }) {
    this.#eventStore = eventStore;
    this.#commandService = shipmentCommandService;
    this.#provider = sensorProvider;
    this.#logger = logger.child({ component: 'temperature-monitor' });
    this.#config = config;
  }

  get isRunning() {
    return this.#running;
  }

  get stats() {
    return {
      ...this.#stats,
      source: this.#provider.source,
      description: this.#provider.describes,
      intervalMs: this.#config.sensors.intervalMs,
    };
  }

  async start() {
    if (this.#running) return;
    if (!this.#config.sensors.enabled) {
      this.#logger.info('Temperature monitoring is disabled by configuration.');
      return;
    }

    this.#running = true;
    this.#stopping = false;
    this.#stats.startedAt = new Date().toISOString();

    this.#logger.info('Temperature monitor started.', {
      source: this.#provider.source,
      intervalMs: this.#config.sensors.intervalMs,
      sweepIntervalMs: this.#config.sensors.sweepIntervalMs,
    });

    this.#loopPromise = this.#loop();
  }

  async stop() {
    if (!this.#running) return;
    this.#stopping = true;
    await this.#loopPromise?.catch(() => {});
    this.#running = false;
    this.#logger.info('Temperature monitor stopped.', this.stats);
  }

  async #loop() {
    while (!this.#stopping) {
      try {
        await this.sweep();
      } catch (error) {
        this.#stats.failures += 1;
        this.#stats.lastError = error.message;
        // A monitoring failure must never take the API down with it: the
        // shipment ledger is authoritative and complete without this job, and
        // a missing reading is a gap, not a corruption.
        this.#logger.error('Temperature sweep failed; will retry on the next interval.', {
          reason: error.message,
        });
      }
      await sleep(this.#config.sensors.sweepIntervalMs);
    }
  }

  /**
   * One pass over every shipment currently inside its monitoring window.
   *
   * Exposed separately from the loop so tests can drive it deterministically
   * rather than waiting on a timer - the same pattern the projection worker
   * uses.
   */
  async sweep({ now = new Date() } = {}) {
    this.#stats.sweeps += 1;
    this.#stats.lastSweepAt = now.toISOString();

    if (this.#provider.source === 'none') return { recorded: 0, skipped: 0, reason: 'no-sensor-source' };

    const aggregateIds = await this.#eventStore.listAggregateIds();
    let recorded = 0;
    let skipped = 0;

    for (const aggregateId of aggregateIds) {
      if (this.#stopping) break;
      const outcome = await this.#sampleShipment(aggregateId, now);
      recorded += outcome.recorded;
      if (outcome.skipped) skipped += 1;
    }

    this.#stats.shipmentsSkipped += skipped;
    return { recorded, skipped };
  }

  async #sampleShipment(aggregateId, now) {
    const events = await this.#eventStore.getEvents(aggregateId);
    if (events.length === 0) return { recorded: 0, skipped: true };

    const state = replay(events);

    if (!this.#isMonitored(state)) return { recorded: 0, skipped: true };

    /**
     * Which hourly slots still need a reading.
     *
     * Slots are anchored to whole hours so a restarted process resumes the same
     * cadence rather than drifting a few minutes on every boot.
     *
     * Only slots *after the last event on the stream* are eligible. That is a
     * hard constraint, not a preference: the command service refuses an
     * `occurredAt` earlier than the previous event, because an event stamped
     * before its predecessor would corrupt the scrubber, the chart and any
     * dispute about sequence. Catching up therefore fills forward, never
     * backwards into gaps that have since been written over.
     */
    const slots = this.#dueSlots(state, now);
    if (slots.length === 0) return { recorded: 0, skipped: false };

    let recorded = 0;
    let expectedVersion = state.version;

    for (const slot of slots) {
      const reading = await this.#provider.read({
        aggregateId,
        containerCode: state.containerCode,
        at: slot,
        minTemperatureC: state.minTemperatureC,
        maxTemperatureC: state.maxTemperatureC,
      });

      if (!reading) break;

      try {
        const result = await this.#commandService.recordTemperature({
          shipmentId: aggregateId,
          temperatureC: reading.temperatureC,
          recordedAt: reading.recordedAt,
          sensorId: reading.sensorId,
          source: reading.source,
          occurredAt: slot,
          expectedVersion,
        });

        expectedVersion = result.version;
        recorded += 1;
        this.#stats.readingsRecorded += 1;
        if (result.eventType === 'TEMPERATURE_SPIKE') this.#stats.breachesRecorded += 1;
      } catch (error) {
        /**
         * A concurrency conflict here is entirely ordinary: an operator
         * confirmed a stage while this sweep was mid-flight. The monitor is not
         * privileged, so it yields and picks the shipment up next sweep with
         * fresh state, rather than retrying against a version it no longer
         * holds.
         */
        this.#logger.debug('Automatic reading yielded to a concurrent command.', {
          aggregateId,
          reason: error.message,
        });
        break;
      }
    }

    return { recorded, skipped: false };
  }

  /**
   * The monitoring window: created, not yet unloaded, not archived.
   *
   * Derived from folded state on every sweep. Nothing anywhere stores
   * "monitoring: on".
   */
  #isMonitored(state) {
    if (!state.exists) return false;
    if (state.archived) return false;
    if (state.currentState === SHIPMENT_STATES.UNLOADED) return false;
    return true;
  }

  #dueSlots(state, now) {
    const intervalMs = this.#config.sensors.intervalMs;
    const lastEventAt = Date.parse(state.lastEventAt ?? state.createdAt);
    const lastReadingAt = state.latestTemperatureAt ? Date.parse(state.latestTemperatureAt) : null;
    const anchor = lastReadingAt ?? Date.parse(state.createdAt);
    if (!Number.isFinite(anchor)) return [];

    const slots = [];
    let cursor = Math.floor(anchor / intervalMs) * intervalMs + intervalMs;

    while (cursor <= now.getTime() && slots.length < this.#config.sensors.maxCatchUpReadings) {
      // Never before the head of the stream - see the note above.
      if (cursor > lastEventAt) slots.push(new Date(cursor).toISOString());
      cursor += intervalMs;
    }

    return slots;
  }
}
