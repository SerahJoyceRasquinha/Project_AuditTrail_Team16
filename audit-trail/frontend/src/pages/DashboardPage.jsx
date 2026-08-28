import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import * as api from '../services/apiClient.js';
import {
  useCommand,
  useDebouncedValue,
  useLedgerSync,
  useShipmentList,
} from '../hooks/useShipmentData.js';
import { EmptyBlock, ErrorBlock, LoadingBlock } from '../components/StatusBlocks.jsx';
import { ShipmentFormDialog } from '../components/ShipmentFormDialog.jsx';
import { ConfirmDialog, ConflictDialog } from '../components/ShipmentPanels.jsx';
import { formatRelative, formatTemperature, stateLabel } from '../utils/format.js';
import { useAuth } from '../auth/AuthContext.jsx';

/**
 * The dashboard (roadmap 9.7, Week 1).
 *
 * The search bar is the entry point the source document names: look up a
 * specific shipment ID. The list below it exists so the tool is usable before
 * you know which ID you are investigating.
 *
 * Shipment management is built *into* that workflow rather than beside it: the
 * create action sits next to the search box, and each card carries its own
 * actions. There is no separate "admin" screen, because there is no separate
 * concept - creating and amending a shipment are commands like any other.
 */
const EMPTY_FILTERS = {
  state: '',
  origin: '',
  destination: '',
  hasBreach: '',
  minTemperature: '',
  maxTemperature: '',
  lastEventFrom: '',
  lastEventTo: '',
};

const VIEWS = [
  { id: 'active', label: 'Active' },
  { id: 'archived', label: 'Archived' },
  { id: 'all', label: 'All' },
];

export function DashboardPage() {
  const navigate = useNavigate();
  /**
   * Presentation only. Every control gated on this is also refused by the
   * backend, so the gate here is about giving a read-only account a coherent
   * screen rather than about stopping anything.
   */
  const { isOperator } = useAuth();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [view, setView] = useState('active');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [dialog, setDialog] = useState(null);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const [conflict, setConflict] = useState(null);

  const debouncedSearch = useDebouncedValue(search, 250);
  const hasFilters = Object.values(filters).some(Boolean);

  // Bumped after every successful command, then bumped again once the
  // projection worker has caught up - so the list converges on its own.
  const { token: syncToken, sync, settling } = useLedgerSync();

  const { data, status, error, refetch, isLoading } = useShipmentList({
    search: debouncedSearch || undefined,
    page,
    pageSize: 12,
    view,
    refreshToken: syncToken,
    ...filters,
  });

  const shipments = data?.items ?? [];
  const pagination = data?.pagination;

  const archival = useCommand({
    onSuccess: (result) => {
      const archived = result.eventType === 'SHIPMENT_ARCHIVED';
      setNotice({
        text: archived
          ? `${result.aggregateId} archived as version ${result.version}. Its history is untouched - find it under Archived.`
          : `${result.aggregateId} restored as version ${result.version}.`,
      });
      setDialog(null);
      setReason('');
      sync();
    },
    onConflict: (conflictError) => {
      setConflict(conflictError);
      setDialog(null);
    },
  });

  function updateFilter(name, value) {
    setFilters((current) => ({ ...current, [name]: value }));
    setPage(1);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  function onCreated(result) {
    setNotice({
      text: `${result.aggregateId} created - CONTAINER_CREATED appended as version ${result.version}.`,
    });
    sync();
    // Straight to the forensic view of the thing just created. That page reads
    // through the query handler, which replays the events when the projection
    // is behind, so the new shipment is visible immediately rather than after
    // the worker's next poll.
    navigate(`/shipment/${encodeURIComponent(result.aggregateId)}`);
  }

  function onAmended(result) {
    setNotice({
      text: `${result.aggregateId} amended - SHIPMENT_DETAILS_AMENDED appended as version ${result.version}.`,
    });
    sync();
  }

  const confirmArchival = () => {
    const shipment = dialog?.shipment;
    if (!shipment) return;
    const command = {
      shipmentId: shipment.aggregateId,
      reason: reason.trim() || null,
      expectedVersion: shipment.currentVersion,
    };
    archival.execute(() =>
      dialog.kind === 'archive' ? api.archiveShipment(command) : api.restoreShipment(command)
    );
  };

  return (
    <>
      <div className="search">
        <input
          className="input search__input"
          value={search}
          onChange={(bubble) => {
            setSearch(bubble.target.value);
            setPage(1);
          }}
          placeholder="Search by shipment ID or container code - e.g. SHP-1001"
          aria-label="Search shipments"
          spellCheck={false}
        />
        <button type="button" className="btn" onClick={refetch}>
          Refresh
        </button>
        {isOperator ? (
          <button type="button" className="btn btn--primary" onClick={() => setDialog({ kind: 'create' })}>
            New shipment
          </button>
        ) : null}
      </div>

      <div className="ledger-toolbar">
        <div className="view-tabs" role="tablist" aria-label="Shipment view">
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={view === option.id}
              className={`btn btn--sm ${view === option.id ? 'btn--primary' : 'btn--ghost'}`}
              onClick={() => {
                setView(option.id);
                setPage(1);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {settling ? (
          <span className="pill pill--amber">
            <span className="pill__dot" />
            Synchronising projection
          </span>
        ) : null}
      </div>

      {notice ? (
        <div className="form-success ledger-notice" role="status">
          <span>{notice.text}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <div className="filter-panel">
        <div className="filter-panel__head">
          <button
            type="button"
            className="btn btn--ghost filter-panel__toggle"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
          >
            <span aria-hidden="true">{filtersOpen ? '\u2212' : '+'}</span>
            Filters {hasFilters ? `\u00b7 ${Object.values(filters).filter(Boolean).length} active` : ''}
          </button>
          {hasFilters ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={clearFilters}>
              Clear all
            </button>
          ) : null}
        </div>

        {filtersOpen ? (
          <div className="filter-panel__body">
            <label className="field">
              <span className="field__label">Lifecycle status</span>
              <select className="select" value={filters.state} onChange={(event) => updateFilter('state', event.target.value)}>
                <option value="">Any status</option>
                <option value="CREATED">Created</option>
                <option value="IN_TRANSIT">In transit</option>
                <option value="AT_PORT">At port</option>
                <option value="UNLOADED">Unloaded</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Origin</span>
              <input className="input" value={filters.origin} onChange={(event) => updateFilter('origin', event.target.value)} placeholder="e.g. Chennai" />
            </label>
            <label className="field">
              <span className="field__label">Destination</span>
              <input className="input" value={filters.destination} onChange={(event) => updateFilter('destination', event.target.value)} placeholder="e.g. Rotterdam" />
            </label>
            <label className="field">
              <span className="field__label">Temperature breaches</span>
              <select className="select" value={filters.hasBreach} onChange={(event) => updateFilter('hasBreach', event.target.value)}>
                <option value="">Any reading</option>
                <option value="true">Breaches only</option>
                <option value="false">No breaches</option>
              </select>
            </label>
            <label className="field">
              <span className="field__label">Latest temperature, min °C</span>
              <input className="input" type="number" value={filters.minTemperature} onChange={(event) => updateFilter('minTemperature', event.target.value)} placeholder="e.g. -10" />
            </label>
            <label className="field">
              <span className="field__label">Latest temperature, max °C</span>
              <input className="input" type="number" value={filters.maxTemperature} onChange={(event) => updateFilter('maxTemperature', event.target.value)} placeholder="e.g. 8" />
            </label>
            <label className="field">
              <span className="field__label">Last event after</span>
              <input className="input" type="date" value={filters.lastEventFrom} onChange={(event) => updateFilter('lastEventFrom', event.target.value)} />
            </label>
            <label className="field">
              <span className="field__label">Last event before</span>
              <input className="input" type="date" value={filters.lastEventTo} onChange={(event) => updateFilter('lastEventTo', event.target.value)} />
            </label>
          </div>
        ) : null}
      </div>

      {isLoading && shipments.length === 0 ? (
        <div className="panel">
          <LoadingBlock label="Loading shipments" lines={4} />
        </div>
      ) : null}

      {status === 'error' ? (
        <div className="panel">
          <ErrorBlock error={error} onRetry={refetch} />
        </div>
      ) : null}

      {status === 'success' && shipments.length === 0 ? (
        <div className="panel">
          <EmptyBlock
            title={
              debouncedSearch || hasFilters
                ? 'No shipment matches these filters'
                : view === 'archived'
                  ? 'Nothing has been archived'
                  : 'The ledger is empty'
            }
            message={
              debouncedSearch || hasFilters
                ? 'Adjust the search or filters, or clear them to see more of the ledger.'
                : view === 'archived'
                  ? 'Archived shipments stay here with their full history intact. Nothing has been withdrawn from the active fleet yet.'
                  : isOperator
                    ? 'Create the first shipment to append its CONTAINER_CREATED event and open its audit trail.'
                    : 'No shipments have been created yet. An Operator account can add the first one.'
            }
            action={
              isOperator && !debouncedSearch && !hasFilters && view !== 'archived' ? (
                <button type="button" className="btn btn--primary" onClick={() => setDialog({ kind: 'create' })}>
                  Create a shipment
                </button>
              ) : null
            }
          />
        </div>
      ) : null}

      {shipments.length > 0 ? (
        <>
          <div className="shipment-grid">
            {shipments.map((shipment) => (
              <article
                key={shipment.aggregateId}
                className={[
                  'shipment-card',
                  shipment.temperatureExcursion ? 'shipment-card--breach' : '',
                  shipment.archived ? 'shipment-card--archived' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Link
                  to={`/shipment/${encodeURIComponent(shipment.aggregateId)}`}
                  className="shipment-card__link"
                >
                  <div className="shipment-card__id">{shipment.aggregateId}</div>
                  <div className="shipment-card__route">
                    {shipment.origin} &rarr; {shipment.destination}
                  </div>
                  <div className="shipment-card__meta">
                    <span className={`pill ${shipment.archived ? 'pill--violet' : 'pill--teal'}`}>
                      <span className="pill__dot" />
                      {stateLabel(shipment.currentState)}
                    </span>
                    <span className="pill">v{shipment.currentVersion}</span>
                    {shipment.archived ? <span className="pill pill--violet">Archived</span> : null}
                    {shipment.temperatureExcursion ? (
                      <span className="pill pill--amber">
                        <span className="pill__dot" />
                        {shipment.temperatureBreachCount} breach
                        {shipment.temperatureBreachCount === 1 ? '' : 'es'}
                      </span>
                    ) : null}
                  </div>
                  <div className="eyebrow" style={{ marginTop: 10 }}>
                    {shipment.currentLocation ?? '\u2014'} &middot; {formatTemperature(shipment.latestTemperatureC)} &middot;
                    updated {formatRelative(shipment.lastEventAt)}
                  </div>
                </Link>

                <div className="shipment-card__actions">
                  <Link
                    className="btn btn--sm btn--ghost"
                    to={`/shipment/${encodeURIComponent(shipment.aggregateId)}`}
                  >
                    View details
                  </Link>
                  {!isOperator ? null : shipment.archived ? (
                    <button
                      type="button"
                      className="btn btn--sm btn--ghost"
                      onClick={() => {
                        setReason('');
                        setDialog({ kind: 'restore', shipment });
                      }}
                    >
                      Restore
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => setDialog({ kind: 'amend', shipment })}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn--sm btn--ghost"
                        onClick={() => {
                          setReason('');
                          setDialog({ kind: 'archive', shipment });
                        }}
                      >
                        Archive
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>

          {pagination && pagination.totalPages > 1 ? (
            <div className="pagination">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                disabled={pagination.page <= 1}
              >
                Previous
              </button>
              <span className="mono">
                Page {pagination.page} of {pagination.totalPages} &middot; {pagination.total} shipments
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setPage((current) => Math.min(current + 1, pagination.totalPages))}
                disabled={pagination.page >= pagination.totalPages}
              >
                Next
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {isOperator && dialog?.kind === 'create' ? (
        <ShipmentFormDialog
          mode="create"
          onClose={() => setDialog(null)}
          onSucceeded={onCreated}
          onConflict={setConflict}
        />
      ) : null}

      {isOperator && dialog?.kind === 'amend' ? (
        <ShipmentFormDialog
          mode="amend"
          shipment={dialog.shipment}
          onClose={() => setDialog(null)}
          onSucceeded={onAmended}
          onConflict={setConflict}
        />
      ) : null}

      <ConfirmDialog
        open={isOperator && (dialog?.kind === 'archive' || dialog?.kind === 'restore')}
        title={
          dialog?.kind === 'archive'
            ? `Archive ${dialog?.shipment?.aggregateId}?`
            : `Restore ${dialog?.shipment?.aggregateId}?`
        }
        body={
          dialog?.kind === 'archive'
            ? 'This withdraws the shipment from the active list by appending a SHIPMENT_ARCHIVED event. No event is deleted: the full history, the hash chain and the time scrubber all stay available, and you can restore it at any time.'
            : 'This appends a SHIPMENT_RESTORED event and returns the shipment to the active list. The earlier archival stays on the record.'
        }
        confirmLabel={dialog?.kind === 'archive' ? 'Archive shipment' : 'Restore shipment'}
        tone={dialog?.kind === 'archive' ? 'danger' : 'primary'}
        pending={archival.pending}
        error={archival.error && !archival.error.isConflict ? archival.error : null}
        reason={reason}
        onReasonChange={setReason}
        onConfirm={confirmArchival}
        onCancel={() => setDialog(null)}
      />

      <ConflictDialog
        conflict={conflict}
        onReload={() => {
          setConflict(null);
          sync();
        }}
        onDismiss={() => setConflict(null)}
      />
    </>
  );
}
