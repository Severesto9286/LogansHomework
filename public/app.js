// Shared helpers for all pages.
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Redirects to the login page unless the user is logged in with the required role.
async function requireLogin(role) {
  const { user } = await api('/api/me');
  if (!user) { location.href = '/'; return null; }
  if (role && user.role !== role) { location.href = user.role === 'admin' ? '/admin' : '/student'; return null; }
  return user;
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.textContent; btn.innerHTML = `<span class="spinner"></span>${esc(label || 'Working…')}`; }
  else btn.textContent = btn.dataset.label || btn.textContent;
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}
