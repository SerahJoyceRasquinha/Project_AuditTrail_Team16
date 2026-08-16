import { createContext, useContext, useMemo, useReducer, useCallback } from 'react';

/**
 * Shipment workspace state (context + reducer).
 *
 * The dashboard has genuinely coupled state - a selected event, a scrub
 * position, a live-vs-historical mode - where changing one has to invalidate
 * others. Modelling that as five independent `useState` calls is how "current"
 * and "historical" views end up disagreeing on screen. A reducer makes each
 * transition a single named, testable operation instead.
 *
 * The central invariant it enforces: **the dashboard is either in LIVE mode or
 * in HISTORICAL mode, never ambiguously between them.** Roadmap "Mistake 10"
 * is precisely about a UI that shows current state while implying it is
 * historical, so the mode is one field and every transition sets it explicitly.
 */

export const VIEW_MODES = { LIVE: 'LIVE', HISTORICAL: 'HISTORICAL' };

const initialState = {
  shipmentId: null,
  viewMode: VIEW_MODES.LIVE,
  scrubAt: null,
  selectedEventId: null,
  conflict: null,
  lastCommandAt: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SELECT_SHIPMENT':
      // Selecting a different shipment resets everything derived from the old
      // one; carrying a scrub position across shipments would be meaningless.
      if (state.shipmentId === action.shipmentId) return state;
      return { ...initialState, shipmentId: action.shipmentId };

    case 'SELECT_EVENT':
      return { ...state, selectedEventId: action.eventId };

    case 'SCRUB_TO':
      return {
        ...state,
        viewMode: VIEW_MODES.HISTORICAL,
        scrubAt: action.at,
        // A scrub position and a selected event are two different claims about
        // "what am I looking at", so entering scrub mode clears the selection.
        selectedEventId: null,
      };

    case 'RETURN_TO_LIVE':
      return { ...state, viewMode: VIEW_MODES.LIVE, scrubAt: null };

    case 'COMMAND_SUCCEEDED':
      // Bumping this timestamp is what tells the data hooks to refetch.
      return { ...state, conflict: null, lastCommandAt: action.at ?? new Date().toISOString() };

    case 'COMMAND_CONFLICTED':
      return { ...state, conflict: action.conflict };

    case 'DISMISS_CONFLICT':
      return { ...state, conflict: null };

    default:
      return state;
  }
}

const ShipmentStoreContext = createContext(null);

export function ShipmentStoreProvider({ children, shipmentId = null }) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, shipmentId });

  const actions = useMemo(
    () => ({
      selectShipment: (id) => dispatch({ type: 'SELECT_SHIPMENT', shipmentId: id }),
      selectEvent: (eventId) => dispatch({ type: 'SELECT_EVENT', eventId }),
      scrubTo: (at) => dispatch({ type: 'SCRUB_TO', at }),
      returnToLive: () => dispatch({ type: 'RETURN_TO_LIVE' }),
      commandSucceeded: () => dispatch({ type: 'COMMAND_SUCCEEDED', at: new Date().toISOString() }),
      commandConflicted: (conflict) => dispatch({ type: 'COMMAND_CONFLICTED', conflict }),
      dismissConflict: () => dispatch({ type: 'DISMISS_CONFLICT' }),
    }),
    []
  );

  const value = useMemo(
    () => ({
      ...state,
      isHistorical: state.viewMode === VIEW_MODES.HISTORICAL,
      ...actions,
    }),
    [state, actions]
  );

  return <ShipmentStoreContext.Provider value={value}>{children}</ShipmentStoreContext.Provider>;
}

export function useShipmentStore() {
  const context = useContext(ShipmentStoreContext);
  if (!context) {
    throw new Error('useShipmentStore must be used inside a <ShipmentStoreProvider>.');
  }
  return context;
}

/** Exported for direct unit testing of the transitions. */
export { reducer as shipmentReducer, initialState as shipmentInitialState };

/** Convenience hook for components that only need to change the scrub position. */
export function useScrubber() {
  const { scrubAt, isHistorical, scrubTo, returnToLive } = useShipmentStore();
  return useMemo(
    () => ({ scrubAt, isHistorical, scrubTo, returnToLive }),
    [scrubAt, isHistorical, scrubTo, returnToLive]
  );
}

export const useStableCallback = (fn) => useCallback(fn, [fn]);
