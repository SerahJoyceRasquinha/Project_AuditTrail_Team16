import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, ValidationError } from '../../shared/errors/AppError.js';
import { ROLES, isAssignableRole, ASSIGNABLE_ROLES } from '../../domain/auth/roles.js';
import { toPublicUser } from '../../infrastructure/users/userRepository.js';

const scrypt = promisify(scryptCallback);

/** scrypt parameters. N=16384 is the Node default work factor and is adequate here. */
const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = Object.freeze({ N: 16_384, r: 8, p: 1 });

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

/**
 * Authentication and account management.
 *
 * Three properties are worth stating explicitly, because they are what the
 * authorization model rests on:
 *
 *  1. **Passwords are never stored in any recoverable form.** Registration
 *     derives a scrypt hash over a per-account random salt; login re-derives
 *     and compares in constant time. There is no code path that can print,
 *     return or recover a password, and the hash itself never leaves the
 *     backend.
 *  2. **A token proves identity, not permission.** The token carries a
 *     username and is signed so it cannot be forged or edited. It deliberately
 *     does not carry the role - or rather, whatever it carries is ignored.
 *     `verifyToken` looks the account up and reads the role from the stored
 *     record on every request. So even a validly-signed token cannot claim a
 *     role its account does not have, and an account's authority is whatever
 *     the database says at the moment of the request.
 *  3. **Failures are indistinguishable.** A wrong password and a username that
 *     does not exist produce the identical 401 with the identical message, so
 *     the endpoint cannot be used to enumerate which accounts are real.
 */
export class AuthService {
  #users;
  #logger;
  #secret;
  #tokenTtlMs;

  constructor({ enabled = true, tokenSecret, tokenTtlMs = 43_200_000 } = {}, { userRepository, logger } = {}) {
    this.enabled = enabled;
    this.#users = userRepository;
    this.#logger = logger;
    this.#tokenTtlMs = tokenTtlMs;

    /**
     * A generated secret is fine for development and for the in-memory
     * persistence mode, but it changes on every restart, which would silently
     * invalidate every issued token. Production sets AUTH_TOKEN_SECRET so that
     * sessions survive a deploy; the warning below makes the difference
     * visible rather than leaving it to be discovered.
     */
    if (tokenSecret) {
      this.#secret = tokenSecret;
    } else {
      this.#secret = randomBytes(32).toString('hex');
      logger?.warn(
        'No AUTH_TOKEN_SECRET is configured, so a random one was generated. Sessions will not survive a backend restart.'
      );
    }
  }

  // --- Password hashing ------------------------------------------------------

  async #hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const derived = await scrypt(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    return { salt, hash: derived.toString('hex') };
  }

  /**
   * Constant-time comparison.
   *
   * `timingSafeEqual` throws on a length mismatch, so the lengths are checked
   * first - and a mismatch is treated as a failed comparison rather than an
   * error, because a malformed stored hash should mean "you cannot log in",
   * never a 500 that reveals something about the record.
   */
  async #verifyPassword(password, { salt, hash }) {
    if (!salt || !hash) return false;
    const { hash: candidate } = await this.#hashPassword(password, salt);
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // --- Tokens ----------------------------------------------------------------

  #sign(body) {
    return createHmac('sha256', this.#secret).update(body).digest('base64url');
  }

  #issueToken(username) {
    const payload = {
      sub: username,
      issuedAt: Date.now(),
      expiresAt: Date.now() + this.#tokenTtlMs,
      // A nonce, so two tokens issued for the same account in the same
      // millisecond are still distinct values.
      jti: randomBytes(8).toString('hex'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.#sign(body)}`;
  }

  #readToken(token) {
    if (typeof token !== 'string') return null;
    const [body, signature] = token.split('.');
    if (!body || !signature) return null;

    // Verify the signature before parsing the body: an unsigned token's
    // contents are not evidence of anything and should not be trusted enough
    // to deserialise.
    const expected = this.#sign(body);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!payload?.sub) return null;
      if (typeof payload.expiresAt === 'number' && payload.expiresAt < Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // --- Registration ----------------------------------------------------------

  /**
   * Creates an account.
   *
   * The role is accepted here, at creation, and only here. Nothing else in the
   * application writes the role field, which is what makes it permanent: there
   * is no "update role" service method for an endpoint to expose or for a
   * request payload to reach.
   */
  async register({ username, password, confirmPassword, displayName, role } = {}) {
    const errors = {};

    const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';
    if (!cleanUsername) {
      errors.username = 'A username is required.';
    } else if (cleanUsername.length < MIN_USERNAME_LENGTH || cleanUsername.length > MAX_USERNAME_LENGTH) {
      errors.username = `A username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`;
    } else if (!USERNAME_PATTERN.test(cleanUsername)) {
      errors.username = 'A username may contain only letters, numbers, dots, underscores and hyphens.';
    }

    if (typeof password !== 'string' || password.length === 0) {
      errors.password = 'A password is required.';
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (password.length > MAX_PASSWORD_LENGTH) {
      errors.password = `A password may be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }

    // Only checked when supplied, so an API client is not forced to send a
    // field that exists for the benefit of the registration form.
    if (confirmPassword !== undefined && confirmPassword !== password) {
      errors.confirmPassword = 'The two passwords do not match.';
    }

    const cleanRole = typeof role === 'string' ? role.trim().toLowerCase() : ROLES.USER;
    if (!isAssignableRole(cleanRole)) {
      errors.role = `A role must be one of: ${ASSIGNABLE_ROLES.join(', ')}.`;
    }

    const cleanDisplayName =
      typeof displayName === 'string' && displayName.trim() ? displayName.trim().slice(0, 60) : cleanUsername;

    if (Object.keys(errors).length > 0) {
      throw new ValidationError('The account details are not valid.', { fields: errors });
    }

    if (await this.#users.exists(cleanUsername)) {
      throw new AppError('That username is already taken.', {
        status: 409,
        code: 'USERNAME_TAKEN',
        details: { fields: { username: 'That username is already taken.' } },
      });
    }

    const { salt, hash } = await this.#hashPassword(password);

    const record = {
      username: cleanUsername,
      displayName: cleanDisplayName,
      role: cleanRole,
      passwordHash: hash,
      passwordSalt: salt,
      algorithm: 'scrypt',
      createdAt: new Date().toISOString(),
    };

    try {
      await this.#users.insert(record);
    } catch (error) {
      // The unique index caught a registration that raced ours between the
      // exists() check and the insert. Same outcome, same message.
      if (error?.code === 11000) {
        throw new AppError('That username is already taken.', {
          status: 409,
          code: 'USERNAME_TAKEN',
          details: { fields: { username: 'That username is already taken.' } },
        });
      }
      throw error;
    }

    this.#logger?.info('Account created.', { username: cleanUsername, role: cleanRole });

    return { token: this.#issueToken(cleanUsername), user: toPublicUser(record) };
  }

  // --- Login -----------------------------------------------------------------

  async login(username, password) {
    const cleanUsername = typeof username === 'string' ? username.trim().toLowerCase() : '';

    if (!cleanUsername || typeof password !== 'string' || password.length === 0) {
      throw new ValidationError('A username and password are both required.', {
        fields: {
          ...(cleanUsername ? {} : { username: 'A username is required.' }),
          ...(password ? {} : { password: 'A password is required.' }),
        },
      });
    }

    const record = await this.#users.findByUsername(cleanUsername);

    /**
     * A missing account still pays the cost of a hash comparison before
     * failing. Returning early would make "no such user" measurably faster
     * than "wrong password", which is exactly the signal the identical error
     * message exists to withhold.
     */
    const ok = record
      ? await this.#verifyPassword(password, { salt: record.passwordSalt, hash: record.passwordHash })
      : await this.#verifyPassword(password, {
          salt: 'decoy',
          hash: randomBytes(SCRYPT_KEYLEN).toString('hex'),
        });

    if (!record || !ok) {
      this.#logger?.warn('Failed sign-in attempt.', { username: cleanUsername });
      throw new AppError('Incorrect username or password.', {
        status: 401,
        code: 'INVALID_CREDENTIALS',
      });
    }

    this.#logger?.info('Sign-in succeeded.', { username: record.username, role: record.role });

    return { token: this.#issueToken(record.username), user: toPublicUser(record) };
  }

  // --- Verification ----------------------------------------------------------

  /**
   * Resolves a token to the identity it names.
   *
   * The role in the returned identity is read from the stored account record,
   * never from the token. An account altered after its token was issued is
   * therefore reflected on the very next request, and a token cannot assert
   * authority its account does not have.
   */
  async verifyToken(token) {
    const payload = this.#readToken(token);
    if (!payload) return null;

    const record = await this.#users.findByUsername(payload.sub);
    if (!record) return null;

    return toPublicUser(record);
  }

  async findUser(username) {
    return toPublicUser(await this.#users.findByUsername(username));
  }
}
