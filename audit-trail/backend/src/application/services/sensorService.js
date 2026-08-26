import { EVENT_TYPES } from '../../domain/shipment/events/eventTypes.js';
import { AggregateNotFoundError } from '../../shared/errors/AppError.js';
import { toEpoch } from '../../shared/utils/index.js';

/**
 * Sensor series service (roadmap 13.5).
 *
 * There is no separate sensor table. The series is *derived from the same
 * events* the timeline renders, which is the only way the chart and the
 * timeline can be guaranteed to share a temporal coordinate system - the
 * failure mode roadmap 22 warns about under "Sensor/chart mismatch".
 *
 * Every point therefore carries the `eventId` and `version` it came from, so
 * the frontend can highlight a chart point when its timeline event is selected
 * without doing any timestamp matching of its own.
 */
export class SensorService {
  #eventStore;

  constructor({ eventStore }) {
    this.#eventStore = eventStore;
  }

  async getTemperatureSeries(aggregateId, { at = null } = {}) {
    const events = await this.#eventStore.getEvents(aggregateId);
    if (events.length === 0) throw new AggregateNotFoundError(aggregateId);

    const visible = at ? events.filter((event) => toEpoch(event.timestamp) <= toEpoch(at)) : events;

    const creation = events.find((event) => event.eventType === EVENT_TYPES.CONTAINER_CREATED);
    const minTemperatureC = creation?.payload?.minTemperatureC ?? null;
    const maxTemperatureC = creation?.payload?.maxTemperatureC ?? null;

    const readings = visible
      .filter(
        (event) =>
          event.eventType === EVENT_TYPES.TEMPERATURE_RECORDED ||
          event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE
      )
      .map((event) => ({
        eventId: event.eventId,
        version: event.version,
        // `recordedAt` is when the sensor sampled; `timestamp` is when the
        // system recorded it. They are usually equal but must not be conflated,
        // so both are exposed and the chart plots the sensor's own clock.
        timestamp: event.payload.recordedAt ?? event.timestamp,
        recordedAtSystem: event.timestamp,
        epoch: toEpoch(event.payload.recordedAt ?? event.timestamp),
        temperatureC: event.payload.temperatureC ?? null,
        isBreach: event.eventType === EVENT_TYPES.TEMPERATURE_SPIKE,
        direction: event.payload.direction ?? null,
        thresholdC: event.payload.thresholdC ?? null,
        sensorId: event.payload.sensorId ?? null,
        // Carried through so the chart can label simulated data as simulated.
        source: event.payload.source ?? 'MANUAL',
      }))
      .sort((a, b) => a.epoch - b.epoch);

    // Lifecycle events are returned alongside the readings so Recharts can draw
    // reference lines on exactly the same axis.
    const markers = visible
      .filter((event) =>
        [
          EVENT_TYPES.CONTAINER_CREATED,
          EVENT_TYPES.LOADED_ON_SHIP,
          EVENT_TYPES.ARRIVED_AT_PORT,
          EVENT_TYPES.UNLOADED_FROM_SHIP,
        ].includes(event.eventType)
      )
      .map((event) => ({
        eventId: event.eventId,
        version: event.version,
        eventType: event.eventType,
        timestamp: event.timestamp,
        epoch: toEpoch(event.timestamp),
        label: event.payload.location ?? event.payload.portName ?? event.payload.origin ?? null,
      }));

    const temperatures = readings.map((reading) => reading.temperatureC).filter((value) => value !== null);

    return {
      aggregateId,
      unit: 'celsius',
      range: { minTemperatureC, maxTemperatureC },
      readings,
      markers,
      summary: {
        readingCount: readings.length,
        breachCount: readings.filter((reading) => reading.isBreach).length,
        minObservedC: temperatures.length > 0 ? Math.min(...temperatures) : null,
        maxObservedC: temperatures.length > 0 ? Math.max(...temperatures) : null,
        averageC:
          temperatures.length > 0
            ? Number((temperatures.reduce((sum, value) => sum + value, 0) / temperatures.length).toFixed(2))
            : null,
        firstReadingAt: readings[0]?.timestamp ?? null,
        lastReadingAt: readings[readings.length - 1]?.timestamp ?? null,
      },
      truncatedAt: at,
    };
  }
}
