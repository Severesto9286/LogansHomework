// Stateless signed-cookie sessions (HMAC-SHA256). No server-side session store,
// so it works on serverless hosts like Vercel where memory is not shared.
import crypto from 'node:crypto';

const COOKIE = 'hw_session';
const MAX_AGE_S = 60 * 60 * 12; // 12 hours

const secret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET is not set: logins will not survive a restart. Set it in production.');
}

const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function getSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.user;
  } catch {
    return null;
  }
}

function cookieAttrs(req) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function setSession(req, res, user) {
  const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() + MAX_AGE_S * 1000 })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; Max-Age=${MAX_AGE_S}; ${cookieAttrs(req)}`);
}

export function clearSession(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`);
}
