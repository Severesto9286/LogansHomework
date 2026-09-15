// Storage layer with two backends behind one async interface:
//   - Postgres (Neon) when DATABASE_URL / POSTGRES_URL is set  -> used on Vercel
//   - a JSON file in ./data otherwise                          -> used locally
// Each table holds documents as { id, data } so the two backends stay tiny.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TABLES = ['users', 'homework', 'submissions'];
export const newId = () => crypto.randomBytes(8).toString('hex');

// ---------- JSON file backend ----------
function jsonBackend() {
  const file = path.join(process.cwd(), 'data', 'db.json');
  let cache;
  const load = () => {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { cache = {}; }
    for (const t of TABLES) cache[t] ||= {};
    return cache;
  };
  const flush = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, file);
  };
  return {
    name: 'json file (data/db.json)',
    async all(table) { return Object.values(load()[table]); },
    async get(table, id) { return load()[table][id] || null; },
    async put(table, doc) { load()[table][doc.id] = doc; flush(); return doc; },
    async del(table, id) { delete load()[table][id]; flush(); },
  };
}

// ---------- Postgres (Neon) backend ----------
function pgBackend(url) {
  let sqlPromise;
  const sql = async () => {
    if (!sqlPromise) {
      sqlPromise = (async () => {
        const { neon } = await import('@neondatabase/serverless');
        const q = neon(url);
        for (const t of TABLES) {
          await q.query(`CREATE TABLE IF NOT EXISTS ${t} (id text PRIMARY KEY, data jsonb NOT NULL)`);
        }
        return q;
      })();
    }
    return sqlPromise;
  };
  return {
    name: 'postgres',
    async all(table) {
      const rows = await (await sql()).query(`SELECT data FROM ${table}`);
      return rows.map((r) => r.data);
    },
    async get(table, id) {
      const rows = await (await sql()).query(`SELECT data FROM ${table} WHERE id = $1`, [id]);
      return rows[0]?.data || null;
    },
    async put(table, doc) {
      await (await sql()).query(
        `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [doc.id, JSON.stringify(doc)],
      );
      return doc;
    },
    async del(table, id) {
      await (await sql()).query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    },
  };
}

// Find a Postgres connection string. Vercel/Neon normally set DATABASE_URL, but
// integrations can use a custom prefix (e.g. STORAGE_DATABASE_URL), so also
// accept any *DATABASE_URL / *POSTGRES_URL variable, or any postgres:// value.
function findDbUrl() {
  const env = process.env;
  const isPg = (v) => /^postgres(ql)?:\/\//i.test(String(v || ''));
  const preferred = ['DATABASE_URL', 'POSTGRES_URL', 'NEON_DATABASE_URL', 'POSTGRES_PRISMA_URL'];
  for (const k of preferred) if (isPg(env[k])) return env[k];
  const named = Object.keys(env).filter((k) => /(DATABASE|POSTGRES)_URL$/i.test(k) && isPg(env[k])).sort();
  if (named.length) return env[named[0]];
  const any = Object.keys(env).find((k) => isPg(env[k]));
  return any ? env[any] : undefined;
}

const dbUrl = findDbUrl();
if (!dbUrl && process.env.VERCEL) {
  const seen = Object.keys(process.env).filter((k) => /(DATABASE|POSTGRES|NEON|PG)/i.test(k)).sort();
  throw new Error(
    "No database connection string found in the environment. " +
    "In Vercel: Storage -> connect a Neon (Postgres) database to this project, make sure it is enabled for the Production environment, " +
    "then REDEPLOY (Deployments -> ... -> Redeploy) - environment variables only apply to new deployments. " +
    (seen.length ? "Database-related variables visible to the function: " + seen.join(", ") : "No database-related variables are visible to the function at all."),
  );
}
const backend = dbUrl ? pgBackend(dbUrl) : jsonBackend();
export const backendName = backend.name;

// ---------- typed helpers used by the server ----------
export const users = {
  list: () => backend.all('users'),
  byId: (id) => backend.get('users', id),
  async byUsername(username) {
    const u = String(username || '').trim().toLowerCase();
    return (await backend.all('users')).find((x) => x.username.toLowerCase() === u) || null;
  },
  save: (u) => backend.put('users', u),
  remove: (id) => backend.del('users', id),
};

export const homework = {
  list: () => backend.all('homework'),
  get: (id) => backend.get('homework', id),
  save: (hw) => backend.put('homework', hw),
  remove: (id) => backend.del('homework', id),
};

export const submissions = {
  list: () => backend.all('submissions'),
  async find(homeworkId, studentId) {
    return (await backend.all('submissions')).find((s) => s.homeworkId === homeworkId && s.studentId === studentId) || null;
  },
  save: (s) => backend.put('submissions', s),
  async removeWhere(pred) {
    for (const s of await backend.all('submissions')) if (pred(s)) await backend.del('submissions', s.id);
  },
};

// ---------- passwords (scrypt, no extra deps) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, { salt, hash }) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

// Seed a default admin on first run. Returns the credentials if it created one.
export async function ensureAdmin() {
  if ((await users.list()).some((u) => u.role === 'admin')) return null;
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  await users.save({
    id: newId(),
    username,
    name: 'Administrator',
    role: 'admin',
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  return { username, password };
}
