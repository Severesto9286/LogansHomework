import express from 'express';
import session from 'express-session';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import { generateQuestions, generateHint } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const MAX_HINTS_PER_QUESTION = 3;

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
  }),
);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- helpers ----------
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role });

function requireRole(role) {
  return (req, res, next) => {
    const u = req.session.user;
    if (!u) return res.status(401).json({ error: 'Not logged in' });
    if (role && u.role !== role) return res.status(403).json({ error: 'Forbidden' });
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
  questions: hw.questions.map((q) => ({ id: q.id, text: q.text })),
});

// ---------- auth ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const d = db.load();
  const user = d.users.find((u) => u.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user || !db.verifyPassword(String(password || ''), user)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  req.session.user = publicUser(user);
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- admin: students ----------
const admin = express.Router();
admin.use(requireRole('admin'));

admin.get('/students', (req, res) => {
  const d = db.load();
  res.json({ students: d.users.filter((u) => u.role === 'student').map(publicUser) });
});

admin.post('/students', (req, res) => {
  const { username, password, name } = req.body || {};
  const uname = String(username || '').trim();
  if (!uname || !password) return res.status(400).json({ error: 'Username and password are required' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const d = db.load();
  if (d.users.some((u) => u.username.toLowerCase() === uname.toLowerCase())) {
    return res.status(409).json({ error: 'That username is already taken' });
  }
  const user = {
    id: db.newId(),
    username: uname,
    name: String(name || uname).trim(),
    role: 'student',
    ...db.hashPassword(String(password)),
    createdAt: new Date().toISOString(),
  };
  d.users.push(user);
  db.save();
  res.status(201).json({ student: publicUser(user) });
});

admin.post('/students/:id/password', (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  const d = db.load();
  const user = d.users.find((u) => u.id === req.params.id && u.role === 'student');
  if (!user) return res.status(404).json({ error: 'Student not found' });
  Object.assign(user, db.hashPassword(String(password)));
  db.save();
  res.json({ ok: true });
});

admin.delete('/students/:id', (req, res) => {
  const d = db.load();
  const idx = d.users.findIndex((u) => u.id === req.params.id && u.role === 'student');
  if (idx === -1) return res.status(404).json({ error: 'Student not found' });
  d.users.splice(idx, 1);
  d.submissions = d.submissions.filter((s) => s.studentId !== req.params.id);
  db.save();
  res.json({ ok: true });
});

// ---------- admin: AI question generation ----------
admin.post(
  '/generate',
  wrap(async (req, res) => {
    const { subject, topic, level, count, notes } = req.body || {};
    if (!subject || !topic) return res.status(400).json({ error: 'Subject and topic are required' });
    const n = Math.min(Math.max(parseInt(count, 10) || 5, 1), 20);
    const questions = await generateQuestions({
      subject: String(subject),
      topic: String(topic),
      level: String(level || 'secondary school'),
      count: n,
      notes: notes ? String(notes) : '',
    });
    res.json({ questions });
  }),
);

// ---------- admin: homework ----------
admin.get('/homework', (req, res) => {
  const d = db.load();
  const list = d.homework.map((hw) => ({
    ...hw,
    submissionCount: d.submissions.filter((s) => s.homeworkId === hw.id && s.submittedAt).length,
  }));
  res.json({ homework: list });
});

admin.post('/homework', (req, res) => {
  const { title, subject, level, dueDate, questions, assignedTo } = req.body || {};
  if (!title || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: 'Title and at least one question are required' });
  }
  const d = db.load();
  const studentIds = new Set(d.users.filter((u) => u.role === 'student').map((u) => u.id));
  const hw = {
    id: db.newId(),
    title: String(title).trim(),
    subject: String(subject || '').trim(),
    level: String(level || '').trim(),
    dueDate: dueDate ? String(dueDate) : null,
    questions: questions
      .filter((q) => q && String(q.text || '').trim())
      .map((q) => ({ id: db.newId(), text: String(q.text).trim(), answer: String(q.answer || '').trim() })),
    assignedTo: assignedTo === 'all' || !Array.isArray(assignedTo) ? 'all' : assignedTo.filter((id) => studentIds.has(id)),
    createdAt: new Date().toISOString(),
  };
  if (hw.questions.length === 0) return res.status(400).json({ error: 'Questions cannot be empty' });
  d.homework.push(hw);
  db.save();
  res.status(201).json({ homework: hw });
});

admin.delete('/homework/:id', (req, res) => {
  const d = db.load();
  const idx = d.homework.findIndex((h) => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Homework not found' });
  d.homework.splice(idx, 1);
  d.submissions = d.submissions.filter((s) => s.homeworkId !== req.params.id);
  db.save();
  res.json({ ok: true });
});

admin.get('/homework/:id/submissions', (req, res) => {
  const d = db.load();
  const hw = d.homework.find((h) => h.id === req.params.id);
  if (!hw) return res.status(404).json({ error: 'Homework not found' });
  const students = d.users.filter((u) => u.role === 'student' && isAssigned(hw, u.id));
  const rows = students.map((s) => {
    const sub = d.submissions.find((x) => x.homeworkId === hw.id && x.studentId === s.id);
    return { student: publicUser(s), submission: sub || null };
  });
  res.json({ homework: hw, rows });
});

app.use('/api/admin', admin);

// ---------- student ----------
const student = express.Router();
student.use(requireRole('student'));

student.get('/homework', (req, res) => {
  const d = db.load();
  const me = req.session.user.id;
  const list = d.homework
    .filter((hw) => isAssigned(hw, me))
    .map((hw) => {
      const sub = d.submissions.find((s) => s.homeworkId === hw.id && s.studentId === me);
      return { ...studentView(hw), submitted: !!sub?.submittedAt, submittedAt: sub?.submittedAt || null };
    });
  res.json({ homework: list });
});

student.get('/homework/:id', (req, res) => {
  const d = db.load();
  const me = req.session.user.id;
  const hw = d.homework.find((h) => h.id === req.params.id && isAssigned(h, me));
  if (!hw) return res.status(404).json({ error: 'Homework not found' });
  const sub = d.submissions.find((s) => s.homeworkId === hw.id && s.studentId === me) || null;
  res.json({ homework: studentView(hw), submission: sub, maxHints: MAX_HINTS_PER_QUESTION });
});

function getOrCreateSubmission(d, hw, studentId) {
  let sub = d.submissions.find((s) => s.homeworkId === hw.id && s.studentId === studentId);
  if (!sub) {
    sub = { id: db.newId(), homeworkId: hw.id, studentId, answers: {}, hints: {}, submittedAt: null };
    d.submissions.push(sub);
  }
  return sub;
}

student.post(
  '/homework/:id/hint',
  wrap(async (req, res) => {
    const { questionId, attempt } = req.body || {};
    const d = db.load();
    const me = req.session.user.id;
    const hw = d.homework.find((h) => h.id === req.params.id && isAssigned(h, me));
    if (!hw) return res.status(404).json({ error: 'Homework not found' });
    const q = hw.questions.find((x) => x.id === questionId);
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const sub = getOrCreateSubmission(d, hw, me);
    if (sub.submittedAt) return res.status(400).json({ error: 'Homework already submitted' });
    const used = sub.hints[q.id] || [];
    if (used.length >= MAX_HINTS_PER_QUESTION) {
      return res.status(429).json({ error: `You have used all ${MAX_HINTS_PER_QUESTION} hints for this question` });
    }
    const hint = await generateHint({
      subject: hw.subject,
      level: hw.level,
      question: q.text,
      answer: q.answer,
      attempt: String(attempt || ''),
      hintNumber: used.length + 1,
    });
    used.push({ hint, attempt: String(attempt || ''), at: new Date().toISOString() });
    sub.hints[q.id] = used;
    db.save();
    res.json({ hint, hintsUsed: used.length, maxHints: MAX_HINTS_PER_QUESTION });
  }),
);

student.post('/homework/:id/save', (req, res) => {
  const d = db.load();
  const me = req.session.user.id;
  const hw = d.homework.find((h) => h.id === req.params.id && isAssigned(h, me));
  if (!hw) return res.status(404).json({ error: 'Homework not found' });
  const sub = getOrCreateSubmission(d, hw, me);
  if (sub.submittedAt) return res.status(400).json({ error: 'Homework already submitted' });
  const answers = req.body?.answers || {};
  for (const q of hw.questions) if (q.id in answers) sub.answers[q.id] = String(answers[q.id]);
  db.save();
  res.json({ ok: true });
});

student.post('/homework/:id/submit', (req, res) => {
  const d = db.load();
  const me = req.session.user.id;
  const hw = d.homework.find((h) => h.id === req.params.id && isAssigned(h, me));
  if (!hw) return res.status(404).json({ error: 'Homework not found' });
  const sub = getOrCreateSubmission(d, hw, me);
  if (sub.submittedAt) return res.status(400).json({ error: 'Homework already submitted' });
  const answers = req.body?.answers || {};
  for (const q of hw.questions) if (q.id in answers) sub.answers[q.id] = String(answers[q.id]);
  sub.submittedAt = new Date().toISOString();
  db.save();
  res.json({ ok: true, submission: sub });
});

app.use('/api/student', student);

// ---------- pages ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));

// ---------- errors ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const seeded = db.ensureAdmin();
app.listen(PORT, () => {
  console.log(`Homework app running at http://localhost:${PORT}`);
  if (seeded) console.log(`Created admin account -> username: ${seeded.username}  password: ${seeded.password}`);
});
