import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as store from './store.js';
import { getSession, setSession, clearSession } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAX_HINTS_PER_QUESTION = 3; // hints are written up front (see generate.js) and revealed one at a time

const app = express();
app.set('trust proxy', 1); // Vercel / reverse proxies terminate HTTPS for us
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  req.user = getSession(req);
  next();
});

// ---------- helpers ----------
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in' });
    if (role && req.user.role !== role) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isAssigned = (hw, studentId) => hw.assignedTo === 'all' || hw.assignedTo.includes(studentId);

// Strip model answers before sending homework to a student.
const studentView = (hw) => ({
  id: hw.id,
  title: hw.title,
  subject: hw.subject,
  level: hw.level,
  dueDate: hw.dueDate,
  createdAt: hw.createdAt,
  questions: hw.questions.map((q) => ({ id: q.id, text: q.text, hintsAvailable: (q.hints || []).length })),
});

// Seed the admin account once per process (lazily, so it also works on serverless).
let seeded;
const ensureSeeded = () => (seeded ||= store.ensureAdmin().then((c) => {
  if (c) console.log(`Created admin account -> username: ${c.username}  password: ${c.password}`);
}));
app.use(wrap(async (req, res, next) => { await ensureSeeded(); next(); }));

// ---------- auth ----------
app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await store.users.byUsername(username);
  if (!user || !store.verifyPassword(String(password || ''), user)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  setSession(req, res, publicUser(user));
  res.json({ user: publicUser(user) });
}));

app.post('/api/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/password', requireRole(), wrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });
  const user = await store.users.byId(req.user.id);
  if (!user || !store.verifyPassword(String(currentPassword || ''), user)) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  await store.users.save({ ...user, ...store.hashPassword(String(newPassword)) });
  res.json({ ok: true });
}));

// ---------- admin: students ----------
const admin = express.Router();
admin.use(requireRole('admin'));

admin.get('/students', wrap(async (req, res) => {
  res.json({ students: (await store.users.list()).filter((u) => u.role === 'student').map(publicUser) });
}));

admin.post('/students', wrap(async (req, res) => {
  const { username, password, name } = req.body || {};
  const uname = String(username || '').trim();
  if (!uname || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (await store.users.byUsername(uname)) return res.status(409).json({ error: 'That username is already taken' });
  const user = {
    id: store.newId(),
    username: uname,
    name: String(name || uname).trim(),
    role: 'student',
    ...store.hashPassword(String(password)),
    createdAt: new Date().toISOString(),
  };
  await store.users.save(user);
  res.status(201).json({ student: publicUser(user) });
}));

admin.post('/students/:id/password', wrap(async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const user = await store.users.byId(req.params.id);
  if (!user || user.role !== 'student') return res.status(404).json({ error: 'Student not found' });
  await store.users.save({ ...user, ...store.hashPassword(String(password)) });
  res.json({ ok: true });
}));

admin.delete('/students/:id', wrap(async (req, res) => {
  const user = await store.users.byId(req.params.id);
  if (!user || user.role !== 'student') return res.status(404).json({ error: 'Student not found' });
  await store.users.remove(user.id);
  await store.submissions.removeWhere((s) => s.studentId === user.id);
  res.json({ ok: true });
}));

// ---------- admin: homework ----------
admin.get('/homework', wrap(async (req, res) => {
  const subs = await store.submissions.list();
  const list = (await store.homework.list())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((hw) => ({ ...hw, submissionCount: subs.filter((s) => s.homeworkId === hw.id && s.submittedAt).length }));
  res.json({ homework: list });
}));

admin.post('/homework', wrap(async (req, res) => {
  const { title, subject, level, dueDate, questions, assignedTo } = req.body || {};
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required' });
  }
  const studentIds = new Set((await store.users.list()).filter((u) => u.role === 'student').map((u) => u.id));
  const hw = {
    id: store.newId(),
    title: String(title).trim(),
    subject: String(subject || '').trim(),
    level: String(level || '').trim(),
    dueDate: dueDate ? String(dueDate) : null,
    questions: questions
      .filter((q) => q && String(q.text || '').trim())
      .map((q) => ({
        id: store.newId(),
        text: String(q.text).trim(),
        answer: String(q.answer || '').trim(),
        hints: (Array.isArray(q.hints) ? q.hints : [])
          .map((h) => String(h || '').trim())
          .filter(Boolean)
          .slice(0, MAX_HINTS_PER_QUESTION),
      })),
    assignedTo: assignedTo === 'all' || !Array.isArray(assignedTo) ? 'all' : assignedTo.filter((id) => studentIds.has(id)),
    createdAt: new Date().toISOString(),
  };
  if (hw.questions.length === 0) return res.status(400).json({ error: 'Questions cannot be empty' });
  await store.homework.save(hw);
  res.status(201).json({ homework: hw });
}));

admin.delete('/homework/:id', wrap(async (req, res) => {
  const hw = await store.homework.get(req.params.id);
  if (!hw) return res.status(404).json({ error: 'Homework not found' });
  await store.homework.remove(hw.id);
  await store.submissions.removeWhere((s) => s.homeworkId === hw.id);
  res.json({ ok: true });
}));

admin.get('/homework/:id/submissions', wrap(async (req, res) => {
  const hw = await store.homework.get(req.params.id);
  if (!hw) return res.status(404).json({ error: 'Homework not found' });
  const subs = await store.submissions.list();
  const students = (await store.users.list()).filter((u) => u.role === 'student' && isAssigned(hw, u.id));
  const rows = students.map((s) => ({
    student: publicUser(s),
    submission: subs.find((x) => x.homeworkId === hw.id && x.studentId === s.id) || null,
  }));
  res.json({ homework: hw, rows });
}));

app.use('/api/admin', admin);

// ---------- student ----------
const student = express.Router();
student.use(requireRole('student'));

student.get('/homework', wrap(async (req, res) => {
  const me = req.user.id;
  const subs = await store.submissions.list();
  const list = (await store.homework.list())
    .filter((hw) => isAssigned(hw, me))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((hw) => {
      const sub = subs.find((s) => s.homeworkId === hw.id && s.studentId === me);
      return { ...studentView(hw), submitted: !!sub?.submittedAt, submittedAt: sub?.submittedAt || null };
    });
  res.json({ homework: list });
}));

async function loadMyHomework(req, res) {
  const hw = await store.homework.get(req.params.id);
  if (!hw || !isAssigned(hw, req.user.id)) {
    res.status(404).json({ error: 'Homework not found' });
    return null;
  }
  return hw;
}

async function getOrCreateSubmission(hw, studentId) {
  return (await store.submissions.find(hw.id, studentId)) || {
    id: store.newId(), homeworkId: hw.id, studentId, answers: {}, hints: {}, submittedAt: null,
  };
}

student.get('/homework/:id', wrap(async (req, res) => {
  const hw = await loadMyHomework(req, res);
  if (!hw) return;
  const submission = await store.submissions.find(hw.id, req.user.id);
  res.json({ homework: studentView(hw), submission });
}));

student.post('/homework/:id/hint', wrap(async (req, res) => {
  const { questionId, attempt } = req.body || {};
  const hw = await loadMyHomework(req, res);
  if (!hw) return;
  const q = hw.questions.find((x) => x.id === questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });
  const sub = await getOrCreateSubmission(hw, req.user.id);
  if (sub.submittedAt) return res.status(400).json({ error: 'Homework already submitted' });
  const used = sub.hints[q.id] || [];
  const available = q.hints || [];
  if (used.length >= available.length) {
    return res.status(429).json({ error: available.length ? 'No more hints for this question' : 'This question has no hints' });
  }
  const hint = available[used.length];
  used.push({ hint, attempt: String(attempt || ''), at: new Date().toISOString() });
  sub.hints[q.id] = used;
  await store.submissions.save(sub);
  res.json({ hint, hintsUsed: used.length, maxHints: available.length });
}));

async function saveAnswers(req, res, { submit }) {
  const hw = await loadMyHomework(req, res);
  if (!hw) return;
  const sub = await getOrCreateSubmission(hw, req.user.id);
  if (sub.submittedAt) return res.status(400).json({ error: 'Homework already submitted' });
  const answers = req.body?.answers || {};
  for (const q of hw.questions) if (q.id in answers) sub.answers[q.id] = String(answers[q.id]);
  if (submit) sub.submittedAt = new Date().toISOString();
  await store.submissions.save(sub);
  res.json({ ok: true, submission: sub });
}

student.post('/homework/:id/save', wrap((req, res) => saveAnswers(req, res, { submit: false })));
student.post('/homework/:id/submit', wrap((req, res) => saveAnswers(req, res, { submit: true })));

app.use('/api/student', student);

// ---------- pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));

// ---------- errors ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

export default app;

// Run a normal HTTP server when started directly (`node server.js`).
// On Vercel the app is imported by api/index.js instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, async () => {
    console.log(`Homework app running at http://localhost:${PORT}`);
    console.log(`Storage: ${store.backendName}`);
    await ensureSeeded();
  });
}
