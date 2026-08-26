import { useEffect, useRef, useState } from 'react';

/**
 * Near-real-time updates over server-sent events.
 *
 * The requirement is explicit that real-time behaviour must not be faked by
 * refreshing the page, and equally explicit that it must not violate CQRS. So
 * this subscribes to a *notification* stream, not a data stream: each message
 * says which shipment reached which version, and the component responds by
 * re-running the ordinary queries it already had. Nothing is pushed into the UI
 * that did not come back through a normal read path.
 *
 * Two things it is careful about:
 *
 *  - **It degrades rather than breaks.** If the stream cannot be opened - the
 *    backend has realtime disabled, a proxy strips the connection, the browser
 *    is offline - `connected` goes false and the caller falls back to the
 *    polling it used before. A dashboard that silently stops updating is worse
 *    than one that polls.
 *  - **It does not reconnect forever.** Attempts back off and stop after a
 *    ceiling, so a permanently disabled endpoint does not turn into an infinite
 *    reconnect loop against the server.
 */
export function useShipmentStream({ shipmentId = null, onNotification, enabled = true } = {}) {
  const [connected, setConnected] = useState(false);
  const [lastNotification, setLastNotification] = useState(null);
  const handlerRef = useRef(onNotification);
  handlerRef.current = onNotification;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof window.EventSource !== 'function') {
      setConnected(false);
      return undefined;
    }

    let source = null;
    let attempts = 0;
    let retryTimer = null;
    let closed = false;

    const base = import.meta.env?.VITE_API_BASE_URL ?? '';
    const query = shipmentId ? `?shipmentId=${encodeURIComponent(shipmentId)}` : '';

    const connect = () => {
      if (closed) return;

      try {
        source = new EventSource(`${base}/api/stream/shipments${query}`);
      } catch {
        setConnected(false);
        return;
      }

      source.addEventListener('connected', () => {
        attempts = 0;
        setConnected(true);
      });

      source.addEventListener('shipment', (message) => {
        try {
          const notification = JSON.parse(message.data);
          setLastNotification(notification);
          // The component re-queries; the notification itself is never rendered
          // as data.
          handlerRef.current?.(notification);
        } catch {
          // A malformed frame must not take the dashboard down with it.
        }
      });

      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (closed) return;

        attempts += 1;
        if (attempts > 5) return; // Give up; the caller keeps polling.
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** attempts, 15_000));
      };
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      source?.close();
      setConnected(false);
    };
  }, [shipmentId, enabled]);

  return { connected, lastNotification };
}
