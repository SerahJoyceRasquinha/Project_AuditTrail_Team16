import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import {
  ShipmentFormDialog,
  validateShipmentForm,
  changedFields,
} from '../src/components/ShipmentFormDialog.jsx';
import { ConfirmDialog } from '../src/components/ShipmentPanels.jsx';
import { EventTimeline } from '../src/components/EventTimeline.jsx';
import * as api from '../src/services/apiClient.js';

const SHIPMENT = {
  aggregateId: 'SHP-1001',
  containerCode: 'MSKU7845123',
  origin: 'Chennai, IN',
  destination: 'Rotterdam, NL',
  carrier: 'Maersk Line',
  cargoDescription: 'Vaccines',
  minTemperatureC: 2,
  maxTemperatureC: 8,
  currentVersion: 4,
  currentState: 'IN_TRANSIT',
};

const wrap = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('create/amend form validation', () => {
  test('a create needs an ID, container code, origin and destination', () => {
    const issues = validateShipmentForm(
      { shipmentId: '', containerCode: '', origin: '', destination: '', minTemperatureC: '', maxTemperatureC: '' },
      { mode: 'create' }
    );

    expect(issues.shipmentId).toBeTruthy();
    expect(issues.containerCode).toBeTruthy();
    expect(issues.origin).toBeTruthy();
    expect(issues.destination).toBeTruthy();
  });

  test('the shipment ID must match the backend pattern', () => {
    const bad = validateShipmentForm(
      { shipmentId: 'a b!', containerCode: 'X', origin: 'a', destination: 'b', minTemperatureC: '', maxTemperatureC: '' },
      { mode: 'create' }
    );
    expect(bad.shipmentId).toBeTruthy();

    const good = validateShipmentForm(
      { shipmentId: 'SHP-1005', containerCode: 'X', origin: 'a', destination: 'b', minTemperatureC: '', maxTemperatureC: '' },
      { mode: 'create' }
    );
    expect(good.shipmentId).toBeUndefined();
  });

  test('a one-sided temperature range is rejected, matching the domain rule', () => {
    const issues = validateShipmentForm(
      { shipmentId: 'SHP-1', containerCode: 'X', origin: 'a', destination: 'b', minTemperatureC: '2', maxTemperatureC: '' },
      { mode: 'create' }
    );
    expect(issues.minTemperatureC).toMatch(/both bounds|one-sided/i);
  });

  test('an inverted range is rejected', () => {
    const issues = validateShipmentForm(
      { shipmentId: 'SHP-1', containerCode: 'X', origin: 'a', destination: 'b', minTemperatureC: '9', maxTemperatureC: '2' },
      { mode: 'create' }
    );
    expect(issues.minTemperatureC).toBeTruthy();
  });

  test('an amend does not demand the required-on-create fields', () => {
    const issues = validateShipmentForm(
      { shipmentId: '', containerCode: '', origin: '', destination: '', minTemperatureC: '', maxTemperatureC: '' },
      { mode: 'amend' }
    );
    expect(issues).toEqual({});
  });
});

describe('amendment diffing', () => {
  const form = {
    shipmentId: 'SHP-1001',
    containerCode: 'MSKU7845123',
    origin: 'Chennai, IN',
    destination: 'Rotterdam, NL',
    carrier: 'Maersk Line',
    cargoDescription: 'Vaccines',
    minTemperatureC: 2,
    maxTemperatureC: 8,
    reason: '',
  };

  test('an untouched form yields no changes at all', () => {
    expect(changedFields(form, SHIPMENT)).toEqual({});
  });

  test('only genuinely different fields are carried into the command', () => {
    const changes = changedFields({ ...form, destination: 'Hamburg, DE' }, SHIPMENT);
    expect(changes).toEqual({ destination: 'Hamburg, DE' });
  });

  test('numeric fields are sent as numbers, not strings', () => {
    const changes = changedFields({ ...form, maxTemperatureC: '10' }, SHIPMENT);
    expect(changes).toEqual({ maxTemperatureC: 10 });
    expect(typeof changes.maxTemperatureC).toBe('number');
  });

  test('a blanked optional field is not treated as a request to erase it', () => {
    // The dashboard submits whole forms. Silently clearing a stored carrier
    // because an input was emptied would be a destructive surprise.
    expect(changedFields({ ...form, carrier: '' }, SHIPMENT)).toEqual({});
  });
});

describe('ShipmentFormDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  test('the create form explains that it appends an event rather than inserting a row', () => {
    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    expect(screen.getByText(/CONTAINER_CREATED/)).toBeInTheDocument();
  });

  test('the amend form locks the shipment ID, because identity is not amendable', () => {
    wrap(<ShipmentFormDialog mode="amend" shipment={SHIPMENT} onClose={() => {}} />);
    const input = screen.getByDisplayValue('SHP-1001');
    expect(input).toHaveAttribute('readonly');
  });

  test('submit is disabled until something actually changes', () => {
    wrap(<ShipmentFormDialog mode="amend" shipment={SHIPMENT} onClose={() => {}} />);

    const submit = screen.getByRole('button', { name: /append amendment/i });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/Nothing has been changed yet/i)).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Rotterdam, NL'), { target: { value: 'Hamburg, DE' } });
    expect(submit).toBeEnabled();
  });

  test('the form shows which fields will be appended, and the version it holds', () => {
    wrap(<ShipmentFormDialog mode="amend" shipment={SHIPMENT} onClose={() => {}} />);
    fireEvent.change(screen.getByDisplayValue('Rotterdam, NL'), { target: { value: 'Hamburg, DE' } });

    expect(screen.getByText(/Will append: destination/)).toBeInTheDocument();
    expect(screen.getByText(/expectedVersion 4/)).toBeInTheDocument();
  });

  test('an amendment sends only the changed fields plus the version it was opened against', async () => {
    const amend = vi
      .spyOn(api, 'amendShipment')
      .mockResolvedValue({ aggregateId: 'SHP-1001', eventType: 'SHIPMENT_DETAILS_AMENDED', version: 5 });

    wrap(<ShipmentFormDialog mode="amend" shipment={SHIPMENT} onClose={() => {}} onSucceeded={() => {}} />);
    fireEvent.change(screen.getByDisplayValue('Rotterdam, NL'), { target: { value: 'Hamburg, DE' } });
    fireEvent.click(screen.getByRole('button', { name: /append amendment/i }));

    await waitFor(() => expect(amend).toHaveBeenCalledTimes(1));
    expect(amend).toHaveBeenCalledWith({
      shipmentId: 'SHP-1001',
      destination: 'Hamburg, DE',
      reason: null,
      expectedVersion: 4,
    });
  });

  test('a create sends the whole manifest, with the range as numbers', async () => {
    const create = vi
      .spyOn(api, 'createShipment')
      .mockResolvedValue({ aggregateId: 'SHP-2000', eventType: 'CONTAINER_CREATED', version: 1 });

    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} onSucceeded={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('SHP-1005'), { target: { value: 'SHP-2000' } });
    fireEvent.change(screen.getByPlaceholderText('MSKU7845123'), { target: { value: 'ABCD1234567' } });
    fireEvent.change(screen.getByPlaceholderText('Chennai, IN'), { target: { value: 'Mundra, IN' } });
    fireEvent.change(screen.getByPlaceholderText('Rotterdam, NL'), { target: { value: 'Singapore, SG' } });
    fireEvent.change(screen.getByPlaceholderText('2'), { target: { value: '-22' } });
    fireEvent.change(screen.getByPlaceholderText('8'), { target: { value: '-16' } });

    fireEvent.click(screen.getByRole('button', { name: /create shipment/i }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        shipmentId: 'SHP-2000',
        containerCode: 'ABCD1234567',
        minTemperatureC: -22,
        maxTemperatureC: -16,
      })
    );
  });

  test('a rejected create surfaces the backend issue list rather than a generic failure', async () => {
    vi.spyOn(api, 'createShipment').mockRejectedValue(
      Object.assign(new Error('The create-shipment command failed validation.'), {
        isConflict: false,
        details: { issues: [{ message: "'containerCode' is required and must be a non-empty string." }] },
      })
    );

    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('SHP-1005'), { target: { value: 'SHP-2000' } });
    fireEvent.change(screen.getByPlaceholderText('MSKU7845123'), { target: { value: 'X' } });
    fireEvent.change(screen.getByPlaceholderText('Chennai, IN'), { target: { value: 'a' } });
    fireEvent.change(screen.getByPlaceholderText('Rotterdam, NL'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: /create shipment/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/containerCode/);
  });

  test('the submit button is disabled while a command is in flight, preventing double submission', async () => {
    let release;
    vi.spyOn(api, 'createShipment').mockImplementation(
      () => new Promise((resolve) => { release = resolve; })
    );

    wrap(<ShipmentFormDialog mode="create" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('SHP-1005'), { target: { value: 'SHP-2000' } });
    fireEvent.change(screen.getByPlaceholderText('MSKU7845123'), { target: { value: 'X' } });
    fireEvent.change(screen.getByPlaceholderText('Chennai, IN'), { target: { value: 'a' } });
    fireEvent.change(screen.getByPlaceholderText('Rotterdam, NL'), { target: { value: 'b' } });

    fireEvent.click(screen.getByRole('button', { name: /create shipment/i }));

    const pending = await screen.findByRole('button', { name: /creating/i });
    expect(pending).toBeDisabled();

    release({ aggregateId: 'SHP-2000', eventType: 'CONTAINER_CREATED', version: 1 });
  });
});

describe('ConfirmDialog', () => {
  test('the archive confirmation never claims anything is destroyed', () => {
    render(
      <ConfirmDialog
        open
        title="Archive SHP-1001?"
        body="This withdraws the shipment from the active list by appending a SHIPMENT_ARCHIVED event. No event is deleted."
        confirmLabel="Archive shipment"
        tone="danger"
        reason=""
        onReasonChange={() => {}}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/No event is deleted/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/cannot be undone/i)).not.toBeInTheDocument();
  });

  test('the confirm button is disabled and relabelled while the command runs', () => {
    render(
      <ConfirmDialog
        open
        title="Archive SHP-1001?"
        body="…"
        confirmLabel="Archive shipment"
        pending
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );

    expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
  });

  test('it renders nothing when closed', () => {
    const { container } = render(
      <ConfirmDialog open={false} title="x" body="y" confirmLabel="z" onConfirm={() => {}} onCancel={() => {}} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('timeline rendering of the new events', () => {
  const events = [
    { eventId: 'e1', eventType: 'CONTAINER_CREATED', version: 1, timestamp: '2026-08-01T10:00:00.000Z', payload: { destination: 'Rotterdam, NL' } },
    { eventId: 'e2', eventType: 'SHIPMENT_DETAILS_AMENDED', version: 2, timestamp: '2026-08-01T11:00:00.000Z', payload: { destination: 'Hamburg, DE', reason: 'Redirected' } },
    { eventId: 'e3', eventType: 'SHIPMENT_ARCHIVED', version: 3, timestamp: '2026-08-01T12:00:00.000Z', payload: { reason: 'Claim settled' } },
    { eventId: 'e4', eventType: 'SHIPMENT_RESTORED', version: 4, timestamp: '2026-08-01T13:00:00.000Z', payload: {} },
  ];

  test('amendment, archival and restoration all appear as ordinary timeline events', () => {
    render(<EventTimeline events={events} selectedEventId={null} onSelect={() => {}} />);

    expect(screen.getByText('Details amended')).toBeInTheDocument();
    expect(screen.getByText('Shipment archived')).toBeInTheDocument();
    expect(screen.getByText('Shipment restored')).toBeInTheDocument();
  });

  test('the original creation event stays in the timeline after an amendment', () => {
    render(<EventTimeline events={events} selectedEventId={null} onSelect={() => {}} />);

    // The whole claim: history is added to, never rewritten.
    expect(screen.getByText('Container created')).toBeInTheDocument();
    expect(screen.getByText('v1')).toBeInTheDocument();
    expect(screen.getByText('v4')).toBeInTheDocument();
  });

  test('selecting an amendment reveals the fields that were corrected', () => {
    render(<EventTimeline events={events} selectedEventId="e2" onSelect={() => {}} />);

    expect(screen.getByText('Destination')).toBeInTheDocument();
    expect(screen.getByText('Hamburg, DE')).toBeInTheDocument();
    expect(screen.getByText('Reason')).toBeInTheDocument();
  });
});
