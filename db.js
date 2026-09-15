// Tiny JSON-file database. Fine for a single class; swap for SQLite/Postgres if it grows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB_PATH = path.join(process.cwd(), 'data', 'db.json');

const empty = () => ({ users: [], homework: [], submissions: [] });

let db;
export function load() {
  if (db) return db;
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    db = empty();
  }
  return db;
}

export function save() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

export const newId = () => crypto.randomBytes(8).toString('hex');

// --- passwords (scrypt, no extra deps) ---
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

// --- seed a default admin on first run ---
export function ensureAdmin() {
  const d = load();
  if (d.users.some((u) => u.role === 'admin')) return null;
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  d.users.push({
    id: newId(),
    username: process.env.ADMIN_USERNAME || 'admin',
    name: 'Administrator',
    role: 'admin',
    ...hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  save();
  return { username: d.users[0].username, password };
}
