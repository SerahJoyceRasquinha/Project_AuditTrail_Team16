import { useEffect, useMemo, useState } from 'react';
import * as api from '../services/apiClient.js';
import { useCommand } from '../hooks/useShipmentData.js';
import { formatPlanDate, formatTimestamp } from '../utils/format.js';

/**
 * Shipment Schedule — the replacement for "Append a Command".
 *
 * The old panel asked a logistics manager to choose a movement type and press
 * "Append movement event". That is the vocabulary of the storage layer, and it
 * put the burden of knowing the legal sequence on the person using it.
 *
 * This screen is organised around the job instead: plan the three stages, then
 * confirm each one as it actually happens. Underneath, nothing about the
 * architecture changed - and that is the point worth being explicit about:
 *
 *  - Ticking a stage does **not** write to the event store. It dispatches
 *    MoveShipment, carrying the version the screen was loaded against. The
 *    backend re-checks that the shipment exists, that the version is current,
 *    that the prerequisite stage has happened, and that this stage has not
 *    already been confirmed, before any event exists.
 *  - Every date rule the calendar enforces is enforced again server-side. The
 *    bounds the pickers use are *sent by the backend* (`/schedule`), computed
 *    from the same policy that validates the command - so the calendar cannot
 *    offer a date the server would refuse, and refusing it client-side is a
 *    convenience rather than the guarantee.
 *  - Overdue is never stored. The backend derives it from the planned date and
 *    the absence of a confirming event, so it is correct whenever it is asked.
 */

const STAGE_ORDER = ['LOAD_ON_SHIP', 'ARRIVE_AT_PORT', 'UNLOAD_FROM_SHIP'];

const STAGE_COPY = {
  LOAD_ON_SHIP: {
    label: 'Load on Ship',
    blurb: 'The container is loaded onto the vessel and begins its voyage.',
    fields: [
      { key: 'vesselName', label: 'Vessel', placeholder: 'MV Ganges Star', required: true },
      { key: 'voyageNumber', label: 'Voyage number', placeholder: 'VY-2291' },
      { key: 'location', label: 'Loading port', placeholder: 'Chennai Port', required: true },
    ],
  },
  ARRIVE_AT_PORT: {
    label: 'Arrive at Port',
    blurb: 'The vessel reaches the destination port.',
    fields: [
      { key: 'portName', label: 'Port', placeholder: 'Port of Rotterdam', required: true },
      { key: 'berth', label: 'Berth', placeholder: 'ECT Delta 7' },
      { key: 'location', label: 'Location', placeholder: 'Rotterdam, NL', required: true },
    ],
  },
  UNLOAD_FROM_SHIP: {
    label: 'Unload from Ship',
    blurb: 'The container is discharged. This completes the shipment.',
    fields: [
      { key: 'location', label: 'Discharge location', placeholder: 'Rotterdam Yard', required: true },
      { key: 'yardBlock', label: 'Yard block', placeholder: 'D7' },
    ],
  },
};

const STATUS_PILL = {
  CONFIRMED: { className: 'pill pill--success', label: 'Completed' },
  IN_PROGRESS: { className: 'pill pill--accent', label: 'In Progress' },
  PLANNED: { className: 'pill pill--muted', label: 'Planned' },
  OVERDUE: { className: 'pill pill--danger', label: 'Overdue' },
  UNPLANNED: { className: 'pill pill--muted', label: 'Not planned' },
};

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * The selectable range for a stage, narrowed by the stages before it.
 *
 * The backend supplies a floor and ceiling per stage; this additionally clamps
 * against whatever the operator has just chosen for the preceding stage, so the
 * pickers update as they type rather than only after a save.
 */
function boundsFor(stage, draft, serverBounds) {
  const base = serverBounds?.[stage] ?? { selectable: true, min: null, max: null };
  if (!base.selectable) return base;

  const index = STAGE_ORDER.indexOf(stage);
  let min = base.min;
  for (let i = index - 1; i >= 0; i -= 1) {
    const earlier = draft[STAGE_ORDER[i]]?.plannedDate;
    if (earlier) {
      if (!min || earlier > min) min = earlier;
      break;
    }
  }
  return { ...base, min, max: base.max };
}

export function LifecyclePlanner({ shipmentId, schedule, disabled, disabledReason, onChanged, onConflict }) {
  const [draft, setDraft] = useState({});
  const [extendingStage, setExtendingStage] = useState(null);
  const [extensionDays, setExtensionDays] = useState('1');
  const [extensionReason, setExtensionReason] = useState('');
  const [formError, setFormError] = useState(null);

  // Seed the draft from the stored plan whenever the server view changes, so
  // the editor reflects the ledger rather than a stale local copy.
  useEffect(() => {
    if (!schedule) return;
    const next = {};
    for (const stage of STAGE_ORDER) {
      const stored = schedule.plan?.[stage];
      const entry = schedule.stages?.find((item) => item.stage === stage);
      next[stage] = {
        plannedDate: stored?.plannedDate ?? '',
        details: { ...(stored?.details ?? {}), ...(entry?.details ?? {}) },
      };
    }
    setDraft(next);
  }, [schedule?.currentVersion, schedule?.planned]);

  const command = useCommand({
    onSuccess: () => {
      setFormError(null);
      setExtendingStage(null);
      setExtensionReason('');
      setExtensionDays('1');
      onChanged?.();
    },
    onConflict,
  });

  const stages = schedule?.stages ?? [];
  const planned = Boolean(schedule?.planned);
  const version = schedule?.currentVersion ?? 0;

  const setStageDate = (stage, plannedDate) => {
    setDraft((current) => {
      const next = { ...current, [stage]: { ...current[stage], plannedDate } };
      // Dependent stages cannot sit before the one just moved. Rather than
      // silently rewriting them, clear anything now impossible so the operator
      // makes the choice deliberately.
      const index = STAGE_ORDER.indexOf(stage);
      for (let i = index + 1; i < STAGE_ORDER.length; i += 1) {
        const later = STAGE_ORDER[i];
        if (next[later]?.plannedDate && next[later].plannedDate < plannedDate) {
          next[later] = { ...next[later], plannedDate: '' };
        }
      }
      return next;
    });
  };

  const setStageDetail = (stage, key, value) =>
    setDraft((current) => ({
      ...current,
      [stage]: { ...current[stage], details: { ...current[stage]?.details, [key]: value } },
    }));

  const draftIssues = useMemo(() => {
    const issues = {};
    for (const stage of STAGE_ORDER) {
      const entry = schedule?.stages?.find((item) => item.stage === stage);
      if (entry?.status === 'CONFIRMED') continue;
      if (!draft[stage]?.plannedDate) issues[stage] = 'A tentative date is required.';
    }
    return issues;
  }, [draft, schedule]);

  const submitPlan = () => {
    if (Object.keys(draftIssues).length > 0) {
      setFormError('Give every remaining stage a tentative date before saving the schedule.');
      return;
    }
    setFormError(null);

    const payload = {};
    for (const stage of STAGE_ORDER) {
      payload[stage] = {
        plannedDate: draft[stage].plannedDate,
        details: Object.fromEntries(
          Object.entries(draft[stage]?.details ?? {}).filter(([, value]) => value)
        ),
      };
    }

    command.execute(() =>
      planned
        ? api.reviseSchedule({ shipmentId, schedule: payload, reason: 'REPLAN', expectedVersion: version })
        : api.planSchedule({ shipmentId, schedule: payload, expectedVersion: version })
    );
  };

  /**
   * Confirming a stage.
   *
   * The control is a checkbox because that is what the job feels like, but it
   * dispatches a command and waits for the backend to accept it. Nothing is
   * ticked optimistically: the UI reflects the ledger, not the click.
   */
  const confirmStage = (stage) => {
    const details = draft[stage]?.details ?? {};
    const missing = (STAGE_COPY[stage].fields ?? [])
      .filter((field) => field.required && !details[field.key])
      .map((field) => field.label);

    if (missing.length > 0) {
      setFormError(`${STAGE_COPY[stage].label} needs: ${missing.join(', ')}.`);
      return;
    }
    setFormError(null);

    command.execute(() =>
      api.moveShipment({
        shipmentId,
        movementType: stage,
        location: details.location ?? null,
        vesselName: details.vesselName ?? null,
        voyageNumber: details.voyageNumber ?? null,
        portName: details.portName ?? null,
        berth: details.berth ?? null,
        // The version the screen was loaded against. If anything else has been
        // recorded since, the backend rejects this rather than overwriting it.
        expectedVersion: version,
      })
    );
  };

  const submitExtension = () => {
    const days = Number(extensionDays);
    if (!Number.isInteger(days) || days < 1) {
      setFormError('The extension must be a positive whole number of days.');
      return;
    }
    setFormError(null);

    command.execute(() =>
      api.extendSchedule({
        shipmentId,
        stage: extendingStage,
        extensionDays: days,
        reason: extensionReason.trim() || null,
        expectedVersion: version,
      })
    );
  };

  if (!schedule) {
    return (
      <div className="panel__body">
        <p className="form-hint">Loading the shipment schedule…</p>
      </div>
    );
  }

  return (
    <div className="panel__body lifecycle">
      {disabled ? <p className="banner banner--historical">{disabledReason}</p> : null}

      {/* ---------------- Planning ---------------- */}
      <div className="lifecycle__planner">
        <h3 className="form-section">
          {planned ? 'Adjust the schedule' : 'Plan the shipment schedule'}
        </h3>
        <p className="form-hint">
          Set a tentative date for each stage. Dates run in order and must fall between the shipment's
          creation and its estimated completion
          {schedule.window ? ` (${formatPlanDate(schedule.window.earliest)} – ${formatPlanDate(schedule.window.latest)})` : ''}.
        </p>

        {STAGE_ORDER.map((stage, index) => {
          const entry = stages.find((item) => item.stage === stage);
          const confirmed = entry?.status === 'CONFIRMED';
          const bounds = boundsFor(stage, draft, schedule.bounds);
          const copy = STAGE_COPY[stage];

          return (
            <div className={`lifecycle__stage ${confirmed ? 'lifecycle__stage--done' : ''}`} key={stage}>
              <div className="lifecycle__stage-head">
                <span className="lifecycle__step">{index + 1}</span>
                <strong>{copy.label}</strong>
                {confirmed ? <span className="pill pill--success">Completed</span> : null}
              </div>
              <p className="lifecycle__blurb">{copy.blurb}</p>

              <div className="form-grid form-grid--tight">
                <label className="field">
                  <span className="field__label">Tentative date</span>
                  <input
                    className="input"
                    type="date"
                    value={draft[stage]?.plannedDate ?? ''}
                    min={bounds.min ?? undefined}
                    max={bounds.max ?? undefined}
                    onChange={(event) => setStageDate(stage, event.target.value)}
                    disabled={disabled || confirmed || command.pending}
                    aria-invalid={Boolean(draftIssues[stage])}
                  />
                  {confirmed ? (
                    <span className="field__hint">
                      Confirmed {formatTimestamp(entry.confirmedAt)} — now a historical fact.
                    </span>
                  ) : (
                    <span className="field__hint">
                      Selectable {formatPlanDate(bounds.min)} – {formatPlanDate(bounds.max)}
                    </span>
                  )}
                  {draftIssues[stage] ? (
                    <span className="field__error">{draftIssues[stage]}</span>
                  ) : null}
                </label>

                {copy.fields.map((field) => (
                  <label className="field" key={field.key}>
                    <span className="field__label">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </span>
                    <input
                      className="input"
                      value={draft[stage]?.details?.[field.key] ?? ''}
                      placeholder={field.placeholder}
                      onChange={(event) => setStageDetail(stage, field.key, event.target.value)}
                      disabled={disabled || confirmed || command.pending}
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}

        {formError ? (
          <div className="form-error" role="alert">
            {formError}
          </div>
        ) : null}

        {command.error && !command.error.isConflict ? (
          <div className="form-error" role="alert">
            {command.error.message}
            {command.error.details?.issues ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {command.error.details.issues.map((issue, index) => (
                  <li key={index}>{issue.message}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn--primary"
          onClick={submitPlan}
          disabled={disabled || command.pending || schedule.isComplete}
        >
          {command.pending ? 'Saving…' : planned ? 'Save schedule changes' : 'Save schedule'}
        </button>
      </div>

      {/* ---------------- Extension ---------------- */}
      {extendingStage ? (
        <div className="lifecycle__extend">
          <h3 className="form-section">Extend {STAGE_COPY[extendingStage].label}</h3>
          <p className="form-hint">
            This records a delay. The original schedule stays on the record, and later stages shift by the
            same number of days.
          </p>
          <div className="form-grid form-grid--tight">
            <label className="field">
              <span className="field__label">Additional days *</span>
              <input
                className="input mono"
                type="number"
                min="1"
                step="1"
                value={extensionDays}
                onChange={(event) => setExtensionDays(event.target.value)}
                disabled={command.pending}
              />
            </label>
            <label className="field">
              <span className="field__label">Reason</span>
              <input
                className="input"
                value={extensionReason}
                onChange={(event) => setExtensionReason(event.target.value)}
                placeholder="Port congestion at origin"
                disabled={command.pending}
              />
            </label>
          </div>
          <div className="lifecycle__actions">
            <button type="button" className="btn btn--ghost" onClick={() => setExtendingStage(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={submitExtension}
              disabled={command.pending}
            >
              {command.pending ? 'Recording…' : 'Record delay'}
            </button>
          </div>
        </div>
      ) : null}

      {/* ---------------- Confirmation list ---------------- */}
      <div className="lifecycle__status">
        <h3 className="form-section">Lifecycle Stages</h3>
        <p className="form-hint">
          Tick a stage when it actually happens. Each tick is checked against the shipment's history before
          it is recorded.
        </p>

        <ol className="stage-list">
          {stages.map((entry) => {
            const pill = STATUS_PILL[entry.status] ?? STATUS_PILL.PLANNED;
            const canConfirm =
              !disabled &&
              !command.pending &&
              entry.status !== 'CONFIRMED' &&
              !entry.isBlocked &&
              entry.plannedDate;

            return (
              <li
                key={entry.stage}
                className={`stage-card ${entry.status === 'OVERDUE' ? 'stage-card--overdue' : ''} ${
                  entry.status === 'CONFIRMED' ? 'stage-card--done' : ''
                }`}
              >
                <label className="stage-card__check">
                  <input
                    type="checkbox"
                    checked={entry.status === 'CONFIRMED'}
                    disabled={!canConfirm}
                    onChange={() => canConfirm && confirmStage(entry.stage)}
                    aria-label={`Confirm ${entry.label}`}
                  />
                  <span className="stage-card__title">{entry.label}</span>
                  <span className={pill.className}>
                    <span className="pill__dot" />
                    {pill.label}
                  </span>
                </label>

                <dl className="stage-card__meta">
                  <div>
                    <dt>Planned</dt>
                    <dd>{formatPlanDate(entry.plannedDate)}</dd>
                  </div>
                  {entry.originalPlannedDate && entry.originalPlannedDate !== entry.plannedDate ? (
                    <div>
                      <dt>Originally</dt>
                      <dd className="stage-card__struck">{formatPlanDate(entry.originalPlannedDate)}</dd>
                    </div>
                  ) : null}
                  {entry.confirmedAt ? (
                    <div>
                      <dt>Confirmed</dt>
                      <dd>{formatTimestamp(entry.confirmedAt)}</dd>
                    </div>
                  ) : null}
                </dl>

                {entry.details && Object.values(entry.details).some(Boolean) ? (
                  <p className="stage-card__details">
                    {Object.entries(entry.details)
                      .filter(([, value]) => value)
                      .map(([key, value]) => `${key}: ${value}`)
                      .join(' · ')}
                  </p>
                ) : null}

                {entry.status === 'OVERDUE' ? (
                  <div className="stage-card__warning" role="alert">
                    <span>
                      Overdue by {entry.overdueByDays} day{entry.overdueByDays === 1 ? '' : 's'}. Extend the
                      schedule or confirm the stage.
                    </span>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setExtendingStage(entry.stage)}
                      disabled={disabled || command.pending}
                    >
                      Extend schedule
                    </button>
                  </div>
                ) : null}

                {entry.earlyByDays > 0 ? (
                  <p className="stage-card__note">
                    Completed {entry.earlyByDays} day{entry.earlyByDays === 1 ? '' : 's'} ahead of plan.
                  </p>
                ) : null}
                {entry.lateByDays > 0 ? (
                  <p className="stage-card__note">
                    Completed {entry.lateByDays} day{entry.lateByDays === 1 ? '' : 's'} later than planned.
                  </p>
                ) : null}
                {entry.isBlocked && entry.status !== 'CONFIRMED' ? (
                  <p className="stage-card__note">
                    Waiting on the previous stage — it cannot be confirmed yet.
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>

        {schedule.isComplete ? (
          <p className="form-success" role="status">
            This shipment has completed its lifecycle.
            {schedule.actualDurationDays !== null && schedule.actualDurationDays !== undefined
              ? ` It took ${schedule.actualDurationDays} days against an original estimate of ${schedule.originalEstimatedDurationDays}.`
              : ''}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Exported for tests, which assert the clamping rules directly. */
export { boundsFor, STAGE_ORDER, todayIso };
