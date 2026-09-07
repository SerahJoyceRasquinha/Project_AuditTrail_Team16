import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemperatureEntry } from '../src/components/TemperatureEntry.jsx';
import * as api from '../src/services/apiClient.js';

/**
 * Manual temperature entry.
 *
 * The command existed on the server long before anything in the application
 * called it, so these tests are written against the boundary that was missing:
 * that a reading typed by an operator reaches `recordTemperature` with the
 * shipment and the loaded version attached.
 */
describe('TemperatureEntry', () => {
  beforeEach(() => vi.restoreAllMocks());

  const setup = (props = {}) =>
    render(
      <TemperatureEntry
        shipmentId="SHP-1"
        expectedVersion={4}
        minTemperatureC={2}
        maxTemperatureC={8}
        {...props}
      />
    );

  it('sends the reading with the shipment id and the loaded version', async () => {
    const spy = vi
      .spyOn(api, 'recordTemperature')
      .mockResolvedValue({ eventType: 'TEMPERATURE_RECORDED', version: 5 });
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '4.5' } });
    fireEvent.change(screen.getByLabelText(/sensor identifier/i), { target: { value: 'REEFER-01' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toEqual({
      shipmentId: 'SHP-1',
      temperatureC: 4.5,
      expectedVersion: 4,
      sensorId: 'REEFER-01',
    });
  });

  it('sends a number, not a string', async () => {
    const spy = vi.spyOn(api, 'recordTemperature').mockResolvedValue({ eventType: 'TEMPERATURE_RECORDED', version: 5 });
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '-3' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(typeof spy.mock.calls[0][0].temperatureC).toBe('number');
    expect(spy.mock.calls[0][0].temperatureC).toBe(-3);
  });

  it('omits sensorId rather than sending an empty string', async () => {
    const spy = vi.spyOn(api, 'recordTemperature').mockResolvedValue({ eventType: 'TEMPERATURE_RECORDED', version: 5 });
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect('sensorId' in spy.mock.calls[0][0]).toBe(false);
  });

  it('refuses an empty reading without calling the API', async () => {
    const spy = vi.spyOn(api, 'recordTemperature').mockResolvedValue({});
    setup();
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    expect(await screen.findByText(/enter a temperature reading/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  /**
   * A number input cannot hold 'hot' - the DOM blanks it - so this arrives at
   * the guard as an empty value. What matters, and what is asserted, is that
   * nothing non-numeric ever reaches the command.
   */
  it('never sends a non-numeric reading to the API', async () => {
    const spy = vi.spyOn(api, 'recordTemperature').mockResolvedValue({});
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: 'hot' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    expect(await screen.findByText(/enter a temperature reading|must be a number/i)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  /** The same guard, reached directly, since the DOM cannot deliver it. */
  it('rejects a non-finite value at the guard', async () => {
    const spy = vi.spyOn(api, 'recordTemperature').mockResolvedValue({});
    const { container } = setup();
    const input = screen.getByLabelText(/temperature in degrees/i);
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'NaN');
    fireEvent.change(input, { target: { value: 'NaN' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('warns before submitting a value above the range, without classifying it itself', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '14.5' } });
    expect(screen.getByText(/above the acceptable range/i)).toBeTruthy();
  });

  it('warns for a value below the range', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '-4' } });
    expect(screen.getByText(/below the acceptable range/i)).toBeTruthy();
  });

  it('shows the range so an operator can see the ceiling', () => {
    setup();
    expect(screen.getByText(/acceptable range/i).textContent).toMatch(/2\.0.*8\.0/);
  });

  it('reports a concurrency conflict in plain language', async () => {
    const conflict = Object.assign(new Error('stale'), { isConflict: true });
    vi.spyOn(api, 'recordTemperature').mockRejectedValue(conflict);
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    expect(await screen.findByText(/changed while the form was open/i)).toBeTruthy();
  });

  it('reports what the server actually recorded, including a spike', async () => {
    vi.spyOn(api, 'recordTemperature').mockResolvedValue({ eventType: 'TEMPERATURE_SPIKE', version: 6 });
    setup();
    fireEvent.change(screen.getByLabelText(/temperature in degrees/i), { target: { value: '14.5' } });
    fireEvent.click(screen.getByRole('button', { name: /record reading/i }));
    expect(await screen.findByText(/TEMPERATURE_SPIKE.*version 6/i)).toBeTruthy();
  });

  it('offers no input at all to a read-only account', () => {
    setup({ disabled: true, disabledReason: 'Your account has read-only access.' });
    expect(screen.queryByRole('button', { name: /record reading/i })).toBeNull();
    expect(screen.getByText(/read-only access/i)).toBeTruthy();
  });

  it('offers no timestamp field, so a reading cannot be hand-dated', () => {
    const { container } = setup();
    expect(container.querySelector('input[type=date], input[type=datetime-local]')).toBeNull();
  });
});
