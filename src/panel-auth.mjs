import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const sessionSeconds = 12 * 60 * 60;
const rememberSeconds = 30 * 24 * 60 * 60;
const setupMs = 10 * 60_000;

export function same(value, expected) {
  const digest = input => createHash('sha256').update(input).digest();
  return typeof value === 'string' && timingSafeEqual(digest(value), digest(expected));
}

function base32(bytes) {
  let value = 0;
  let bits = 0;
  let result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(value >>> bits) & 31];
    }
  }
  return result;
}

// RFC 6238 with the Google Authenticator defaults (SHA-1, six digits, 30 seconds).
function codeStep(secret, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 30_000);
  const counter = Buffer.alloc(8);
  for (const candidate of [step, step - 1, step + 1]) {
    counter.writeBigUInt64BE(BigInt(candidate));
    const digest = createHmac('sha1', secret).update(counter).digest();
    const offset = digest.at(-1) & 15;
    const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    if (same(code, String(value).padStart(6, '0'))) return candidate;
  }
  return null;
}

export function openPanelAuth(db, { user, password, secure }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS panel_sessions (
      id TEXT PRIMARY KEY, expires INTEGER NOT NULL, remembered INTEGER NOT NULL,
      setup_key BLOB, setup_expires INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS panel_authenticator (
      id INTEGER PRIMARY KEY CHECK (id = 1), secret BLOB NOT NULL, last_step INTEGER NOT NULL
    ) STRICT;
  `);

  const get = db.prepare('SELECT * FROM panel_sessions WHERE id = ? AND expires > ?');
  const insert = db.prepare('INSERT INTO panel_sessions (id, expires, remembered) VALUES (?, ?, ?)');
  const remove = db.prepare('DELETE FROM panel_sessions WHERE id = ?');
  const prune = db.prepare('DELETE FROM panel_sessions WHERE expires <= ?');
  const setSetup = db.prepare('UPDATE panel_sessions SET setup_key = ?, setup_expires = ? WHERE id = ?');
  const getAuthenticator = db.prepare('SELECT secret, last_step FROM panel_authenticator WHERE id = 1');
  const enable = db.prepare('INSERT INTO panel_authenticator VALUES (1, ?, ?)');
  const consume = db.prepare('UPDATE panel_authenticator SET last_step = ? WHERE id = 1 AND secret = ? AND last_step < ?');
  const cookieName = secure ? '__Host-kwh_session' : 'kwh_session';
  const cookie = (value, lifetime) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax` +
    (secure ? '; Secure' : '') + (lifetime === undefined ? '' : `; Max-Age=${lifetime}`);
  // The credentials bind the digest to this configuration. Changing them invalidates older cookies.
  const key = JSON.stringify([user, password]);
  const id = token => createHmac('sha256', token).update(key).digest('hex');

  function session(request) {
    const prefix = cookieName + '=';
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
    if (token && /^[\w-]{43}$/.test(token)) return get.get(id(token), Date.now());
  }

  function issue(remembered) {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    prune.run(now);
    insert.run(id(token), now + 1000 * (remembered ? rememberSeconds : sessionSeconds), Number(remembered));
    return cookie(token, remembered ? rememberSeconds : undefined);
  }

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function verify(authenticator, code) {
    const step = codeStep(authenticator.secret, code);
    return step !== null && Boolean(consume.run(step, authenticator.secret, step).changes);
  }

  return {
    session,
    enabled: () => Boolean(getAuthenticator.get()),
    login(request, body) {
      const validUser = same(body?.user, user);
      const validPassword = same(body?.password, password);
      if (!validUser || !validPassword) return { error: 'credentials' };
      return transaction(() => {
        const authenticator = getAuthenticator.get();
        if (authenticator && !body.code) return { needsCode: true };
        if (authenticator && !verify(authenticator, body.code)) return { error: 'code' };
        const previous = session(request);
        if (previous) remove.run(previous.id);
        return { cookie: issue(body.remember === true) };
      });
    },
    logout(current) {
      if (current) remove.run(current.id);
      return cookie('', 0);
    },
    startSetup(current, input) {
      if (!same(input?.password, password)) return { error: 'password' };
      return transaction(() => {
        if (getAuthenticator.get()) return { error: 'enabled' };
        const secret = randomBytes(20);
        setSetup.run(secret, Date.now() + setupMs, current.id);
        return { key: base32(secret), account: user };
      });
    },
    finishSetup(current, input) {
      return transaction(() => {
        if (getAuthenticator.get()) return { error: 'enabled' };
        const setup = get.get(current.id, Date.now());
        if (!setup?.setup_key || setup.setup_expires <= Date.now()) return { error: 'expired' };
        const step = codeStep(setup.setup_key, input?.code);
        if (step === null) return { error: 'code' };
        enable.run(setup.setup_key, step);
        db.exec('DELETE FROM panel_sessions');
        return { cookie: issue(Boolean(current.remembered)) };
      });
    },
    disable(current, input) {
      if (!same(input?.password, password)) return { error: 'password' };
      return transaction(() => {
        const authenticator = getAuthenticator.get();
        if (!authenticator || !verify(authenticator, input?.code)) return { error: 'code' };
        db.exec('DELETE FROM panel_authenticator; DELETE FROM panel_sessions;');
        return { cookie: issue(Boolean(current.remembered)) };
      });
    },
    reset() {
      transaction(() => db.exec('DELETE FROM panel_authenticator; DELETE FROM panel_sessions;'));
    }
  };
}
