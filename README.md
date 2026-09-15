# Homework app

A small website where an administrator sets homework and students answer it,
revealing pre-written hints one at a time.

The AI part happens **on your own computer** using your Claude Code login: a
local tool generates the questions, model answers and three progressive hints
per question, then publishes them to the server. The hosted server has **no AI
and no API key** — it just stores and serves what you generated.

```
your PC                                        Vercel
┌──────────────────────────────┐   publish    ┌──────────────────────────┐
│ node generate.js ...         │ ───────────▶ │ server.js + Postgres     │
│ (Claude Agent SDK, uses your │              │ admin & student pages    │
│  Claude Code subscription)   │              │ hints revealed on demand │
└──────────────────────────────┘              └──────────────────────────┘
```

## 1. Deploy the server to Vercel

1. vercel.com → Add New Project → import `LogansHomework` (framework "Other").
2. **Storage → Create Database → Neon (Postgres)** → connect. This sets `DATABASE_URL`.
3. Settings → Environment Variables:

   | Variable | Value |
   |---|---|
   | `SESSION_SECRET` | Any long random string |
   | `ADMIN_PASSWORD` | The admin password you want (used when the admin account is first created) |

4. Deploy. Log in at `https://<your-project>.vercel.app` as `admin`, and add
   students in the **Students** tab.

## 2. Generate homework locally

```
npm install
node generate.js --subject Maths --topic "Linear equations" --level "Year 8" --count 5
```

This uses the Claude Agent SDK with your Claude Code login (no API key), prints
the questions/answers/hints, and saves them to `homework/<title>.json`. Edit the
file if you like, then publish it:

```
node generate.js --file "homework/maths-linear-equations.json" --publish ^
  --url https://<your-project>.vercel.app --password <admin password>
```

Or generate and publish in one go by adding `--publish` to the first command.
Options:

| Flag | Meaning |
|---|---|
| `--count 5` | Number of questions (1–20) |
| `--notes "..."` | Extra instructions for the generator (e.g. "include one word problem") |
| `--title "..."` | Homework title (default: "Subject – Topic") |
| `--due 2026-09-30` | Due date |
| `--assign all` / `--assign alice,bob` | Everyone, or specific student usernames |
| `--url`, `--user`, `--password` | Server and admin login; or set `HOMEWORK_URL`, `HOMEWORK_ADMIN_USER`, `HOMEWORK_ADMIN_PASSWORD` |
| `AI_MODEL=sonnet` (env) | Use a different Claude model for generation |

You can also import a generated `.json` file (or paste it) in the admin page's
**Create homework** tab, edit questions and hints there, and add questions by hand.

## What students see

Assigned homework, a text box per question, **Get a hint** (reveals hint 1, then
2, then 3 — never the answer), save progress, and a one-time submit. The admin
sees every answer and which hints each student used.

## Run the server locally instead

```
npm start           # http://localhost:3000, data in data/db.json
```

First start prints the admin login (default `admin` / `admin123`). Publish to it
with `--url http://localhost:3000`.

## Environment variables

| Variable | Where | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` / `POSTGRES_URL` | server | unset | Postgres connection; unset = JSON file |
| `SESSION_SECRET` | server | random each start | Signs login cookies; required on Vercel |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | server | `admin` / `admin123` | First-run admin account |
| `PORT` | server | `3000` | Local port |
| `HOMEWORK_URL`, `HOMEWORK_ADMIN_USER`, `HOMEWORK_ADMIN_PASSWORD` | generator | — | Defaults for `--url`, `--user`, `--password` |
| `AI_MODEL` | generator | Claude Code default | Model for generation |

## Files

`server.js` routes · `store.js` JSON-file / Postgres storage · `auth.js` cookie
sessions · `ai.js` + `generate.js` local generator · `public/` pages ·
`api/index.js` + `vercel.json` Vercel entry. The Agent SDK is an optional
dependency; Vercel installs with `--omit=optional` so its ~200 MB Claude binary
never ships to the server.
