# auto-schedule

Multi-user course dashboard for SFU students. It pulls your courses from
**Canvas** (announcements, events, assignment deadlines, and every course
file — including ones hidden in Modules and Pages), optionally merges the
**CourSys** token feeds (iCal schedule + Atom news), runs an LLM over
announcements to extract concrete calendar items, and shows everything on a
web schedule. Files are mirrored into object storage and viewable/downloadable
in the app. Connecting **Google Calendar** is optional — when connected,
events are mirrored there too.

Per-user setup is deliberately tiny: sign in with your email, paste a Canvas
access token, (optionally) paste your CourSys feed URLs, done.

## Stack

- Node 20+ / TypeScript (strict), Fastify 5
- **Clerk** — email-code sign-in (`@clerk/fastify` + clerk-js in the SPA)
- **Neon Postgres** — all state (`postgres` driver, SQL migrations in `src/state/migrations/`)
- **Canvas LMS REST API** — primary source (per-user access token)
- **Tigris** — S3-compatible object storage for course files (`@aws-sdk/client-s3`)
- **Google Calendar API** — optional mirror (events-only scope)
- `ai` + `@ai-sdk/openai` — LLM extraction (Vercel AI SDK pointed at OpenRouter)
- `zod`, `pino`, `dotenv`

## Setup (operator)

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in:
   - `DATABASE_URL` — Neon connection string
   - `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` — Clerk app (email code only)
   - `SESSION_SECRET` — signs short-lived cookies
   - `OPENROUTER_API_KEY` — LLM extraction
   - `GOOGLE_OAUTH_CLIENT_ID/SECRET` — optional, for "Connect Google Calendar";
     the OAuth client needs redirect URI `<PUBLIC_BASE_URL>/auth/google/callback`
     and only the `https://www.googleapis.com/auth/calendar.events` scope
   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_ENDPOINT_URL_S3` /
     `AWS_REGION` / `BUCKET_NAME` — Tigris bucket (file mirroring is skipped
     when unset)
   - `CANVAS_BASE_URL` — defaults to `https://canvas.sfu.ca`
3. `npm run build && npm run serve` (or `npm run serve:dev` for tsx).
   Migrations apply automatically at boot.

Open http://127.0.0.1:5174, sign in, and on the **Subjects** page use the
pills: **Add Canvas token** (Canvas → Account → Settings → New access token),
**Connect Google Calendar** (optional). Canvas sync auto-creates your
subjects, fills the schedule, and mirrors course files.

## Per-user setup (what your friend does)

1. Sign up with email at the app URL.
2. Paste a Canvas access token when prompted — courses, events,
   announcements, and files appear.
3. Optional: add CourSys iCal/Atom URLs (Schedule → iCal subscription,
   Announcements → Atom subscription) for courses that live on CourSys.
4. Optional: Connect Google Calendar.

## How syncing works

`runPipeline` (per user): Canvas (courses → subjects, announcements,
structured events, files) → CourSys iCal feed → CourSys Atom feed → LLM pass
over pending announcements. Everything is idempotent — event ids derive from
`(subjectId, itemId)`, announcements upsert by entry id, files re-download
only when Canvas reports a newer version.

- Manual: the **Sync now** pill, or per subject **Sync files**.
- Worker: `npm run run` syncs every registered user (or one user with
  `AUTO_SCHEDULE_USER_ID=<id>`).

## CLI verbs

| Command | What it does |
|---|---|
| `npm run run` | One sync pass (all users, or `AUTO_SCHEDULE_USER_ID`) |
| `npm run dev` | Same, via `tsx` |
| `npm run serve` / `serve:dev` | Web app on http://127.0.0.1:5174 |
| `npm run build` / `typecheck` | Compile / check |
| `node dist/index.js sync:ical [url]` | iCal feed sync only |
| `node dist/index.js notify:daily` | WhatsApp daily digest |
| `node dist/index.js test:calendar` | Insert a sanity-check Google event |

## Logs

Pretty logs on stdout (`LOG_FILE` mirrors to a file). LLM extraction failures
dump full request/response context to `logs/agent-errors/*.json`.

## Layout

```
auto-schedule/
+-- src/
|   +-- agent/        # LLM extractor, prompt, Zod schema
|   +-- auth/         # optional Google Calendar OAuth
|   +-- bot/          # WhatsApp digest + chat
|   +-- config/       # Subject type + store helpers
|   +-- files/        # Tigris object storage client
|   +-- import/       # canvasSync, canvasFiles, icalSync, atomSync,
|   |                 # announcementExtract, dedup, sfu PDF bootstrap
|   +-- notify/       # ntfy / Pushover push
|   +-- sources/      # canvasClient, icalParser, atomParser
|   +-- state/        # Postgres store + migrations
|   +-- server/       # Fastify routes + no-bundler React SPA (public/)
|   +-- sync/         # Google Calendar upsert/read, local read, classify
|   +-- index.ts      # CLI dispatch
|   +-- pipeline.ts   # per-user orchestrator
+-- logs/             # gitignored
```
