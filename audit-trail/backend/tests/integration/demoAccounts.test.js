import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestSystem, startHttp } from '../helpers/testSystem.js';
import { DEMO_ACCOUNTS, seedDemoAccounts } from '../../src/application/services/demoAccounts.js';
import { ASSIGNABLE_ROLES, ROLES } from '../../src/domain/auth/roles.js';

/**
 * The demo accounts offered by the sign-in page.
 *
 * These tests exist because of a real defect: the login page shipped buttons
 * for Operator, Auditor and Admin, while the backend has only `operator` and
 * `user`. Two of the three could never sign in, and nothing failed loudly -
 * the mismatch lived between a hardcoded list in a React component and a
 * frozen constant in the domain layer, with no test spanning the two.
 *
 * The first test below is the one that would have caught it.
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

test('every demo account names a role the domain actually assigns', () => {
  for (const account of DEMO_ACCOUNTS) {
    assert.ok(
      ASSIGNABLE_ROLES.includes(account.role),
      `Demo account '${account.username}' claims role '${account.role}', which is not assignable. ` +
        `Assignable roles are: ${ASSIGNABLE_ROLES.join(', ')}.`
    );
  }
});

test('the demo accounts cover both roles, so each can be demonstrated', () => {
  const roles = new Set(DEMO_ACCOUNTS.map((account) => account.role));
  assert.equal(roles.size, DEMO_ACCOUNTS.length, 'Two demo accounts should not share a role.');
  assert.ok(roles.has(ROLES.OPERATOR));
  assert.ok(roles.has(ROLES.USER));
});

test('seeding creates every demo account, and each one can sign in', async () => {
  await withAuthSystem(async ({ system, http }) => {
    const result = await seedDemoAccounts({
      authService: system.container.authService,
      userRepository: system.container.userRepository,
      logger: null,
    });

    assert.equal(result.created.length, DEMO_ACCOUNTS.length);
    assert.equal(result.skipped.length, 0);

    for (const account of DEMO_ACCOUNTS) {
      const signedIn = await http.post('/api/auth/login', {
        username: account.username,
        password: account.password,
      });

      assert.equal(signedIn.status, 200, `'${account.username}' could not sign in.`);
      assert.equal(signedIn.body.user.role, account.role);
      // The public projection of an account must never carry the credential.
      assert.equal(signedIn.body.user.passwordHash, undefined);
      assert.equal(signedIn.body.user.passwordSalt, undefined);
    }
  });
});

test('seeding twice creates nothing the second time', async () => {
  await withAuthSystem(async ({ system }) => {
    const args = {
      authService: system.container.authService,
      userRepository: system.container.userRepository,
      logger: null,
    };

    await seedDemoAccounts(args);
    const second = await seedDemoAccounts(args);

    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, DEMO_ACCOUNTS.length);
    assert.equal(await system.container.userRepository.count(), DEMO_ACCOUNTS.length);
  });
});

test('seeding never overwrites an existing account that shares a username', async () => {
  await withAuthSystem(async ({ system, http }) => {
    const demoOperator = DEMO_ACCOUNTS.find((account) => account.role === ROLES.OPERATOR);

    // Somebody already holds this username, with their own password.
    await system.container.authService.register({
      username: demoOperator.username,
      password: 'a-real-password-nobody-published',
      role: ROLES.USER,
    });

    await seedDemoAccounts({
      authService: system.container.authService,
      userRepository: system.container.userRepository,
      logger: null,
    });

    // The published demo password must not have been written over theirs.
    const withDemoPassword = await http.post('/api/auth/login', {
      username: demoOperator.username,
      password: demoOperator.password,
    });
    assert.equal(withDemoPassword.status, 401);

    // And their own account is untouched - same password, same role.
    const withRealPassword = await http.post('/api/auth/login', {
      username: demoOperator.username,
      password: 'a-real-password-nobody-published',
    });
    assert.equal(withRealPassword.status, 200);
    assert.equal(withRealPassword.body.user.role, ROLES.USER);
  });
});

test('the read-only demo account is refused commands but served every query', async () => {
  await withAuthSystem(async ({ system, http }) => {
    await seedDemoAccounts({
      authService: system.container.authService,
      userRepository: system.container.userRepository,
      logger: null,
    });

    const viewer = DEMO_ACCOUNTS.find((account) => account.role === ROLES.USER);
    const session = await http.post('/api/auth/login', {
      username: viewer.username,
      password: viewer.password,
    });
    const auth = { Authorization: `Bearer ${session.body.token}` };

    const command = await fetch(`${http.base}/api/shipment/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({
        containerCode: 'MSKU0000002',
        origin: 'Chennai, IN',
        destination: 'Rotterdam, NL',
        estimatedDurationDays: 21,
      }),
    });
    assert.equal(command.status, 403, 'A read-only account must not be able to issue a command.');

    const query = await fetch(`${http.base}/api/shipments`, { headers: auth });
    assert.equal(query.status, 200, 'A read-only account must still be able to read the ledger.');
  });
});
