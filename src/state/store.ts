import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CalendarEvent, EventKind } from '../agent/schema.js';

export interface SeenEmailRow {
  subjectId: string;
  messageId: string;
  processedAt: string;
}

export interface SiteHashRow {
  subjectId: string;
  sourceUrl: string;
  contentHash: string;
  fetchedAt: string;
}

export interface DownloadedFileRow {
  fileHash: string;
  path: string;
  downloadedAt: string;
}

export interface SyncedEventRow {
  eventId: string;
  subjectId: string;
  itemId: string;
  lastSyncedAt: string;
}

export interface CalendarItemRow {
  eventId: string;
  subjectId: string;
  itemId: string;
  kind: EventKind;
  summary: string;
  description: string;
  startISO: string;
  endISO: string;
  room: string | null;
  attachments: { url: string; filename: string }[];
  recurrence: string[] | null;
  sourceLabel: string | null;
  lastSyncedAt: string;
}

export class StateStore {
  private readonly db: Database.Database;

  constructor(dbPath = 'data/state.db') {
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });
    this.db = new Database(abs);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_emails (
        subject_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS site_hashes (
        subject_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (subject_id, source_url)
      );

      CREATE TABLE IF NOT EXISTS downloaded_files (
        file_hash TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        downloaded_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS synced_events (
        event_id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        last_synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calendar_items (
        event_id         TEXT PRIMARY KEY,
        subject_id       TEXT NOT NULL,
        item_id          TEXT NOT NULL,
        kind             TEXT NOT NULL,
        summary          TEXT NOT NULL,
        description      TEXT NOT NULL DEFAULT '',
        start_iso        TEXT NOT NULL,
        end_iso          TEXT NOT NULL,
        room             TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        source_label     TEXT,
        last_synced_at   TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_calendar_items_subject_start
        ON calendar_items(subject_id, start_iso);
      CREATE INDEX IF NOT EXISTS idx_calendar_items_start
        ON calendar_items(start_iso);

      CREATE TABLE IF NOT EXISTS user_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- After the dedup agent merges two events that came from different
      -- sources (PDF + iCal), the loser's source (subject_id, item_id) is
      -- recorded here pointing at the winner's Google event id. Future
      -- syncs see the redirect and fill into the canonical event instead
      -- of materialising the duplicate again.
      CREATE TABLE IF NOT EXISTS event_redirects (
        subject_id      TEXT NOT NULL,
        item_id         TEXT NOT NULL,
        target_event_id TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        PRIMARY KEY (subject_id, item_id)
      );

      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        phone      TEXT NOT NULL,
        role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone_created
        ON whatsapp_messages(phone, created_at);
    `);
    // Idempotent column add  -  `ALTER TABLE ADD COLUMN` errors if the column
    // already exists, so check first.
    const cols = this.db
      .prepare("PRAGMA table_info(calendar_items)")
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === 'recurrence_json')) {
      this.db.exec("ALTER TABLE calendar_items ADD COLUMN recurrence_json TEXT");
    }
  }

  hasSeenEmail(subjectId: string, messageId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM seen_emails WHERE subject_id = ? AND message_id = ?',
      )
      .get(subjectId, messageId);
    return row !== undefined;
  }

  markEmailSeen(subjectId: string, messageId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO seen_emails (subject_id, message_id, processed_at)
         VALUES (?, ?, ?)`,
      )
      .run(subjectId, messageId, new Date().toISOString());
  }

  getSiteHash(subjectId: string, sourceUrl: string): string | undefined {
    const row = this.db
      .prepare(
        'SELECT content_hash AS contentHash FROM site_hashes WHERE subject_id = ? AND source_url = ?',
      )
      .get(subjectId, sourceUrl) as { contentHash: string } | undefined;
    return row?.contentHash;
  }

  setSiteHash(subjectId: string, sourceUrl: string, contentHash: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO site_hashes (subject_id, source_url, content_hash, fetched_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(subjectId, sourceUrl, contentHash, new Date().toISOString());
  }

  hasDownloadedFile(fileHash: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM downloaded_files WHERE file_hash = ?')
      .get(fileHash);
    return row !== undefined;
  }

  recordDownloadedFile(fileHash: string, path: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO downloaded_files (file_hash, path, downloaded_at)
         VALUES (?, ?, ?)`,
      )
      .run(fileHash, path, new Date().toISOString());
  }

  recordSyncedEvent(
    eventId: string,
    subjectId: string,
    itemId: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO synced_events (event_id, subject_id, item_id, last_synced_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(eventId, subjectId, itemId, new Date().toISOString());
  }

  upsertCalendarItem(
    eventId: string,
    subjectId: string,
    event: CalendarEvent,
    sourceLabel: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO calendar_items
          (event_id, subject_id, item_id, kind, summary, description,
           start_iso, end_iso, room, attachments_json, source_label, last_synced_at,
           recurrence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        eventId,
        subjectId,
        event.itemId,
        event.kind,
        event.summary,
        event.description,
        event.startDateTime,
        event.endDateTime,
        event.room,
        JSON.stringify(event.attachments),
        sourceLabel,
        new Date().toISOString(),
        event.recurrence && event.recurrence.length > 0
          ? JSON.stringify(event.recurrence)
          : null,
      );
  }

  listCalendarItems(opts: {
    subjectId?: string;
    fromISO?: string;
    toISO?: string;
  } = {}): CalendarItemRow[] {
    const where: string[] = [];
    const args: (string | undefined)[] = [];
    if (opts.subjectId) { where.push('subject_id = ?'); args.push(opts.subjectId); }
    if (opts.fromISO)   { where.push('start_iso >= ?'); args.push(opts.fromISO); }
    if (opts.toISO)     { where.push('start_iso < ?');  args.push(opts.toISO); }
    const sql = `
      SELECT
        event_id      AS eventId,
        subject_id    AS subjectId,
        item_id       AS itemId,
        kind          AS kind,
        summary       AS summary,
        description   AS description,
        start_iso     AS startISO,
        end_iso       AS endISO,
        room          AS room,
        attachments_json AS attachmentsJson,
        source_label  AS sourceLabel,
        last_synced_at AS lastSyncedAt,
        recurrence_json AS recurrenceJson
      FROM calendar_items
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY start_iso ASC
    `;
    const rows = this.db.prepare(sql).all(...args) as Array<
      Omit<CalendarItemRow, 'attachments' | 'recurrence'> & {
        attachmentsJson: string;
        recurrenceJson: string | null;
      }
    >;
    return rows.map((r) => ({
      eventId: r.eventId,
      subjectId: r.subjectId,
      itemId: r.itemId,
      kind: r.kind,
      summary: r.summary,
      description: r.description,
      startISO: r.startISO,
      endISO: r.endISO,
      room: r.room,
      attachments: safeParseAttachments(r.attachmentsJson),
      recurrence: safeParseStringArray(r.recurrenceJson),
      sourceLabel: r.sourceLabel,
      lastSyncedAt: r.lastSyncedAt,
    }));
  }

  listDownloadedFilesByPathPrefix(prefix: string): DownloadedFileRow[] {
    // Stored paths use the OS-native separator (backslash on Windows) but
    // destinationFolder in subjects is forward-slashed. Normalize both sides
    // so the prefix match doesn't care which separator was used.
    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    const rows = this.db
      .prepare(
        `SELECT
            file_hash      AS fileHash,
            path           AS path,
            downloaded_at  AS downloadedAt
          FROM downloaded_files
          WHERE REPLACE(path, '\\', '/') LIKE ?
          ORDER BY downloaded_at DESC`,
      )
      .all(`${normalizedPrefix}/%`) as DownloadedFileRow[];
    return rows;
  }

  deleteCalendarItemByEventId(eventId: string): number {
    const info = this.db
      .prepare('DELETE FROM calendar_items WHERE event_id = ?')
      .run(eventId);
    return Number(info.changes ?? 0);
  }

  deleteCalendarItemsForSubject(subjectId: string): number {
    const info = this.db
      .prepare('DELETE FROM calendar_items WHERE subject_id = ?')
      .run(subjectId);
    return Number(info.changes ?? 0);
  }

  deleteSyncedEventsForSubject(subjectId: string): number {
    const info = this.db
      .prepare('DELETE FROM synced_events WHERE subject_id = ?')
      .run(subjectId);
    return Number(info.changes ?? 0);
  }

  getEventRedirect(subjectId: string, itemId: string): string | null {
    const row = this.db
      .prepare(
        'SELECT target_event_id AS target FROM event_redirects WHERE subject_id = ? AND item_id = ?',
      )
      .get(subjectId, itemId) as { target: string } | undefined;
    return row?.target ?? null;
  }

  setEventRedirect(subjectId: string, itemId: string, targetEventId: string): void {
    this.db
      .prepare(
        `INSERT INTO event_redirects (subject_id, item_id, target_event_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(subject_id, item_id) DO UPDATE SET
           target_event_id = excluded.target_event_id,
           created_at = excluded.created_at`,
      )
      .run(subjectId, itemId, targetEventId, new Date().toISOString());
  }

  getSetting(key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM user_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO user_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM user_settings WHERE key = ?').run(key);
  }

  appendChatMessage(
    phone: string,
    role: 'user' | 'assistant',
    body: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO whatsapp_messages (phone, role, body, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(phone, role, body, new Date().toISOString());
  }

  getRecentChatMessages(
    phone: string,
    limit = 10,
  ): { role: 'user' | 'assistant'; body: string; createdAt: string }[] {
    const rows = this.db
      .prepare(
        `SELECT role, body, created_at AS createdAt
           FROM whatsapp_messages
          WHERE phone = ?
          ORDER BY id DESC
          LIMIT ?`,
      )
      .all(phone, limit) as Array<{
        role: 'user' | 'assistant';
        body: string;
        createdAt: string;
      }>;
    return rows.reverse();
  }

  /** For the UI status block. */
  countAgentErrorsBetween(_fromISO: string, _toISO: string): number {
    // The pipeline writes agent errors to disk, not to SQLite. Returning 0
    // here is a stub the routes layer can override by counting files.
    return 0;
  }

  close(): void {
    this.db.close();
  }
}

function safeParseAttachments(json: string): { url: string; filename: string }[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a) => a && typeof a.url === 'string' && typeof a.filename === 'string',
    );
  } catch {
    return [];
  }
}

function safeParseStringArray(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((s) => typeof s === 'string');
  } catch {
    return null;
  }
}
