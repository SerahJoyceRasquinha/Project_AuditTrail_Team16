import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../services/apiClient.js';

/**
 * A small async-resource hook.
 *
 * It exists because every panel on this dashboard needs the same four states -
 * idle, loading, error, data - and the roadmap asks for loading/empty/error
 * handling everywhere. Writing that four times invites three of them to drift.
 *
 * Two details that are easy to get wrong and matter here:
 *
 *  - **Abort on change.** The scrubber fires a request per slider movement.
 *    Without aborting, a slow early response can land after a fast later one
 *    and paint a state the user has already moved past.
 *  - **Ignore stale resolutions.** Even aborted requests can resolve in flight,
 *    so each run is tagged and only the newest may write to state.
 */
export function useAsyncResource(loader, dependencies, { enabled = true, keepPreviousData = false } = {}) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });
  const runIdRef = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const run = useCallback(async () => {
    if (!enabled) {
      setState({ status: 'idle', data: null, error: null });
      return undefined;
    }

    const runId = (runIdRef.current += 1);
    const controller = new AbortController();

    setState((previous) => ({
      status: 'loading',
      data: keepPreviousData ? previous.data : null,
      error: null,
    }));

    try {
      const data = await loaderRef.current(controller.signal);
      if (runId === runIdRef.current) setState({ status: 'success', data, error: null });
    } catch (error) {
      if (error.name === 'AbortError') return undefined;
      if (runId === runIdRef.current) setState({ status: 'error', data: null, error });
    }

    return () => controller.abort();
  }, [enabled, keepPreviousData]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    if (!enabled) {
      setState({ status: 'idle', data: null, error: null });
      return () => controller.abort();
    }

    const runId = (runIdRef.current += 1);
    setState((previous) => ({
      status: 'loading',
      data: keepPreviousData ? previous.data : null,
      error: null,
    }));

    loaderRef
      .current(controller.signal)
      .then((data) => {
        if (!cancelled && runId === runIdRef.current) setState({ status: 'success', data, error: null });
      })
      .catch((error) => {
        if (error.name === 'AbortError' || cancelled) return;
        if (runId === runIdRef.current) setState({ status: 'error', data: null, error });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);

  return { ...state, refetch: run, isLoading: state.status === 'loading', isError: state.status === 'error' };
}

export function useShipmentList({ search, page = 1, pageSize = 20, refreshToken }) {
  return useAsyncResource(
    (signal) => api.listShipments({ search, page, pageSize }, signal),
    [search, page, pageSize, refreshToken],
    { keepPreviousData: true }
  );
}

export function useShipment(shipmentId, refreshToken) {
  return useAsyncResource((signal) => api.getShipment(shipmentId, signal), [shipmentId, refreshToken], {
    enabled: Boolean(shipmentId),
  });
}

export function useShipmentEvents(shipmentId, refreshToken) {
  return useAsyncResource(
    (signal) => api.getShipmentEvents(shipmentId, signal),
    [shipmentId, refreshToken],
    { enabled: Boolean(shipmentId), keepPreviousData: true }
  );
}

/** Only fetches while the scrubber is engaged; live mode uses the current state. */
export function useHistoricalState(shipmentId, at) {
  return useAsyncResource(
    (signal) => api.getHistoricalState(shipmentId, at, signal),
    [shipmentId, at],
    { enabled: Boolean(shipmentId && at), keepPreviousData: true }
  );
}

/**
 * The sensor series is fetched with the same `at` bound as the historical
 * state, so the chart can never show a live temperature next to a historical
 * state - the mismatch roadmap 13.6 calls out.
 */
export function useSensorSeries(shipmentId, at, refreshToken) {
  return useAsyncResource(
    (signal) => api.getSensorSeries(shipmentId, at, signal),
    [shipmentId, at, refreshToken],
    { enabled: Boolean(shipmentId), keepPreviousData: true }
  );
}

export function useIntegrity(shipmentId, refreshToken) {
  return useAsyncResource((signal) => api.getIntegrity(shipmentId, signal), [shipmentId, refreshToken], {
    enabled: Boolean(shipmentId),
  });
}

/**
 * Polls the worker while the read model is behind.
 *
 * This is what turns eventual consistency from a confusing UI glitch into a
 * visible, self-resolving "synchronising" state (roadmap 12.6).
 */
export function useWorkerStatus({ intervalMs = 4000, active = true } = {}) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const controller = new AbortController();

    const poll = async () => {
      try {
        const data = await api.getWorkerStatus(controller.signal);
        if (!cancelled) setStatus(data);
      } catch {
        // A transient failure here must never break the dashboard; the banner
        // simply stays as it was.
      }
    };

    poll();
    const timer = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [intervalMs, active]);

  return status;
}

/** Debounces a rapidly-changing value, used for the search box and the slider. */
export function useDebouncedValue(value, delayMs = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Wraps a command call, routing 409s into the store's conflict state. */
export function useCommand({ onSuccess, onConflict }) {
  const [state, setState] = useState({ pending: false, error: null, result: null });

  const execute = useCallback(
    async (commandFn) => {
      setState({ pending: true, error: null, result: null });
      try {
        const result = await commandFn();
        setState({ pending: false, error: null, result });
        onSuccess?.(result);
        return result;
      } catch (error) {
        setState({ pending: false, error, result: null });
        if (error.isConflict) onConflict?.(error);
        return null;
      }
    },
    [onSuccess, onConflict]
  );

  return useMemo(() => ({ ...state, execute }), [state, execute]);
}
