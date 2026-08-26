import { EventEmitter } from 'node:events';

/**
 * The read-side notification bus.
 *
 * What this is for
 * ----------------
 * The dashboard used to discover that something had changed by polling. That
 * works, but it means a stage confirmed in one browser tab takes up to a poll
 * interval to appear in another, and it puts a constant floor of requests under
 * an idle system. The requirement asks for genuine near-real-time updates and
 * explicitly rules out faking it with a page refresh.
 *
 * What this is *not* for
 * ----------------------
 * It is not a second write path, and nothing subscribes to it in order to
 * change state. It carries notifications only - "shipment SHP-4 reached version
 * 9" - and the browser responds by re-running its ordinary queries. So the read
 * model stays the thing being read, the Event Store stays authoritative, and
 * CQRS is intact: this is a hint that a query is worth repeating, not a channel
 * for data.
 *
 * Notifications are published by the **projection worker**, after it has
 * committed the projection - not by the command service at append time. That
 * ordering matters. Telling the UI about an event before the read model can
 * serve it would guarantee the refetch races the projection and sometimes loses,
 * which is precisely the confusing eventual-consistency glitch the project is
 * careful to surface honestly rather than hide.
 */
export class ShipmentEventBus {
  #emitter = new EventEmitter();
  #logger;

  constructor({ logger } = {}) {
    this.#logger = logger;
    // The dashboard can hold a good number of open streams; the default of 10
    // would log spurious leak warnings.
    this.#emitter.setMaxListeners(0);
  }

  publish(notification) {
    const payload = {
      ...notification,
      publishedAt: new Date().toISOString(),
    };
    this.#emitter.emit('shipment', payload);
    if (notification.aggregateId) {
      this.#emitter.emit(`shipment:${notification.aggregateId}`, payload);
    }
    return payload;
  }

  /**
   * Subscribes to every shipment, or to one.
   *
   * Returns an unsubscribe function. Callers are expected to call it on
   * connection close - the SSE route does, on both `close` and `error`, because
   * a listener left attached to a dead response is a memory leak that only
   * shows up under load.
   */
  subscribe(listener, { aggregateId = null } = {}) {
    const channel = aggregateId ? `shipment:${aggregateId}` : 'shipment';
    this.#emitter.on(channel, listener);
    return () => this.#emitter.off(channel, listener);
  }

  get subscriberCount() {
    return this.#emitter
      .eventNames()
      .reduce((total, name) => total + this.#emitter.listenerCount(name), 0);
  }
}
