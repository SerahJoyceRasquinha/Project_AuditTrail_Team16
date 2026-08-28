import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, startHttp } from '../helpers/testSystem.js';

/**
 * Authentication and account management.
 *
 * These tests run with auth *enabled*, unlike the rest of the suite. The other
 * files disable it so they can exercise the command surface without a token;
 * this one is specifically about the layer they switch off, so it must switch
 * it back on.
 */
async function withAuthSystem(run) {
  const system = await createTestSystem({
    auth: { enabled: true, tokenSecret: 'test-secret-value', tokenTtlMs: 3_600_000 },
  });
  const http = await startHttp(system.app);
  try {
    await run({ system, http });
  } finally {
    await http.close();
    await system.teardown();
  }
}

const CREATE_COMMAND = {
  containerCode: 'MSKU0000001',
  origin: 'Chennai, IN',
  destination: 'Rotterdam, NL',
  minTemperatureC: 2,
  maxTemperatureC: 8,
  estimatedDurationDays: 21,
};

test('an account can be registered and immediately signs in', async () => {
  await withAuthSystem(async ({ http }) => {
    const registered = await http.post('/api/auth/register', {
      username: 'newuser',
      password: 'Password123',
      role: 'user',
    });

    assert.equal(registered.status, 201);
    assert.equal(registered.body.user.username, 'newuser');
    assert.equal(registered.body.user.role, 'user');
    assert.ok(registered.body.token, 'registration should return a session token');
  });
});

test('a duplicate username is rejected with 409 and nothing is overwritten', async () => {
  await withAuthSystem(async ({ system, http }) => {
    const first = await http.post('/api/auth/register', {
      username: 'takenname',
      password: 'Password123',
      role: 'operator',
    });
    assert.equal(first.status, 201);

    const second = await http.post('/api/auth/register', {
      username: 'takenname',
      password: 'DifferentPass456',
      role: 'user',
    });

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'USERNAME_TAKEN');

    // The original account must survive the collision untouched - in
    // particular its role, which the second attempt tried to claim as 'user'.
    const stored = await system.db.collection('users').findOne({ username: 'takenname' });
    assert.equal(stored.role, 'operator');
    assert.equal(await system.db.collection('users').countDocuments({ username: 'takenname' }), 1);
  });
});

test('a username differing only by case is still a duplicate', async () => {
  await withAuthSystem(async ({ http }) => {
    await http.post('/api/auth/register', { username: 'casetest', password: 'Password123', role: 'user' });
    const clash = await http.post('/api/auth/register', {
      username: 'CaseTest',
      password: 'Password123',
      role: 'user',
    });

    assert.equal(clash.status, 409);
  });
});

test('passwords are never stored in plaintext and never leave the backend', async () => {
  await withAuthSystem(async ({ system, http }) => {
    const password = 'SuperSecret123';
    const registered = await http.post('/api/auth/register', {
      username: 'hashcheck',
      password,
      role: 'user',
    });

    const stored = await system.db.collection('users').findOne({ username: 'hashcheck' });
    const serialised = JSON.stringify(stored);

    assert.ok(!serialised.includes(password), 'the stored record must not contain the password');
    assert.equal(stored.password, undefined, 'there must be no password field');
    assert.ok(stored.passwordHash, 'a derived hash must be stored');
    assert.ok(stored.passwordSalt, 'a per-account salt must be stored');
    assert.equal(stored.algorithm, 'scrypt');

    // Nor may any of it reach the client.
    const response = JSON.stringify(registered.body);
    assert.ok(!response.includes(password));
    assert.ok(!response.includes(stored.passwordHash));
    assert.ok(!response.includes(stored.passwordSalt));
  });
});

test('two accounts with the same password get different hashes', async () => {
  await withAuthSystem(async ({ system, http }) => {
    await http.post('/api/auth/register', { username: 'twin.a', password: 'IdenticalPw1', role: 'user' });
    await http.post('/api/auth/register', { username: 'twin.b', password: 'IdenticalPw1', role: 'user' });

    const a = await system.db.collection('users').findOne({ username: 'twin.a' });
    const b = await system.db.collection('users').findOne({ username: 'twin.b' });

    // Per-account salts, so identical passwords are not identifiable as such
    // from the stored records.
    assert.notEqual(a.passwordSalt, b.passwordSalt);
    assert.notEqual(a.passwordHash, b.passwordHash);
  });
});

test('registration validates its input and reports per-field errors', async () => {
  await withAuthSystem(async ({ http }) => {
    const empty = await http.post('/api/auth/register', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error.code, 'VALIDATION_ERROR');
    assert.ok(empty.body.error.details.fields.username);
    assert.ok(empty.body.error.details.fields.password);

    const shortPassword = await http.post('/api/auth/register', {
      username: 'shorty',
      password: 'abc',
      role: 'user',
    });
    assert.equal(shortPassword.status, 400);
    assert.ok(shortPassword.body.error.details.fields.password);

    const badUsername = await http.post('/api/auth/register', {
      username: 'has spaces!',
      password: 'Password123',
      role: 'user',
    });
    assert.equal(badUsername.status, 400);
    assert.ok(badUsername.body.error.details.fields.username);

    const mismatch = await http.post('/api/auth/register', {
      username: 'mismatch',
      password: 'Password123',
      confirmPassword: 'Password456',
      role: 'user',
    });
    assert.equal(mismatch.status, 400);
    assert.ok(mismatch.body.error.details.fields.confirmPassword);
  });
});

test('a role outside the two-role model cannot be registered', async () => {
  await withAuthSystem(async ({ system, http }) => {
    for (const role of ['admin', 'auditor', 'superuser', 'OPERATOR ']) {
      const response = await http.post('/api/auth/register', {
        username: `try-${role.trim().toLowerCase()}`,
        password: 'Password123',
        role,
      });

      if (response.status === 201) {
        // The only acceptable success here is a role that normalised to one of
        // the two legitimate values.
        assert.ok(['operator', 'user'].includes(response.body.user.role));
      } else {
        assert.equal(response.status, 400);
        assert.ok(response.body.error.details.fields.role);
      }
    }

    const roles = await system.db.collection('users').distinct('role', {});
    for (const role of roles) assert.ok(['operator', 'user'].includes(role));
  });
});

test('sign-in fails identically for a wrong password and a missing account', async () => {
  await withAuthSystem(async ({ http }) => {
    await http.post('/api/auth/register', { username: 'realuser', password: 'Password123', role: 'user' });

    const wrongPassword = await http.post('/api/auth/login', {
      username: 'realuser',
      password: 'WrongPassword',
    });
    const noSuchUser = await http.post('/api/auth/login', {
      username: 'ghostuser',
      password: 'WrongPassword',
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    // Identical message, so the endpoint cannot be used to discover which
    // usernames exist.
    assert.equal(wrongPassword.body.error.message, noSuchUser.body.error.message);
    assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');
  });
});

test('an authentication failure exposes no implementation detail', async () => {
  await withAuthSystem(async ({ http }) => {
    const failed = await http.post('/api/auth/login', { username: 'nobody', password: 'nothing' });
    const serialised = JSON.stringify(failed.body).toLowerCase();

    for (const leak of ['scrypt', 'hash', 'salt', 'mongo', 'stack', 'at object', '/src/']) {
      assert.ok(!serialised.includes(leak), `the error must not mention '${leak}'`);
    }
  });
});

test('empty credentials are a validation error, not a server error', async () => {
  await withAuthSystem(async ({ http }) => {
    const response = await http.post('/api/auth/login', { username: '', password: '' });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });
});

/**
 * The authorization matrix the requirement sets out, asserted directly.
 */
test('the authorization matrix holds for every combination', async () => {
  await withAuthSystem(async ({ http }) => {
    const user = await http.post('/api/auth/register', {
      username: 'reader',
      password: 'Password123',
      role: 'user',
    });
    const operator = await http.post('/api/auth/register', {
      username: 'writer',
      password: 'Password123',
      role: 'operator',
    });

    const call = (method, path, token, body) =>
      fetch(`${http.base}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

    const userToken = user.body.token;
    const operatorToken = operator.body.token;

    // Unauthenticated: everything protected is refused.
    assert.equal((await call('GET', '/api/shipments', null)).status, 401);
    assert.equal((await call('POST', '/api/shipment/create', null, CREATE_COMMAND)).status, 401);

    // Authenticated User: queries yes, commands no.
    assert.equal((await call('GET', '/api/shipments', userToken)).status, 200);
    const userCommand = await call('POST', '/api/shipment/create', userToken, CREATE_COMMAND);
    assert.equal(userCommand.status, 403);
    assert.equal(userCommand.body.error.code, 'FORBIDDEN');

    // Authenticated Operator: both.
    assert.equal((await call('GET', '/api/shipments', operatorToken)).status, 200);
    const created = await call('POST', '/api/shipment/create', operatorToken, CREATE_COMMAND);
    assert.equal(created.status, 201);

    const shipmentId = created.body.aggregateId;

    // Every command endpoint, not just create.
    const commands = [
      ['/api/shipment/move', { shipmentId, movementType: 'LOAD_ON_SHIP', location: 'Chennai Port', vesselName: 'MV Test', expectedVersion: 1 }],
      ['/api/shipment/temperature', { shipmentId, temperatureC: 5, expectedVersion: 1 }],
      ['/api/shipment/amend', { shipmentId, carrier: 'Someone Else', expectedVersion: 1 }],
      ['/api/shipment/archive', { shipmentId, expectedVersion: 1 }],
      ['/api/shipment/restore', { shipmentId, expectedVersion: 1 }],
      ['/api/shipment/schedule/plan', { shipmentId, stages: {}, expectedVersion: 1 }],
      ['/api/shipment/schedule/revise', { shipmentId, stages: {}, expectedVersion: 1 }],
      ['/api/shipment/schedule/extend', { shipmentId, stage: 'LOAD_ON_SHIP', additionalDays: 1, expectedVersion: 1 }],
    ];

    for (const [path, body] of commands) {
      const response = await call('POST', path, userToken, body);
      assert.equal(response.status, 403, `${path} must be forbidden for a read-only account`);
      assert.equal(response.body.error.code, 'FORBIDDEN');
    }

    // And every query endpoint remains open to the read-only account.
    for (const path of [
      `/api/shipment/${shipmentId}`,
      `/api/shipment/${shipmentId}/events`,
      `/api/shipment/${shipmentId}/sensors`,
      `/api/shipment/${shipmentId}/integrity`,
      `/api/shipment/${shipmentId}/reconciliation`,
      `/api/shipment/${shipmentId}/schedule`,
      `/api/shipment/${shipmentId}/state?at=${encodeURIComponent(new Date().toISOString())}`,
    ]) {
      const response = await call('GET', path, userToken);
      assert.equal(response.status, 200, `${path} must stay readable for a read-only account`);
    }
  });
});

test('a rejected command appends no event at all', async () => {
  await withAuthSystem(async ({ system, http }) => {
    const operator = await http.post('/api/auth/register', {
      username: 'writer2',
      password: 'Password123',
      role: 'operator',
    });
    const user = await http.post('/api/auth/register', {
      username: 'reader2',
      password: 'Password123',
      role: 'user',
    });

    const created = await fetch(`${http.base}/api/shipment/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operator.body.token}` },
      body: JSON.stringify(CREATE_COMMAND),
    }).then((response) => response.json());

    const before = await system.eventStore.countEvents(created.aggregateId);

    // A read-only account attempts several commands directly, as if through
    // curl or Postman.
    for (const [path, body] of [
      ['/api/shipment/move', { shipmentId: created.aggregateId, movementType: 'LOAD_ON_SHIP', location: 'X', vesselName: 'Y', expectedVersion: 1 }],
      ['/api/shipment/archive', { shipmentId: created.aggregateId, expectedVersion: 1 }],
    ]) {
      await fetch(`${http.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${user.body.token}` },
        body: JSON.stringify(body),
      });
    }

    const after = await system.eventStore.countEvents(created.aggregateId);
    assert.equal(after, before, 'a forbidden command must not append anything to the ledger');
  });
});

/**
 * The central claim of the role model: authority comes from the stored account,
 * never from anything the client is holding.
 */
test('the role is read from the stored account, not from the token', async () => {
  await withAuthSystem(async ({ http }) => {
    const user = await http.post('/api/auth/register', {
      username: 'climber',
      password: 'Password123',
      role: 'user',
    });
    const operator = await http.post('/api/auth/register', {
      username: 'genuine',
      password: 'Password123',
      role: 'operator',
    });

    // Splice the operator's signature onto a body naming the read-only
    // account, and vice versa. Both must fail: the signature covers the body,
    // so neither combination verifies.
    const [userBody, userSignature] = user.body.token.split('.');
    const [operatorBody, operatorSignature] = operator.body.token.split('.');

    const forgeries = [
      `${userBody}.${operatorSignature}`,
      `${operatorBody}.${userSignature}`,
      // A hand-built body claiming the operator role outright.
      `${Buffer.from(JSON.stringify({ sub: 'climber', role: 'operator', expiresAt: Date.now() + 60_000 })).toString('base64url')}.${operatorSignature}`,
      'not-a-token',
      '',
    ];

    for (const token of forgeries) {
      const response = await fetch(`${http.base}/api/shipment/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(CREATE_COMMAND),
      });
      assert.ok(
        response.status === 401 || response.status === 403,
        `a forged token must not be accepted (got ${response.status})`
      );
    }

    // And the genuine read-only token reports its real role, whatever it was
    // asked to carry.
    const me = await fetch(`${http.base}/api/auth/me`, {
      headers: { authorization: `Bearer ${user.body.token}` },
    }).then((response) => response.json());
    assert.equal(me.user.role, 'user');
  });
});

test('a request cannot elevate its role through the body or query string', async () => {
  await withAuthSystem(async ({ http }) => {
    const user = await http.post('/api/auth/register', {
      username: 'sneaky',
      password: 'Password123',
      role: 'user',
    });

    const attempts = [
      ['/api/shipment/create?role=operator', { ...CREATE_COMMAND }],
      ['/api/shipment/create', { ...CREATE_COMMAND, role: 'operator' }],
      ['/api/shipment/create', { ...CREATE_COMMAND, user: { role: 'operator' } }],
    ];

    for (const [path, body] of attempts) {
      const response = await fetch(`${http.base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${user.body.token}`,
          'x-role': 'operator',
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403, `${path} must remain forbidden`);
    }
  });
});

test('the session survives a restart when a token secret is configured', async () => {
  // Two independently constructed systems sharing a secret stand in for a
  // backend restart: a token issued by one must still verify on the other.
  const first = await createTestSystem({
    auth: { enabled: true, tokenSecret: 'shared-secret', tokenTtlMs: 3_600_000 },
  });
  const firstHttp = await startHttp(first.app);

  const registered = await firstHttp.post('/api/auth/register', {
    username: 'persistent',
    password: 'Password123',
    role: 'operator',
  });
  const { token } = registered.body;
  const record = await first.db.collection('users').findOne({ username: 'persistent' });

  await firstHttp.close();
  await first.teardown();

  const second = await createTestSystem({
    auth: { enabled: true, tokenSecret: 'shared-secret', tokenTtlMs: 3_600_000 },
  });
  // Carry the account across, as a shared database would.
  await second.db.collection('users').insertOne(record);
  const secondHttp = await startHttp(second.app);

  const me = await fetch(`${secondHttp.base}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user.role, 'operator');

  await secondHttp.close();
  await second.teardown();
});

test('an expired token is refused', async () => {
  await withAuthSystem(async ({ http }) => {
    const system = await createTestSystem({
      auth: { enabled: true, tokenSecret: 'expiry-secret', tokenTtlMs: -1_000 },
    });
    const expiredHttp = await startHttp(system.app);

    const registered = await expiredHttp.post('/api/auth/register', {
      username: 'expired',
      password: 'Password123',
      role: 'operator',
    });

    const response = await fetch(`${expiredHttp.base}/api/auth/me`, {
      headers: { authorization: `Bearer ${registered.body.token}` },
    });
    assert.equal(response.status, 401);

    await expiredHttp.close();
    await system.teardown();
  });
});

test('the account collection is separate from the Event Store', async () => {
  await withAuthSystem(async ({ system, http }) => {
    await http.post('/api/auth/register', { username: 'separate', password: 'Password123', role: 'operator' });

    // Registering an account must append nothing to the shipment event log.
    assert.equal(await system.eventStore.countEvents(), 0);

    // And the Event Store still refuses every mutation, unchanged by the
    // addition of a mutable accounts collection alongside it.
    assert.throws(() => system.eventStore.updateEvent(), /append-only/);
    assert.throws(() => system.eventStore.deleteEvent(), /append-only/);
    assert.throws(() => system.eventStore.replaceEvent(), /append-only/);
    assert.throws(() => system.eventStore.truncate(), /append-only/);
  });
});

test('an operator command still records the acting account on the event', async () => {
  await withAuthSystem(async ({ system, http }) => {
    const operator = await http.post('/api/auth/register', {
      username: 'namedactor',
      password: 'Password123',
      role: 'operator',
    });

    const created = await fetch(`${http.base}/api/shipment/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operator.body.token}` },
      body: JSON.stringify(CREATE_COMMAND),
    }).then((response) => response.json());

    const events = await system.eventStore.getEvents(created.aggregateId);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'CONTAINER_CREATED');
    // The audit trail names who did it, which is the point of an audit trail.
    assert.equal(events[0].actor, 'namedactor');
  });
});

test('OCC is still enforced for an authorised operator', async () => {
  await withAuthSystem(async ({ http }) => {
    const operator = await http.post('/api/auth/register', {
      username: 'occtester',
      password: 'Password123',
      role: 'operator',
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${operator.body.token}`,
    };

    const created = await fetch(`${http.base}/api/shipment/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(CREATE_COMMAND),
    }).then((response) => response.json());

    const move = { shipmentId: created.aggregateId, movementType: 'LOAD_ON_SHIP', location: 'Chennai Port', vesselName: 'MV Test' };

    const accepted = await fetch(`${http.base}/api/shipment/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...move, expectedVersion: 1 }),
    });
    assert.equal(accepted.status, 200);

    // The same command replayed against the now-stale version must still be
    // refused. Authorization is an extra gate in front of OCC, not a
    // replacement for it.
    const stale = await fetch(`${http.base}/api/shipment/move`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...move, expectedVersion: 1 }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'CONCURRENCY_CONFLICT');
  });
});
