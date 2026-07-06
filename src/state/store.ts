import type { Sql } from 'postgres';
import { createConnection, runMigrations } from './db.js';
import type { CalendarEvent, EventKind } from '../agent/schema.js';
import type { Subject } from '../config/subjects.js';

export const DEFAULT_USER_ID = 1;

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
  sectionCode: string | null;
  sourceLabel: string | null;
  lastSyncedAt: string;
}

export interface ChatMessageRow {
  role: 'user' | 'assistant';
  body: string;
  createdAt: string;
}

export interface AnnouncementRow {
  entryId: string;
  subjectId: string | null;
  courseCode: string | null;
  title: string;
  contentHtml: string;
  link: string | null;
  author: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  extractStatus: 'pending' | 'extracted' | 'skipped';
  fetchedAt: string;
}

interface AnnouncementDbRow {
  entryId: string;
  subjectId: string | null;
  courseCode: string | null;
  title: string;
  contentHtml: string;
  link: string | null;
  author: string | null;
  publishedAt: Date | string | null;
  updatedAt: Date | string | null;
  extractStatus: 'pending' | 'extracted' | 'skipped';
  fetchedAt: Date | string;
}

function toIso(v: Date | string): string {
  return typeof v === 'string' ? v : v.toISOString();
}
function toIsoOrNull(v: Date | string | null): string | null {
  if (v === null) return null;
  return toIso(v);
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

  // ---- Canvas token ------------------------------------------------------

  async saveCanvasToken(
    userId: number,
    token: string,
    baseUrl?: string,
  ): Promise<void> {
    await this.sql`
      UPDATE users SET
        canvas_token = ${token},
        canvas_token_updated_at = now(),
        canvas_base_url = COALESCE(${baseUrl ?? null}, canvas_base_url),
        updated_at = now()
      WHERE id = ${userId}
    `;
  }

  async getCanvasToken(
    userId: number = DEFAULT_USER_ID,
  ): Promise<{ token: string; baseUrl: string; updatedAt: Date | null } | null> {
    const rows = await this.sql<
      Array<{ token: string | null; baseUrl: string; updatedAt: Date | null }>
    >`
      SELECT
        canvas_token            AS "token",
        canvas_base_url         AS "baseUrl",
        canvas_token_updated_at AS "updatedAt"
      FROM users WHERE id = ${userId}
    `;
    const row = rows[0];
    if (!row || !row.token) return null;
    return { token: row.token, baseUrl: row.baseUrl, updatedAt: row.updatedAt };
  }

  async clearCanvasToken(userId: number): Promise<void> {
    await this.sql`
      UPDATE users SET
        canvas_token = NULL,
        canvas_token_updated_at = NULL,
        updated_at = now()
      WHERE id = ${userId}
    `;
  }

  // ---- subject <-> Canvas course link ------------------------------------

  async setSubjectCanvasCourseId(
    subjectId: string,
    canvasCourseId: number,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      UPDATE subjects SET canvas_course_id = ${canvasCourseId}, updated_at = now()
      WHERE user_id = ${userId} AND id = ${subjectId}
    `;
  }

  async getCanvasCourseIdForSubject(
    subjectId: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<number | null> {
    const rows = await this.sql<{ canvasCourseId: string | number | null }[]>`
      SELECT canvas_course_id AS "canvasCourseId"
      FROM subjects WHERE user_id = ${userId} AND id = ${subjectId}
    `;
    const v = rows[0]?.canvasCourseId;
    return v === null || v === undefined ? null : Number(v);
  }

  async getSubjectByCanvasCourseId(
    canvasCourseId: number,
    userId: number = DEFAULT_USER_ID,
  ): Promise<Subject | undefined> {
    const rows = await this.sql<SubjectDbRow[]>`
      SELECT
        id, code, name, professor, room, section, term, color
      FROM subjects
      WHERE user_id = ${userId} AND canvas_course_id = ${canvasCourseId}
    `;
    return rows[0] ? rowToSubject(rows[0]) : undefined;
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
    // postgres.js auto-serialises arrays/objects as jsonb when bound directly
    // — do NOT manually JSON.stringify or use ::jsonb, that double-encodes the
    // value and stores it as a jsonb string scalar instead of an array.
    const recurrence =
      event.recurrence && event.recurrence.length > 0 ? event.recurrence : null;
    const sectionCode = event.sectionCode ?? null;
    await this.sql`
      INSERT INTO calendar_items (
        user_id, event_id, subject_id, item_id, kind, summary, description,
        start_iso, end_iso, room, attachments, recurrence, section_code,
        source_label, last_synced_at
      ) VALUES (
        ${userId}, ${eventId}, ${subjectId}, ${event.itemId}, ${event.kind},
        ${event.summary}, ${event.description}, ${event.startDateTime},
        ${event.endDateTime}, ${event.room},
        ${this.sql.json(event.attachments)},
        ${recurrence === null ? null : this.sql.json(recurrence)},
        ${sectionCode}, ${sourceLabel}, now()
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
        section_code = COALESCE(EXCLUDED.section_code, calendar_items.section_code),
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
        sectionCode: string | null;
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
        section_code    AS "sectionCode",
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
      sectionCode: r.sectionCode,
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

  /**
   * Reverse lookup for one-shot handshake tokens (Google OAuth state): find
   * which user a (key, value) pair belongs to and consume it atomically so
   * the same state can't be replayed.
   */
  async consumeSettingByValue(key: string, value: string): Promise<number | null> {
    const rows = await this.sql<{ userId: number }[]>`
      DELETE FROM user_settings
       WHERE key = ${key} AND value = ${value}
      RETURNING user_id AS "userId"
    `;
    return rows[0]?.userId ?? null;
  }

  // ---- announcements (CourSys Atom feed) -------------------------------

  async upsertAnnouncement(
    row: {
      entryId: string;
      subjectId: string | null;
      courseCode: string | null;
      title: string;
      contentHtml: string;
      link: string | null;
      author: string | null;
      publishedAt: string | null;
      updatedAt: string | null;
    },
    userId: number = DEFAULT_USER_ID,
  ): Promise<{ inserted: boolean }> {
    // Use INSERT … ON CONFLICT DO UPDATE returning xmax to tell apart inserts
    // (xmax = 0) from updates. Lets the caller count "new this run".
    const rows = await this.sql<{ inserted: boolean }[]>`
      INSERT INTO announcements (
        user_id, entry_id, subject_id, course_code, title,
        content_html, link, author, published_at, updated_at
      ) VALUES (
        ${userId}, ${row.entryId}, ${row.subjectId}, ${row.courseCode},
        ${row.title}, ${row.contentHtml}, ${row.link}, ${row.author},
        ${row.publishedAt}, ${row.updatedAt}
      )
      ON CONFLICT (user_id, entry_id) DO UPDATE SET
        subject_id   = EXCLUDED.subject_id,
        course_code  = EXCLUDED.course_code,
        title        = EXCLUDED.title,
        content_html = EXCLUDED.content_html,
        link         = EXCLUDED.link,
        author       = EXCLUDED.author,
        published_at = EXCLUDED.published_at,
        updated_at   = EXCLUDED.updated_at
      RETURNING (xmax = 0) AS "inserted"
    `;
    return { inserted: rows[0]?.inserted ?? false };
  }

  async listAnnouncements(
    opts: { subjectId?: string; limit?: number } = {},
    userId: number = DEFAULT_USER_ID,
  ): Promise<AnnouncementRow[]> {
    const sql = this.sql;
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const rows = await sql<AnnouncementDbRow[]>`
      SELECT
        entry_id      AS "entryId",
        subject_id    AS "subjectId",
        course_code   AS "courseCode",
        title         AS "title",
        content_html  AS "contentHtml",
        link          AS "link",
        author        AS "author",
        published_at  AS "publishedAt",
        updated_at    AS "updatedAt",
        extract_status AS "extractStatus",
        fetched_at    AS "fetchedAt"
      FROM announcements
      WHERE user_id = ${userId}
        ${opts.subjectId ? sql`AND subject_id = ${opts.subjectId}` : sql``}
      ORDER BY published_at DESC NULLS LAST, fetched_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => ({
      entryId: r.entryId,
      subjectId: r.subjectId,
      courseCode: r.courseCode,
      title: r.title,
      contentHtml: r.contentHtml,
      link: r.link,
      author: r.author,
      publishedAt: toIsoOrNull(r.publishedAt),
      updatedAt: toIsoOrNull(r.updatedAt),
      extractStatus: r.extractStatus,
      fetchedAt: toIso(r.fetchedAt),
    }));
  }

  /** Announcements the LLM pass hasn't processed yet. */
  async listPendingAnnouncements(
    limit = 25,
    userId: number = DEFAULT_USER_ID,
  ): Promise<AnnouncementRow[]> {
    const rows = await this.sql<AnnouncementDbRow[]>`
      SELECT
        entry_id      AS "entryId",
        subject_id    AS "subjectId",
        course_code   AS "courseCode",
        title         AS "title",
        content_html  AS "contentHtml",
        link          AS "link",
        author        AS "author",
        published_at  AS "publishedAt",
        updated_at    AS "updatedAt",
        extract_status AS "extractStatus",
        fetched_at    AS "fetchedAt"
      FROM announcements
      WHERE user_id = ${userId} AND extract_status = 'pending'
      ORDER BY published_at ASC NULLS FIRST
      LIMIT ${Math.max(1, Math.min(limit, 200))}
    `;
    return rows.map((r) => ({
      entryId: r.entryId,
      subjectId: r.subjectId,
      courseCode: r.courseCode,
      title: r.title,
      contentHtml: r.contentHtml,
      link: r.link,
      author: r.author,
      publishedAt: toIsoOrNull(r.publishedAt),
      updatedAt: toIsoOrNull(r.updatedAt),
      extractStatus: r.extractStatus,
      fetchedAt: toIso(r.fetchedAt),
    }));
  }

  async setAnnouncementExtractStatus(
    entryId: string,
    status: 'pending' | 'extracted' | 'skipped',
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      UPDATE announcements
         SET extract_status = ${status}
       WHERE user_id = ${userId} AND entry_id = ${entryId}
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

  // ---- subjects --------------------------------------------------------

  async listSubjects(userId: number = DEFAULT_USER_ID): Promise<Subject[]> {
    const rows = await this.sql<SubjectDbRow[]>`
      SELECT
        id,
        code,
        name,
        professor,
        room,
        section,
        term,
        color
      FROM subjects
      WHERE user_id = ${userId}
      ORDER BY name ASC
    `;
    return rows.map(rowToSubject);
  }

  async getSubject(
    id: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<Subject | undefined> {
    const rows = await this.sql<SubjectDbRow[]>`
      SELECT
        id,
        code,
        name,
        professor,
        room,
        section,
        term,
        color
      FROM subjects
      WHERE user_id = ${userId} AND id = ${id}
    `;
    return rows[0] ? rowToSubject(rows[0]) : undefined;
  }

  async insertSubject(
    subject: Subject,
    userId: number = DEFAULT_USER_ID,
  ): Promise<{ ok: true } | { ok: false; reason: 'duplicate' }> {
    try {
      await this.sql`
        INSERT INTO subjects (
          user_id, id, code, name, professor, room, section, term, color,
          created_at, updated_at
        ) VALUES (
          ${userId}, ${subject.id}, ${subject.code ?? null}, ${subject.name},
          ${subject.professor}, ${subject.room ?? null},
          ${subject.section ?? null}, ${subject.term ?? null},
          ${subject.color ?? null}, now(), now()
        )
      `;
      return { ok: true };
    } catch (err) {
      // Postgres unique-violation = duplicate id for this user.
      if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate' };
      throw err;
    }
  }

  async replaceSubject(
    subject: Subject,
    userId: number = DEFAULT_USER_ID,
  ): Promise<boolean> {
    const result = await this.sql`
      UPDATE subjects SET
        code = ${subject.code ?? null},
        name = ${subject.name},
        professor = ${subject.professor},
        room = ${subject.room ?? null},
        section = ${subject.section ?? null},
        term = ${subject.term ?? null},
        color = ${subject.color ?? null},
        updated_at = now()
      WHERE user_id = ${userId} AND id = ${subject.id}
    `;
    return (result.count ?? 0) > 0;
  }

  async removeSubject(
    id: string,
    userId: number = DEFAULT_USER_ID,
  ): Promise<boolean> {
    const result = await this.sql`
      DELETE FROM subjects WHERE user_id = ${userId} AND id = ${id}
    `;
    return (result.count ?? 0) > 0;
  }

  // ---- Canvas files mirrored to object storage ---------------------------

  async getFileRecord(
    canvasFileId: number,
    userId: number = DEFAULT_USER_ID,
  ): Promise<FileRecordRow | null> {
    const rows = await this.sql<FileRecordRow[]>`
      SELECT
        canvas_file_id    AS "canvasFileId",
        subject_id        AS "subjectId",
        object_key        AS "objectKey",
        filename          AS "filename",
        content_type      AS "contentType",
        size              AS "size",
        folder_path       AS "folderPath",
        canvas_updated_at AS "canvasUpdatedAt",
        created_at        AS "createdAt"
      FROM files
      WHERE user_id = ${userId} AND canvas_file_id = ${canvasFileId}
    `;
    return rows[0] ?? null;
  }

  async upsertFileRecord(
    row: {
      canvasFileId: number;
      subjectId: string | null;
      objectKey: string;
      filename: string;
      contentType: string | null;
      size: number | null;
      folderPath: string | null;
      canvasUpdatedAt: Date | null;
      sortOrder: number | null;
    },
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      INSERT INTO files (
        user_id, canvas_file_id, subject_id, object_key, filename,
        content_type, size, folder_path, canvas_updated_at, sort_order,
        created_at, updated_at
      ) VALUES (
        ${userId}, ${row.canvasFileId}, ${row.subjectId}, ${row.objectKey},
        ${row.filename}, ${row.contentType}, ${row.size}, ${row.folderPath},
        ${row.canvasUpdatedAt}, ${row.sortOrder}, now(), now()
      )
      ON CONFLICT (user_id, canvas_file_id) DO UPDATE SET
        subject_id        = EXCLUDED.subject_id,
        object_key        = EXCLUDED.object_key,
        filename          = EXCLUDED.filename,
        content_type      = EXCLUDED.content_type,
        size              = EXCLUDED.size,
        folder_path       = EXCLUDED.folder_path,
        canvas_updated_at = EXCLUDED.canvas_updated_at,
        sort_order        = COALESCE(EXCLUDED.sort_order, files.sort_order),
        updated_at        = now()
    `;
  }

  /** Refresh only the ordering of an unchanged (skipped) file. */
  async setFileSortOrder(
    canvasFileId: number,
    sortOrder: number,
    userId: number = DEFAULT_USER_ID,
  ): Promise<void> {
    await this.sql`
      UPDATE files SET sort_order = ${sortOrder}, updated_at = now()
      WHERE user_id = ${userId} AND canvas_file_id = ${canvasFileId}
    `;
  }

  async listFiles(
    opts: { subjectId?: string } = {},
    userId: number = DEFAULT_USER_ID,
  ): Promise<FileRecordRow[]> {
    const sql = this.sql;
    // sort_order mirrors Canvas module/item positions ("Week 1, Week 2, ...").
    return sql<FileRecordRow[]>`
      SELECT
        canvas_file_id    AS "canvasFileId",
        subject_id        AS "subjectId",
        object_key        AS "objectKey",
        filename          AS "filename",
        content_type      AS "contentType",
        size              AS "size",
        folder_path       AS "folderPath",
        canvas_updated_at AS "canvasUpdatedAt",
        created_at        AS "createdAt"
      FROM files
      WHERE user_id = ${userId}
        ${opts.subjectId ? sql`AND subject_id = ${opts.subjectId}` : sql``}
      ORDER BY sort_order NULLS LAST, folder_path NULLS FIRST, filename ASC
    `;
  }

  // ---- users -----------------------------------------------------------

  /**
   * Resolve a Clerk identity to a local user row. Resolution order:
   *  1. existing row already stamped with this Clerk id;
   *  2. legacy row with the same email but no Clerk id yet — claim it, so
   *     data created before the Clerk cutover stays attached;
   *  3. fresh insert.
   */
  async findOrCreateUserByClerkId(input: {
    clerkUserId: string;
    email: string;
    displayName: string | null;
  }): Promise<UserRow> {
    const bySub = await this.sql<UserRow[]>`
      SELECT
        id, email, display_name AS "displayName",
        clerk_user_id AS "clerkUserId", created_at AS "createdAt"
      FROM users WHERE clerk_user_id = ${input.clerkUserId}
    `;
    if (bySub[0]) return bySub[0];

    const claimed = await this.sql<UserRow[]>`
      UPDATE users SET
        clerk_user_id = ${input.clerkUserId},
        display_name = COALESCE(users.display_name, ${input.displayName}),
        updated_at = now()
      WHERE email = ${input.email} AND clerk_user_id IS NULL
      RETURNING
        id, email, display_name AS "displayName",
        clerk_user_id AS "clerkUserId", created_at AS "createdAt"
    `;
    if (claimed[0]) return claimed[0];

    const rows = await this.sql<UserRow[]>`
      INSERT INTO users (email, display_name, clerk_user_id, created_at, updated_at)
      VALUES (${input.email}, ${input.displayName}, ${input.clerkUserId}, now(), now())
      ON CONFLICT (email) DO UPDATE SET
        clerk_user_id = COALESCE(users.clerk_user_id, EXCLUDED.clerk_user_id),
        updated_at = now()
      RETURNING
        id, email, display_name AS "displayName",
        clerk_user_id AS "clerkUserId", created_at AS "createdAt"
    `;
    if (rows.length === 0) {
      throw new Error('findOrCreateUserByClerkId: insert returned no rows');
    }
    return rows[0]!;
  }

  async getUserById(userId: number): Promise<UserRow | null> {
    const rows = await this.sql<UserRow[]>`
      SELECT
        id, email, display_name AS "displayName",
        clerk_user_id AS "clerkUserId", created_at AS "createdAt"
      FROM users WHERE id = ${userId}
    `;
    return rows[0] ?? null;
  }

  /** Every registered user — the multi-user worker loop iterates this. */
  async listUsers(): Promise<UserRow[]> {
    return this.sql<UserRow[]>`
      SELECT
        id, email, display_name AS "displayName",
        clerk_user_id AS "clerkUserId", created_at AS "createdAt"
      FROM users ORDER BY id ASC
    `;
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

  async clearGoogleTokens(userId: number): Promise<void> {
    await this.sql`
      UPDATE users SET
        google_refresh_token = NULL,
        google_access_token = NULL,
        google_access_token_expires = NULL,
        google_scope = NULL,
        google_token_obtained_at = NULL,
        updated_at = now()
      WHERE id = ${userId}
    `;
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
  clerkUserId: string | null;
  createdAt: string | Date;
}

export interface GoogleTokenRow {
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpires: Date | null;
  scope: string | null;
}

export interface FileRecordRow {
  canvasFileId: number;
  subjectId: string | null;
  objectKey: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  folderPath: string | null;
  canvasUpdatedAt: Date | null;
  createdAt: Date | string;
}

interface SubjectDbRow {
  id: string;
  code: string | null;
  name: string;
  professor: string;
  room: string | null;
  section: string | null;
  term: string | null;
  color: string | null;
}

function rowToSubject(row: SubjectDbRow): Subject {
  const out: Subject = {
    id: row.id,
    name: row.name,
    professor: row.professor,
  };
  if (row.code !== null) out.code = row.code;
  if (row.room !== null) out.room = row.room;
  if (row.section !== null) out.section = row.section;
  if (row.term !== null) out.term = row.term;
  if (row.color !== null) out.color = row.color;
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  // postgres.js surfaces the SQLSTATE code on the error object.
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === '23505'
  );
}

// Back-compat type alias so existing imports `StateStore` keep working.
export type StateStore = Store;
