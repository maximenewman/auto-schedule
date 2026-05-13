# auto-schedule

Headless TypeScript agent that watches course sources (CourSys course pages and forwarded emails), uses an LLM to extract concrete schedule items (assignments, midterms, lectures, office hours, ...) into a strict Zod schema, and syncs them into Google Calendar idempotently. PDFs and other handouts referenced from the source are downloaded into per-subject folders.

Designed to run from Task Scheduler (Windows) or cron (macOS / Linux) twice a day. Re-runs are safe  -  every calendar event ID is a deterministic function of `(subject.id, itemId)`, every email is dedup'd by Gmail message ID, every site page is dedup'd by SHA-256 of normalized text, and every file is dedup'd by SHA-256 of its bytes.

For internals, read `docs/auto-schedule-architecture.md`.

## Stack

- Node 20+ / TypeScript (strict)
- `puppeteer`  -  CourSys scraping
- `googleapis`  -  Gmail + Calendar
- `ai` + `@ai-sdk/openai`  -  LLM call (Vercel AI SDK, OpenAI provider pointed at OpenRouter)
- `zod`  -  schema + structured-output validation
- `better-sqlite3`  -  state store
- `pino` + `pino-pretty`  -  multi-target structured logging
- `dotenv`  -  config

## One-time setup

### 1. Install

```powershell
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in:

| Var | Required | What it is |
|---|---|---|
| `OPENROUTER_API_KEY` |  | https://openrouter.ai/ key (starts with `sk-or-v1-`) |
| `GOOGLE_OAUTH_CLIENT_ID` |  | "Desktop app" OAuth client from Google Cloud Console |
| `GOOGLE_OAUTH_CLIENT_SECRET` |  | Paired with the client ID |
| `GOOGLE_CALENDAR_ID` | optional | Defaults to `primary` |
| `NTFY_TOPIC` | one of | ntfy topic for auth-failure push |
| `PUSHOVER_TOKEN` + `PUSHOVER_USER` | one of | Pushover credentials, if not using ntfy |
| `AGENT_MODEL` | optional | OpenRouter model string (default `openai/gpt-4o-mini`) |
| `LOG_LEVEL` | optional | `debug` / `info` (default) / `warn` / `error` |
| `LOG_JSON` | optional | `1` to switch logs to raw JSON |

### 3. Google OAuth

In Google Cloud Console, enable the Gmail API and Google Calendar API, configure the OAuth consent screen, add your gmail as a test user, and create a **Desktop app** OAuth client. Then:

```powershell
npm run setup:google
```

Opens a browser, you grant the app Gmail-read + Calendar access, and the refresh token lands at `data/auth/google.json`.

### 4. CourSys

```powershell
npm run setup:coursys
```

Opens a headful Chromium pointed at `https://coursys.sfu.ca/`. Log in via CAS, and once the tab is back on CourSys with a session cookie, the script saves cookies to `data/auth/coursys.json` and closes the browser. No password is ever stored. Sessions last ~7 days; if one expires the pipeline pushes a "re-auth coursys" notification + drops a calendar reminder, and you re-run this command.

### 5. Configure subjects

Edit `src/config/subjects.ts`:

```ts
export const subjects: Subject[] = [
  {
    id: 'cmpt307',
    name: 'CMPT 307',
    professor: 'Valentine Kabanets',
    destinationFolder: 'D:/Desktop/University/Summer 2026/CMPT 307',
    sources: [
      { type: 'email', label: 'CMPT 307' },
      { type: 'site',  url: 'https://coursys.sfu.ca/2026su-cmpt-307-d1/pages/' },
    ],
  },
];
```

- `id` is used to build the calendar event ID  -  keep it short and stable.
- `destinationFolder` can be relative (resolved from the repo root) or absolute.
- `email.label` is a Gmail label. Set up a Gmail filter to apply this label to relevant emails (typically a forwarding rule from your school address).
- `site.url` is any CourSys URL behind CAS auth.

### 6. Build and dry-run

```powershell
npm run build
npm run run
```

Watch the pretty-printed logs in your terminal. Every step is breadcrumbed: subject, source, agent call, calendar upsert, attachment download. Run it twice  -  the second run should report `(no new items)` for everything that was processed on the first run.

## Scheduling

### Windows (Task Scheduler)

`run.bat` is a thin wrapper: it `cd`s into the repo, sets `LOG_FILE` so the pipeline mirrors output to `logs/cron-YYYY-MM-DD.log`, finds `node.exe` even when Task Scheduler launches with a stripped PATH, and propagates the real exit code (0 ok / 1 fatal / 2 reauth) back to Task Scheduler.

Register the task (08:00 and 20:00 daily)  -  copy-paste into PowerShell from the repo root:

```powershell
Unregister-ScheduledTask -TaskName auto-schedule -Confirm:$false -ErrorAction SilentlyContinue

$action   = New-ScheduledTaskAction -Execute "$PWD\run.bat" -WorkingDirectory $PWD
$trigger1 = New-ScheduledTaskTrigger -Daily -At 8am
$trigger2 = New-ScheduledTaskTrigger -Daily -At 8pm
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName "auto-schedule" `
  -Action $action -Trigger $trigger1,$trigger2 -Settings $settings `
  -Description "Course -> Calendar sync (08:00 and 20:00 daily)"
```

Verify and force a run:

```powershell
Get-ScheduledTask -TaskName auto-schedule |
  Select TaskName, State, @{n='NextRun';e={(Get-ScheduledTaskInfo $_).NextRunTime}}

Start-ScheduledTask -TaskName auto-schedule
```

Pause / remove:

```powershell
Disable-ScheduledTask -TaskName auto-schedule
Unregister-ScheduledTask -TaskName auto-schedule -Confirm:$false
```

### macOS / Linux (cron)

`chmod +x run.sh`, then `crontab -e`:

```cron
0 8,20 * * * /absolute/path/to/auto-schedule/run.sh
```

## Web UI

A local dashboard reads the same SQLite state the pipeline writes:

```powershell
npm run serve        # production build
npm run serve:dev    # tsx, no build step needed
```

Open http://127.0.0.1:5174  -  Schedule (week grid + today timeline + upcoming
deadlines) and Subjects (index + per-subject detail with files, sources,
pipeline status) views. Bound to 127.0.0.1 only; no auth. The "Sync now"
button spawns a one-shot run of the pipeline as a subprocess.

The UI reads from `calendar_items` (populated whenever the pipeline upserts
a calendar event). On a fresh install that table is empty until the first
`npm run run` finishes.

## CLI verbs

| Command | What it does |
|---|---|
| `npm run run` | One sync pass over every subject |
| `npm run dev` | Same, via `tsx` (no build step) |
| `npm run serve` | Local web UI on http://127.0.0.1:5174 |
| `npm run serve:dev` | UI via `tsx` |
| `npm run build` | TypeScript -> `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run setup:google` | One-time browser OAuth flow |
| `npm run setup:coursys` | One-time headful CourSys login |
| `node dist/index.js test:calendar` | Insert a "sanity check" event 1 hour from now; re-running updates instead of duplicating |

## Logs

Two streams whenever a run executes:

- **stdout**  -  pretty-printed (colorized in a real TTY)
- **file** (`logs/cron-YYYY-MM-DD.log`)  -  same lines, plain text, written by Node when `LOG_FILE` is set by the wrappers

Agent failures get their own dump at `logs/agent-errors/<timestamp>__<subject>__<slug>.json` with the full `responseBody`, `statusCode`, and `rawModelOutput`  -  the first place to look when extraction misbehaves.

## Troubleshooting

| Symptom | First thing to check |
|---|---|
| `agent extraction failed; errorKind: APICallError, statusCode: 400` | `logs/agent-errors/<...>.json` -> `responseBody`. Usually "out of credits" or a schema-shape mismatch from a model that doesn't support strict structured outputs. Try `AGENT_MODEL=anthropic/claude-haiku-4-5`. |
| `errorKind: NoObjectGeneratedError`, JSON truncated mid-string | Model hit the token cap. Raise `maxTokens` in `src/agent/extractor.ts` (currently 2000). |
| `attachment download failed` with `http 404` | Bad URL on the source side (e.g. a professor referenced a file they haven't uploaded yet). Harmless; will succeed once the file appears. |
| Task Scheduler History shows `Last Run Result: 0x80` | `run.bat` exited because `node` wasn't on PATH. Add the node install dir to the PATH probe list at the top of `run.bat`. |
| Calendar event content didn't update | Did the source content change? If the input is identical, the agent emits identical events and the upsert is a no-op. Try `LOG_LEVEL=debug` and re-run. |
| Site fetcher logs "redirected to cas.sfu.ca" | CourSys session expired  -  run `npm run setup:coursys` again. |

## Layout

```
auto-schedule/
+-- src/
|   +-- agent/        # extractor, prompt, Zod schema
|   +-- auth/         # Google OAuth + CourSys cookies
|   +-- config/       # subjects.ts (user-edited)
|   +-- notify/       # ntfy / Pushover + self-scheduled reauth event
|   +-- sources/      # email + site fetchers + registry
|   +-- state/        # SQLite wrapper
|   +-- sync/         # calendar upsert, file downloader
|   +-- index.ts      # CLI dispatch
|   +-- logger.ts     # pino multi-target
|   +-- pipeline.ts   # orchestrator
+-- docs/
|   +-- auto-schedule-architecture.md
+-- data/             # state.db + auth/  (gitignored)
+-- downloads/        # default destination root (gitignored)
+-- logs/             # cron-YYYY-MM-DD.log + agent-errors/  (gitignored)
+-- run.bat           # Task Scheduler wrapper (Windows)
+-- run.sh            # cron wrapper (macOS / Linux)
```
