import { describe, expect, test } from 'vitest';
import { eventsToCsv } from '../src/utils/exportAudit.js';

describe('audit history export', () => {
  test('creates a CSV with audit fields and escaped payload JSON', () => {
    const csv = eventsToCsv([
      {
        eventId: 'e1',
        aggregateId: 'SHP-1001',
        eventType: 'CONTAINER_CREATED',
        version: 1,
        timestamp: '2026-03-01T08:00:00.000Z',
        payload: { containerCode: 'MSKU1', note: 'held, then released' },
        previousHash: null,
        hash: 'abc',
      },
    ]);

    expect(csv.split('\n')).toHaveLength(2);
    expect(csv).toContain('eventId,aggregateId,eventType,version,timestamp,payload,previousHash,hash');
    expect(csv).toContain('"{""containerCode"":""MSKU1"",""note"":""held, then released""}"');
  });
});