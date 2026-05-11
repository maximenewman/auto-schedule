import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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
    `);
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

  close(): void {
    this.db.close();
  }
}
