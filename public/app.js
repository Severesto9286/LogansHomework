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

// Renders a "change my password" form into the element with the given id.
function passwordCard(containerId) {
  const el = document.getElementById(containerId);
  el.innerHTML = `<div class="card">
    <h2>Change my password</h2>
    <div class="row">
      <div><label>Current password</label><input id="pw-cur" type="password" autocomplete="current-password"></div>
      <div><label>New password</label><input id="pw-new" type="password" autocomplete="new-password"></div>
      <div><label>Repeat new password</label><input id="pw-new2" type="password" autocomplete="new-password"></div>
    </div>
    <div class="actions"><button id="pw-btn">Update password</button></div>
    <div class="error" id="pw-error"></div>
    <div class="success" id="pw-ok"></div>
  </div>`;
  el.querySelector('#pw-btn').addEventListener('click', async () => {
    const err = el.querySelector('#pw-error'); const ok = el.querySelector('#pw-ok');
    err.textContent = ''; ok.textContent = '';
    const cur = el.querySelector('#pw-cur').value, nw = el.querySelector('#pw-new').value, nw2 = el.querySelector('#pw-new2').value;
    if (nw !== nw2) { err.textContent = 'The new passwords do not match.'; return; }
    try {
      await api('/api/password', { method: 'POST', body: { currentPassword: cur, newPassword: nw } });
      ok.textContent = 'Password updated.';
      ['#pw-cur', '#pw-new', '#pw-new2'].forEach((s) => (el.querySelector(s).value = ''));
    } catch (ex) { err.textContent = ex.message; }
  });
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : '';
}
