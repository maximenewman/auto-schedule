import type { Sql } from 'postgres';
import { createConnection, runMigrations } from './db.js';
import type { CalendarEvent, EventKind } from '../agent/schema.js';

export const DEFAULT_USER_ID = 1;

export interface SeenEmailRow {
  subjectId: string;
  messageId: string;
  processedAt: string;
}

export interface DownloadedFileRow {
  fileHash: string;
  path: string;
  downloadedAt: string;
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

export interface ChatMessageRow {
  role: 'user' | 'assistant';
  body: string;
  createdAt: string;
}

interface AttachmentRecord {
  url: string;
  filename: string;
}

function normalizeAttachments(value: unknown): AttachmentRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (a): a is AttachmentRecord =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as Record<string, unknown>).url === 'string' &&
      typeof (a as Record<string, unknown>).filename === 'string',
  );
}

function normalizeRecurrence(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value.filter((s): s is string => typeof s === 'string');
  return arr.length === 0 ? null : arr;
}

/**
 * Async Postgres-backed state store. Every method takes a userId so the
 * store stays multi-tenant from the start, but most callers default to
 * DEFAULT_USER_ID until Phase B/C land. Use `Store.create()` to get an
 * instance with migrations already applied.
 */
export class Store {
  private constructor(private readonly sql: Sql) {}

  static async create(connectionString?: string): Promise<Store> {
    const sql = createConnection(connectionString);
    await runMigrations(sql);
    return new Store(sql);
  }

  /** Escape hatch for routes that need raw access — try not to grow this. */
  raw(): Sql {
    return this.sql;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  // ---- email tracking ---------------------------------------------------

  async hasSeenEmail(
    subjectId: string,
    messageId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM seen_emails
         WHERE user_id = ${userId}
           AND subject_id = ${subjectId}
           AND message_id = ${messageId}
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  }

  async markEmailSeen(
    subjectId: string,
    messageId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO seen_emails (user_id, subject_id, message_id, processed_at)
      VALUES (${userId}, ${subjectId}, ${messageId}, now())
      ON CONFLICT (user_id, subject_id, message_id)
      DO UPDATE SET processed_at = EXCLUDED.processed_at
    `;
  }

  // ---- site hash tracking -----------------------------------------------

  async getSiteHash(
    subjectId: string,
    sourceUrl: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<string | undefined> {
    const rows = await this.sql<{ contentHash: string }[]>`
      SELECT content_hash AS "contentHash"
        FROM site_hashes
       WHERE user_id = ${userId}
         AND subject_id = ${subjectId}
         AND source_url = ${sourceUrl}
    `;
    return rows[0]?.contentHash;
  }

  async setSiteHash(
    subjectId: string,
    sourceUrl: string,
    contentHash: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO site_hashes (user_id, subject_id, source_url, content_hash, fetched_at)
      VALUES (${userId}, ${subjectId}, ${sourceUrl}, ${contentHash}, now())
      ON CONFLICT (user_id, subject_id, source_url)
      DO UPDATE SET content_hash = EXCLUDED.content_hash, fetched_at = EXCLUDED.fetched_at
    `;
  }

  // ---- downloaded files (Phase D will drop this) ------------------------

  async hasDownloadedFile(
    fileHash: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<boolean> {
    const rows = await this.sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM downloaded_files
         WHERE user_id = ${userId} AND file_hash = ${fileHash}
      ) AS "exists"
    `;
    return rows[0]?.exists === true;
  }

  async recordDownloadedFile(
    fileHash: string,
    path: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO downloaded_files (user_id, file_hash, path, downloaded_at)
      VALUES (${userId}, ${fileHash}, ${path}, now())
      ON CONFLICT (user_id, file_hash)
      DO UPDATE SET path = EXCLUDED.path, downloaded_at = EXCLUDED.downloaded_at
    `;
  }

  async listDownloadedFilesByPathPrefix(
    prefix: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<DownloadedFileRow[]> {
    // destinationFolder in subjects is forward-slashed; stored paths use the
    // host's separator (backslash on Windows). Normalise on the read path so
    // either form matches.
    const normalizedPrefix = prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    const like = `${normalizedPrefix}/%`;
    const rows = await this.sql<DownloadedFileRow[]>`
      SELECT
        file_hash      AS "fileHash",
        path           AS "path",
        downloaded_at  AS "downloadedAt"
      FROM downloaded_files
      WHERE user_id = ${userId}
        AND REPLACE(path, '\\', '/') LIKE ${like}
      ORDER BY downloaded_at DESC
    `;
    return rows;
  }

  // ---- synced events ----------------------------------------------------

  async recordSyncedEvent(
    eventId: string,
    subjectId: string,
    itemId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO synced_events (user_id, event_id, subject_id, item_id, last_synced_at)
      VALUES (${userId}, ${eventId}, ${subjectId}, ${itemId}, now())
      ON CONFLICT (user_id, event_id)
      DO UPDATE SET
        subject_id = EXCLUDED.subject_id,
        item_id    = EXCLUDED.item_id,
        last_synced_at = EXCLUDED.last_synced_at
    `;
  }

  async deleteSyncedEventsForSubject(
    subjectId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<number> {
    const rows = await this.sql`
      DELETE FROM synced_events
       WHERE user_id = ${userId} AND subject_id = ${subjectId}
    `;
    return rows.count ?? 0;
  }

  // ---- calendar items ---------------------------------------------------

  async upsertCalendarItem(
    eventId: string,
    subjectId: string,
    event: CalendarEvent,
    sourceLabel: string | null,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    const attachments = JSON.stringify(event.attachments);
    const recurrence =
      event.recurrence && event.recurrence.length > 0
        ? JSON.stringify(event.recurrence)
        : null;
    await this.sql`
      INSERT INTO calendar_items (
        user_id, event_id, subject_id, item_id, kind, summary, description,
        start_iso, end_iso, room, attachments, recurrence, source_label,
        last_synced_at
      ) VALUES (
        ${userId}, ${eventId}, ${subjectId}, ${event.itemId}, ${event.kind},
        ${event.summary}, ${event.description}, ${event.startDateTime},
        ${event.endDateTime}, ${event.room},
        ${attachments}::jsonb, ${recurrence}::jsonb, ${sourceLabel}, now()
      )
      ON CONFLICT (user_id, event_id) DO UPDATE SET
        subject_id = EXCLUDED.subject_id,
        item_id = EXCLUDED.item_id,
        kind = EXCLUDED.kind,
        summary = EXCLUDED.summary,
        description = EXCLUDED.description,
        start_iso = EXCLUDED.start_iso,
        end_iso = EXCLUDED.end_iso,
        room = EXCLUDED.room,
        attachments = EXCLUDED.attachments,
        recurrence = EXCLUDED.recurrence,
        source_label = EXCLUDED.source_label,
        last_synced_at = EXCLUDED.last_synced_at
    `;
  }

  async listCalendarItems(
    opts: {
      subjectId?: string;
      fromISO?: string;
      toISO?: string;
    } = {},
    userId: number = DEFAULT_USER_ID,
  ): Promise<CalendarItemRow[]> {
    const sql = this.sql;
    const rows = await sql<
      Array<{
        eventId: string;
        subjectId: string;
        itemId: string;
        kind: EventKind;
        summary: string;
        description: string;
        startISO: string;
        endISO: string;
        room: string | null;
        attachments: unknown;
        recurrence: unknown;
        sourceLabel: string | null;
        lastSyncedAt: string;
      }>
    >`
      SELECT
        event_id        AS "eventId",
        subject_id      AS "subjectId",
        item_id         AS "itemId",
        kind            AS "kind",
        summary         AS "summary",
        description     AS "description",
        start_iso       AS "startISO",
        end_iso         AS "endISO",
        room            AS "room",
        attachments     AS "attachments",
        recurrence      AS "recurrence",
        source_label    AS "sourceLabel",
        last_synced_at  AS "lastSyncedAt"
      FROM calendar_items
      WHERE user_id = ${userId}
        ${opts.subjectId ? sql`AND subject_id = ${opts.subjectId}` : sql``}
        ${opts.fromISO ? sql`AND start_iso >= ${opts.fromISO}` : sql``}
        ${opts.toISO ? sql`AND start_iso <  ${opts.toISO}` : sql``}
      ORDER BY start_iso ASC
    `;
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
      attachments: normalizeAttachments(r.attachments),
      recurrence: normalizeRecurrence(r.recurrence),
      sourceLabel: r.sourceLabel,
      lastSyncedAt: typeof r.lastSyncedAt === 'string'
        ? r.lastSyncedAt
        : new Date(r.lastSyncedAt).toISOString(),
    }));
  }

  async deleteCalendarItemByEventId(
    eventId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<number> {
    const rows = await this.sql`
      DELETE FROM calendar_items
       WHERE user_id = ${userId} AND event_id = ${eventId}
    `;
    return rows.count ?? 0;
  }

  async deleteCalendarItemsForSubject(
    subjectId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<number> {
    const rows = await this.sql`
      DELETE FROM calendar_items
       WHERE user_id = ${userId} AND subject_id = ${subjectId}
    `;
    return rows.count ?? 0;
  }

  // ---- event redirects --------------------------------------------------

  async getEventRedirect(
    subjectId: string,
    itemId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<string | null> {
    const rows = await this.sql<{ target: string }[]>`
      SELECT target_event_id AS "target"
        FROM event_redirects
       WHERE user_id = ${userId}
         AND subject_id = ${subjectId}
         AND item_id = ${itemId}
    `;
    return rows[0]?.target ?? null;
  }

  async setEventRedirect(
    subjectId: string,
    itemId: string,
    targetEventId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO event_redirects (user_id, subject_id, item_id, target_event_id, created_at)
      VALUES (${userId}, ${subjectId}, ${itemId}, ${targetEventId}, now())
      ON CONFLICT (user_id, subject_id, item_id)
      DO UPDATE SET
        target_event_id = EXCLUDED.target_event_id,
        created_at = EXCLUDED.created_at
    `;
  }

  // ---- per-user key/value settings -------------------------------------

  async getSetting(
    key: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<string | null> {
    const rows = await this.sql<{ value: string }[]>`
      SELECT value FROM user_settings
       WHERE user_id = ${userId} AND key = ${key}
    `;
    return rows[0]?.value ?? null;
  }

  async setSetting(
    key: string,
    value: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO user_settings (user_id, key, value, updated_at)
      VALUES (${userId}, ${key}, ${value}, now())
      ON CONFLICT (user_id, key)
      DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;
  }

  async deleteSetting(
    key: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      DELETE FROM user_settings
       WHERE user_id = ${userId} AND key = ${key}
    `;
  }

  // ---- WhatsApp chat history -------------------------------------------

  async appendChatMessage(
    phone: string,
    role: 'user' | 'assistant',
    body: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO whatsapp_messages (user_id, phone, role, body, created_at)
      VALUES (${userId}, ${phone}, ${role}, ${body}, now())
    `;
  }

  async getRecentChatMessages(
    phone: string,
    limit = 10,
    userId: number = DEFAULT_USER_ID,
  ): Promise<ChatMessageRow[]> {
    const rows = await this.sql<
      Array<{ role: 'user' | 'assistant'; body: string; createdAt: Date | string }>
    >`
      SELECT role, body, created_at AS "createdAt"
        FROM whatsapp_messages
       WHERE user_id = ${userId} AND phone = ${phone}
       ORDER BY id DESC
       LIMIT ${limit}
    `;
    return rows
      .map((r) => ({
        role: r.role,
        body: r.body,
        createdAt:
          typeof r.createdAt === 'string'
            ? r.createdAt
            : r.createdAt.toISOString(),
      }))
      .reverse();
  }

  // ---- users -----------------------------------------------------------

  async findOrCreateUserByGoogleSub(input: {
    sub: string;
    email: string;
    displayName: string | null;
  }): Promise<UserRow> {
    const rows = await this.sql<UserRow[]>`
      INSERT INTO users (email, display_name, google_sub, created_at, updated_at)
      VALUES (${input.email}, ${input.displayName}, ${input.sub}, now(), now())
      ON CONFLICT (google_sub) DO UPDATE SET
        email = EXCLUDED.email,
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        updated_at = now()
      RETURNING
        id, email, display_name AS "displayName", google_sub AS "googleSub",
        created_at AS "createdAt"
    `;
    if (rows.length === 0) {
      throw new Error('findOrCreateUserByGoogleSub: insert returned no rows');
    }
    return rows[0]!;
  }

  async getUserById(userId: number): Promise<UserRow | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT
        id, email, display_name AS "displayName", google_sub AS "googleSub",
        created_at AS "createdAt"
      FROM users WHERE id = ${userId}
    `;
    return rows[0] ?? null;
  }

  async saveGoogleTokens(
    userId: number,
    tokens: {
      refreshToken: string | null;
      accessToken: string | null;
      accessTokenExpires: Date | null;
      scope: string | null;
    },
  ): Promise<void> {
    // refresh_token only ships on the very first consent. Preserve any
    // previously-saved value when the new exchange omits it.
    await this.sql`
      UPDATE users SET
        google_refresh_token = COALESCE(${tokens.refreshToken}, google_refresh_token),
        google_access_token = ${tokens.accessToken},
        google_access_token_expires = ${tokens.accessTokenExpires},
        google_scope = ${tokens.scope},
        google_token_obtained_at = now(),
        updated_at = now()
      WHERE id = ${userId}
    `;
  }

  async getGoogleTokens(userId: number): Promise<GoogleTokenRow | null> {
    const rows = await this.sql<GoogleTokenRow[]>`
      SELECT
        google_refresh_token        AS "refreshToken",
        google_access_token         AS "accessToken",
        google_access_token_expires AS "accessTokenExpires",
        google_scope                AS "scope"
      FROM users WHERE id = ${userId}
    `;
    return rows[0] ?? null;
  }

  // ---- sessions --------------------------------------------------------

  async createSession(
    sessionId: string,
    userId: number,
    expiresAt: Date,
  ): Promise<void> {
    await this.sql`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (${sessionId}, ${userId}, ${expiresAt})
    `;
  }

  async getActiveSession(sessionId: string): Promise<SessionRow | null> {
    const rows = await this.sql<SessionRow[]>`
      SELECT id, user_id AS "userId", expires_at AS "expiresAt"
        FROM sessions
       WHERE id = ${sessionId} AND expires_at > now()
    `;
    if (rows.length === 0) return null;
    // Bump last_seen so we can prune stale sessions later.
    await this.sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${sessionId}`;
    return rows[0]!;
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE id = ${sessionId}`;
  }

  // ---- agent error counter (file-system backed; routes layer overrides) -

  countAgentErrorsBetween(_fromISO: string, _toISO: string): number {
    return 0;
  }
}

export interface UserRow {
  id: number;
  email: string;
  displayName: string | null;
  googleSub: string | null;
  createdAt: string | Date;
}

export interface GoogleTokenRow {
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpires: Date | null;
  scope: string | null;
}

export interface SessionRow {
  id: string;
  userId: number;
  expiresAt: Date;
}

// Back-compat type alias so existing imports `StateStore` keep working.
export type StateStore = Store;
