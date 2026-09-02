import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as api from '../services/apiClient.js';
import {
  useAsyncResource,
  useCommand,
  useHistoricalState,
  useIntegrity,
  useReconciliation,
  useSensorSeries,
  useShipment,
  useShipmentEvents,
} from '../hooks/useShipmentData.js';
import { useShipmentStream } from '../hooks/useShipmentStream.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ShipmentStoreProvider, useShipmentStore } from '../store/shipmentStore.jsx';
import { EventTimeline } from '../components/EventTimeline.jsx';
import { AuditLogToolbar, filterAuditEvents } from '../components/AuditLogToolbar.jsx';
import { StateScrubber } from '../components/StateScrubber.jsx';
import { SensorChart } from '../components/SensorChart.jsx';
import { LifecyclePlanner } from '../components/LifecyclePlanner.jsx';
import {
  ConfirmDialog,
  ConflictDialog,
  ConsistencyBanner,
  IntegrityBadge,
  ReconciliationPanel,
  ShipmentSummary,
} from '../components/ShipmentPanels.jsx';
import { ShipmentFormDialog } from '../components/ShipmentFormDialog.jsx';
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
  /**
   * Role drives presentation only. Every management control below is hidden
   * from a read-only account, and every one of them is independently refused
   * by the backend if it is somehow invoked anyway.
   */
  const { isOperator } = useAuth();
  const refreshToken = store.lastCommandAt;

  const [dialog, setDialog] = useState(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const [exportingFormat, setExportingFormat] = useState(null);
  const [auditSearch, setAuditSearch] = useState('');
  const [auditEventType, setAuditEventType] = useState('ALL');
  const [breachOnly, setBreachOnly] = useState(false);

  const shipmentQuery = useShipment(shipmentId, refreshToken);
  const eventsQuery = useShipmentEvents(shipmentId, refreshToken);
  const historicalQuery = useHistoricalState(shipmentId, store.isHistorical ? store.scrubAt : null);
  const sensorQuery = useSensorSeries(shipmentId, store.isHistorical ? store.scrubAt : null, refreshToken);
  const integrityQuery = useIntegrity(shipmentId, refreshToken);
  const reconciliationQuery = useReconciliation(shipmentId, refreshToken);
  const scheduleQuery = useAsyncResource(
    (signal) => api.getShipmentSchedule(shipmentId, signal),
    [shipmentId, refreshToken],
    { enabled: Boolean(shipmentId), keepPreviousData: true }
  );

  /**
   * Near-real-time updates.
   *
   * The stream carries notifications, not data: when it says this shipment
   * reached a new version, the page re-runs the queries it already had. If the
   * stream cannot connect, `connected` is false and the existing refresh path
   * still works - so the dashboard degrades to its previous behaviour rather
   * than going quiet.
   */
  const stream = useShipmentStream({
    shipmentId,
    onNotification: () => store.commandSucceeded(),
  });

  const events = eventsQuery.data?.events ?? [];
  const filteredEvents = useMemo(
    () => filterAuditEvents(events, auditSearch, auditEventType, breachOnly),
    [events, auditSearch, auditEventType, breachOnly]
  );
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

  const live = shipmentQuery.data?.shipment ?? null;
  const isArchived = Boolean(live?.archived);

  /**
   * The monitoring window, read the same way the backend derives it: a
   * shipment is sampled from creation until it is unloaded, and never while
   * archived. Nothing here decides anything - it only lets the temperature
   * panel explain itself when it has no readings to draw.
   */
  const monitoringStopped = Boolean(live && (live.archived || live.currentState === 'UNLOADED'));

  /**
   * Every management action ends the same way: `store.commandSucceeded()`
   * bumps the refresh token every query on this page depends on, so the
   * summary, the timeline, the chart and the integrity badge all refetch
   * together. Nothing reloads the application, and nothing is patched into
   * local state behind the backend's back.
   */
  const archival = useCommand({
    onSuccess: (result) => {
      setNotice(
        result.eventType === 'SHIPMENT_ARCHIVED'
          ? `Archived as version ${result.version}. Every event below is unchanged.`
          : `Restored as version ${result.version}.`
      );
      setDialog(null);
      setReason('');
      store.commandSucceeded();
    },
    onConflict: (error) => {
      setDialog(null);
      store.commandConflicted(error);
    },
  });

  const confirmArchival = () => {
    const command = {
      shipmentId,
      reason: reason.trim() || null,
      expectedVersion: live?.currentVersion,
    };
    archival.execute(() =>
      dialog === 'archive' ? api.archiveShipment(command) : api.restoreShipment(command)
    );
  };

  const onAmended = (result) => {
    setNotice(`Amended as version ${result.version} - the correction is now the newest event below.`);
    store.commandSucceeded();
  };

  const exportHistory = async (format) => {
    setExportingFormat(format);
    try {
      await api.exportShipment(shipmentId, format);
      setNotice(`${format.toUpperCase()} audit report downloaded. It contains the complete immutable event history.`);
    } catch (error) {
      setNotice(`Could not download the ${format.toUpperCase()} audit report: ${error.message}`);
    } finally {
      setExportingFormat(null);
    }
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
      <div className="shipment-toolbar">
        <Link className="eyebrow" to="/shipments">
          ← All shipments
        </Link>
        <span className="spacer" />
        <span className="eyebrow" title={stream.connected ? 'Updates arrive as they happen.' : 'Falling back to periodic refresh.'}>
          {stream.connected ? '● Live' : '○ Periodic refresh'}
        </span>

        {/* Management actions live here, beside the record they act on, rather
            than on a separate screen. They are disabled while the scrubber is
            engaged for the same reason the command panel is: a command issued
            from a historical view would carry a version that is no longer
            current. */}
        {/*
          Absent rather than disabled for a read-only account: a row of greyed
          out buttons invites someone to work out why they are greyed out,
          whereas a clean read-only view simply is what it is. The role pill
          in the header carries the explanation.
        */}
        {isOperator ? (
          <>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => setDialog('amend')}
              disabled={store.isHistorical || isArchived || !live}
              title={
                isArchived
                  ? 'Restore this shipment before amending it.'
                  : store.isHistorical
                    ? 'Return to the live view to amend this shipment.'
                    : undefined
              }
            >
              Edit details
            </button>
            {isArchived ? (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setReason('');
                  setDialog('restore');
                }}
                disabled={store.isHistorical || !live}
              >
                Restore
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => {
                  setReason('');
                  setDialog('archive');
                }}
                disabled={store.isHistorical || !live}
              >
                Archive
              </button>
            )}
          </>
        ) : (
          <span className="eyebrow" title="This account has read-only access to the ledger.">
            Read-only
          </span>
        )}
      </div>

      {notice ? (
        <div className="form-success ledger-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {/* An archived shipment is still fully readable - that is the whole
          claim being made - so the page says what changed and what did not. */}
      {isArchived && !store.isHistorical ? (
        <div className="banner banner--historical" role="status">
          <span className="pill pill--violet">
            <span className="pill__dot" />
            Archived
          </span>
          <span>
            Withdrawn from the active fleet. Nothing was deleted: the event history below, its hash chain
            and the time scrubber are all intact, and further commands are refused until it is restored.
          </span>
        </div>
      ) : null}

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
                {/*
                  Whether this container is still being sampled. Worth stating
                  beside the chart: a flat line on a delivered shipment means
                  monitoring ended, not that the temperature stopped changing.
                */}
                {live ? (
                  <span
                    className={`pill ${monitoringStopped ? 'pill--violet' : 'pill--teal'}`}
                    title={
                      monitoringStopped
                        ? 'This shipment has reached a state where it is no longer sampled.'
                        : 'Readings are taken automatically, hourly, for as long as this shipment is active.'
                    }
                  >
                    <span className="pill__dot" />
                    {monitoringStopped ? 'Monitoring ended' : 'Monitoring active'}
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
                  shipmentCreatedAt={live?.createdAt ?? null}
                  monitoringStopped={monitoringStopped}
                />
              )}
            </div>
          </ErrorBoundary>

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Shipment Schedule</h2>
              <span className="spacer" />
              {scheduleQuery.data?.isOverdue ? (
                <span className="pill pill--danger">
                  <span className="pill__dot" />
                  Overdue
                </span>
              ) : null}
            </div>
            <LifecyclePlanner
              shipmentId={shipmentId}
              schedule={scheduleQuery.data}
              disabled={!isOperator || store.isHistorical || isArchived}
              readOnly={!isOperator}
              disabledReason={
                !isOperator
                  ? 'Your account has read-only access. The schedule below is shown in full, but confirming or changing a stage requires an Operator account.'
                  : isArchived
                    ? 'This shipment is archived, so it accepts no further changes. Restore it to resume - its history is unchanged either way.'
                    : 'Return to the live view before making changes. A command issued from a historical view would carry a version that is no longer current.'
              }
              onChanged={store.commandSucceeded}
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
              <div className="export-actions">
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => exportHistory('csv')}
                  disabled={Boolean(exportingFormat)}
                >
                  {exportingFormat === 'csv' ? 'Preparing CSV…' : 'Export CSV'}
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => exportHistory('pdf')}
                  disabled={Boolean(exportingFormat)}
                >
                  {exportingFormat === 'pdf' ? 'Preparing PDF…' : 'Export PDF'}
                </button>
                <span className="eyebrow mono">{events.length} events · full history</span>
              </div>
            </div>
            <div className="export-actions">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => downloadAuditHistory(shipmentId, filteredEvents, 'json')}
                disabled={filteredEvents.length === 0}
              >
                Export JSON
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => downloadAuditHistory(shipmentId, filteredEvents, 'csv')}
                disabled={filteredEvents.length === 0}
              >
                Export CSV
              </button>
            </div>
            <AuditLogToolbar
              value={auditSearch}
              onChange={setAuditSearch}
              eventType={auditEventType}
              onTypeChange={setAuditEventType}
              breachOnly={breachOnly}
              onBreachOnlyChange={setBreachOnly}
              totalCount={events.length}
              filteredCount={filteredEvents.length}
            />
            {eventsQuery.isLoading && events.length === 0 ? (
              <LoadingBlock label="Loading events" lines={5} />
            ) : eventsQuery.isError ? (
              <ErrorBlock error={eventsQuery.error} onRetry={eventsQuery.refetch} />
            ) : (
              <EventTimeline
                events={filteredEvents}
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

      {isOperator && dialog === 'amend' ? (
        <ShipmentFormDialog
          mode="amend"
          shipment={live}
          onClose={() => setDialog(null)}
          onSucceeded={onAmended}
          onConflict={store.commandConflicted}
        />
      ) : null}

      <ConfirmDialog
        open={isOperator && (dialog === 'archive' || dialog === 'restore')}
        title={dialog === 'archive' ? `Archive ${shipmentId}?` : `Restore ${shipmentId}?`}
        body={
          dialog === 'archive'
            ? 'This appends a SHIPMENT_ARCHIVED event and withdraws the shipment from the active list. No event is deleted, and you can restore it at any time.'
            : 'This appends a SHIPMENT_RESTORED event and returns the shipment to the active list. The earlier archival stays on the record.'
        }
        confirmLabel={dialog === 'archive' ? 'Archive shipment' : 'Restore shipment'}
        tone={dialog === 'archive' ? 'danger' : 'primary'}
        pending={archival.pending}
        error={archival.error && !archival.error.isConflict ? archival.error : null}
        reason={reason}
        onReasonChange={setReason}
        onConfirm={confirmArchival}
        onCancel={() => setDialog(null)}
      />

      <ConflictDialog conflict={store.conflict} onReload={reload} onDismiss={store.dismissConflict} />
    </>
  );
}
