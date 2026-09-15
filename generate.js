#!/usr/bin/env node
// Local tool: generate homework (questions + model answers + hints) with your
// Claude Code login, save it as JSON, and optionally publish it to the server.
//
//   node generate.js --subject Maths --topic "Linear equations" --level "Year 8" --count 5
//   node generate.js ... --publish                      (publish to $HOMEWORK_URL)
//   node generate.js --file homework/linear-equations.json --publish   (publish a saved/edited file)
//
// Publishing needs the server URL and admin login, via flags or env vars:
//   --url https://your-app.vercel.app   HOMEWORK_URL
//   --user admin                        HOMEWORK_ADMIN_USER   (default: admin)
//   --password ...                      HOMEWORK_ADMIN_PASSWORD
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { generateHomework } from './ai.js';

try { process.loadEnvFile('.env'); } catch { /* no .env file - flags or exported env vars are used instead */ }

const { values: args } = parseArgs({
  options: {
    subject: { type: 'string' },
    topic: { type: 'string' },
    level: { type: 'string', default: 'secondary school' },
    count: { type: 'string', default: '5' },
    notes: { type: 'string' },
    title: { type: 'string' },
    due: { type: 'string' },
    assign: { type: 'string', default: 'all' }, // 'all' or comma-separated usernames
    file: { type: 'string' },                   // publish an existing JSON file instead of generating
    out: { type: 'string' },
    publish: { type: 'boolean', default: false },
    url: { type: 'string', default: process.env.HOMEWORK_URL },
    user: { type: 'string', default: process.env.HOMEWORK_ADMIN_USER || 'admin' },
    password: { type: 'string', default: process.env.HOMEWORK_ADMIN_PASSWORD },
    help: { type: 'boolean', default: false },
  },
});

if (args.help || (!args.file && !(args.subject && args.topic))) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(args.help ? 0 : 1);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);

let homework;
let file = args.file;

if (file) {
  homework = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`Loaded ${homework.questions.length} question(s) from ${file}`);
} else {
  const count = Math.min(Math.max(parseInt(args.count, 10) || 5, 1), 20);
  console.log(`Generating ${count} question(s) on "${args.topic}" (${args.subject}, ${args.level})...`);
  const questions = await generateHomework({
    subject: args.subject, topic: args.topic, level: args.level, count, notes: args.notes || '',
  });
  homework = {
    title: args.title || `${args.subject} – ${args.topic}`,
    subject: args.subject,
    level: args.level,
    dueDate: args.due || null,
    questions,
  };
  file = args.out || path.join('homework', `${slug(homework.title)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(homework, null, 2));
  console.log(`Saved to ${file}\n`);

  homework.questions.forEach((q, i) => {
    console.log(`Q${i + 1}. ${q.text}`);
    console.log(`    Final answer: ${q.finalAnswer}`);
    console.log(`    Working: ${q.answer}`);
    q.hints.forEach((h, j) => console.log(`    Hint ${j + 1}: ${h}`));
    console.log();
  });
}

if (!args.publish) {
  console.log('Review/edit the JSON file, then publish it with:');
  console.log(`  node generate.js --file "${file}" --publish --url https://your-app.vercel.app --password <admin password>`);
  process.exit(0);
}

// ---------- publish ----------
await publish().catch((e) => {
  console.error('Error: ' + e.message);
  process.exitCode = 1; // let open sockets close cleanly instead of process.exit()
});

async function publish() {
  if (!args.url) throw new Error('Missing --url (or HOMEWORK_URL)');
  if (!args.password) throw new Error('Missing --password (or HOMEWORK_ADMIN_PASSWORD)');
  const base = args.url.replace(/\/$/, '');

  async function api(p, body, cookie) {
    const res = await fetch(base + p, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${p}: ${typeof data.error === 'string' ? data.error : data.error?.message || res.status}`);
    return { data, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }

  const { cookie } = await api('/api/login', { username: args.user, password: args.password });

  let assignedTo = 'all';
  if (args.assign !== 'all') {
    const { data } = await api('/api/admin/students', null, cookie);
    const wanted = args.assign.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    assignedTo = data.students.filter((st) => wanted.includes(st.username.toLowerCase())).map((st) => st.id);
    const missing = wanted.filter((u) => !data.students.some((st) => st.username.toLowerCase() === u));
    if (missing.length) throw new Error(`Unknown student username(s): ${missing.join(', ')}`);
  }

  const { data } = await api('/api/admin/homework', { ...homework, dueDate: args.due || homework.dueDate, assignedTo }, cookie);
  console.log(`Published "${data.homework.title}" (${data.homework.questions.length} questions) to ${base} -> assigned to ${assignedTo === 'all' ? 'all students' : assignedTo.length + ' student(s)'}.`);
}
