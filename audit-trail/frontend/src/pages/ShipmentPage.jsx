import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useHistoricalState,
  useIntegrity,
  useReconciliation,
  useSensorSeries,
  useShipment,
  useShipmentEvents,
} from '../hooks/useShipmentData.js';
import { ShipmentStoreProvider, useShipmentStore } from '../store/shipmentStore.jsx';
import { EventTimeline } from '../components/EventTimeline.jsx';
import { StateScrubber } from '../components/StateScrubber.jsx';
import { SensorChart } from '../components/SensorChart.jsx';
import { CommandPanel } from '../components/CommandPanel.jsx';
import {
  ConflictDialog,
  ConsistencyBanner,
  IntegrityBadge,
  ReconciliationPanel,
  ShipmentSummary,
} from '../components/ShipmentPanels.jsx';
import { ErrorBlock, LoadingBlock } from '../components/StatusBlocks.jsx';
import { ErrorBoundary } from '../components/ErrorBoundary.jsx';
import { formatTimestamp } from '../utils/format.js';
import { downloadAuditHistory } from '../utils/exportAudit.js';

export function ShipmentPage() {
  const { id } = useParams();
  return (
    <ShipmentStoreProvider key={id} shipmentId={id}>
      <ShipmentWorkspace shipmentId={id} />
    </ShipmentStoreProvider>
  );
}

/**
 * The forensic workspace.
 *
 * The whole page reads from one store, which is what keeps the four panels
 * telling the same story: when the scrubber moves, the summary, the timeline
 * and the chart all switch to the same instant together. Letting each panel
 * hold its own idea of "when" is exactly how a dashboard ends up showing a
 * current temperature beside a historical state.
 */
function ShipmentWorkspace({ shipmentId }) {
  const store = useShipmentStore();
  const refreshToken = store.lastCommandAt;

  const shipmentQuery = useShipment(shipmentId, refreshToken);
  const eventsQuery = useShipmentEvents(shipmentId, refreshToken);
  const historicalQuery = useHistoricalState(shipmentId, store.isHistorical ? store.scrubAt : null);
  const sensorQuery = useSensorSeries(shipmentId, store.isHistorical ? store.scrubAt : null, refreshToken);
  const integrityQuery = useIntegrity(shipmentId, refreshToken);
  const reconciliationQuery = useReconciliation(shipmentId, refreshToken);

  const events = eventsQuery.data?.events ?? [];
  const bounds = eventsQuery.data?.bounds ?? null;

  /**
   * The one place "what am I looking at" is decided. Everything downstream
   * receives the answer rather than working it out again.
   */
  const displayed = useMemo(() => {
    if (store.isHistorical && historicalQuery.data) {
      const historical = historicalQuery.data;
      if (!historical.existedAt) return { shipment: null, mode: 'HISTORICAL', existedAt: false };
      return {
        shipment: { ...historical.state, currentVersion: historical.state.version },
        mode: 'HISTORICAL',
        existedAt: true,
      };
    }
    return { shipment: shipmentQuery.data?.shipment ?? null, mode: 'LIVE', existedAt: true };
  }, [store.isHistorical, historicalQuery.data, shipmentQuery.data]);

  const reload = () => {
    store.dismissConflict();
    store.commandSucceeded();
  };

  if (shipmentQuery.isLoading && !shipmentQuery.data) {
    return (
      <div className="panel">
        <LoadingBlock label={`Loading ${shipmentId}`} lines={4} />
      </div>
    );
  }

  if (shipmentQuery.isError) {
    return (
      <div className="panel">
        <ErrorBlock error={shipmentQuery.error} onRetry={shipmentQuery.refetch} />
        <div className="panel__body" style={{ paddingTop: 0 }}>
          <Link className="btn btn--sm" to="/">
            Back to all shipments
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 16 }}>
        <Link className="eyebrow" to="/">
          ← All shipments
        </Link>
      </div>

      <ConsistencyBanner consistency={shipmentQuery.data?.consistency} />

      {store.isHistorical ? (
        <div className="banner banner--historical" role="status">
          <span className="pill pill--violet">
            <span className="pill__dot" />
            Historical
          </span>
          <span>
            Showing this shipment as it was at {formatTimestamp(store.scrubAt)}. Commands are disabled while
            you are looking at the past.
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn--sm" onClick={store.returnToLive}>
            Return to live
          </button>
        </div>
      ) : null}

      <div className="workspace">
        <div className="stack">
          <div className="panel">
            {displayed.existedAt ? (
              <ShipmentSummary shipment={displayed.shipment} mode={displayed.mode} at={store.scrubAt} />
            ) : (
              <div className="panel__body">
                <p className="eyebrow" style={{ color: 'var(--signal-violet)' }}>
                  Nothing existed yet
                </p>
                <p style={{ margin: 0, color: 'var(--paper-dim)' }}>
                  No shipment state existed at {formatTimestamp(store.scrubAt)} — the first event had not
                  happened yet.
                </p>
              </div>
            )}
          </div>

          <div className={`panel ${store.isHistorical ? 'scrubber--engaged' : ''}`}>
            <div className="panel__head">
              <h2 className="panel__title">Time scrubber</h2>
              <span className="spacer" />
              {historicalQuery.isLoading ? <span className="eyebrow">Reconstructing…</span> : null}
            </div>
            <StateScrubber
              bounds={bounds}
              scrubAt={store.scrubAt}
              isHistorical={store.isHistorical}
              onScrub={store.scrubTo}
              onReturnToLive={store.returnToLive}
              events={events}
            />
          </div>

          <ErrorBoundary>
            <div className="panel">
              <div className="panel__head">
                <h2 className="panel__title">Temperature against the event timeline</h2>
                <span className="spacer" />
                {sensorQuery.data?.summary ? (
                  <span className="eyebrow mono">
                    {sensorQuery.data.summary.readingCount} readings ·{' '}
                    {sensorQuery.data.summary.breachCount} breaches
                  </span>
                ) : null}
              </div>
              {sensorQuery.isLoading && !sensorQuery.data ? (
                <LoadingBlock label="Loading sensor data" lines={2} />
              ) : sensorQuery.isError ? (
                <ErrorBlock error={sensorQuery.error} onRetry={sensorQuery.refetch} />
              ) : (
                <SensorChart
                  series={sensorQuery.data}
                  selectedEventId={store.selectedEventId}
                  onSelectEvent={store.selectEvent}
                />
              )}
            </div>
          </ErrorBoundary>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Append a command</h2>
            </div>
            <CommandPanel
              shipment={shipmentQuery.data?.shipment}
              disabled={store.isHistorical}
              disabledReason="Return to the live view before appending events. A command issued from a historical view would carry a version that is no longer current."
              onCommandSucceeded={store.commandSucceeded}
              onConflict={store.commandConflicted}
            />
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Immutable event history</h2>
              <span className="pill pill--teal">New</span>
              <span className="spacer" />
              <span className="eyebrow mono">{events.length} events</span>
            </div>
            <div className="export-actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => downloadAuditHistory(shipmentId, events, 'json')}
                disabled={events.length === 0}
              >
                Export JSON
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => downloadAuditHistory(shipmentId, events, 'csv')}
                disabled={events.length === 0}
              >
                Export CSV
              </button>
            </div>
            {eventsQuery.isLoading && events.length === 0 ? (
              <LoadingBlock label="Loading events" lines={5} />
            ) : eventsQuery.isError ? (
              <ErrorBlock error={eventsQuery.error} onRetry={eventsQuery.refetch} />
            ) : (
              <EventTimeline
                events={events}
                selectedEventId={store.selectedEventId}
                onSelect={store.selectEvent}
                cutoffAt={store.isHistorical ? store.scrubAt : null}
              />
            )}
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Chain integrity</h2>
            </div>
            <IntegrityBadge integrity={integrityQuery.data} isLoading={integrityQuery.isLoading} />
          </div>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Read model reconciliation</h2>
            </div>
            <ReconciliationPanel
              reconciliation={reconciliationQuery.data}
              isLoading={reconciliationQuery.isLoading}
              isError={reconciliationQuery.isError}
              onRetry={reconciliationQuery.refetch}
            />
          </div>
        </div>
      </div>

      <ConflictDialog conflict={store.conflict} onReload={reload} onDismiss={store.dismissConflict} />
    </>
  );
}
