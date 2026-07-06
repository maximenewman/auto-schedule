import type { StateStore } from '../state/store.js';
import type { CanvasClient, CanvasFile } from '../sources/canvasClient.js';
import { putObjectStream, storageConfigured } from '../files/storage.js';
import { logger } from '../logger.js';

export interface FileSyncResult {
  downloaded: number;
  skipped: number;
  failures: number;
}

const MAX_BYTES = 100 * 1024 * 1024; // per-file cap

/**
 * Mirror one Canvas course's files into object storage. Dedup: a file is
 * only fetched when the DB has no row for its canvas_file_id or Canvas
 * reports a newer updated_at. Object keys are stable per file id, so a
 * re-download of a new version overwrites in place — the bucket never
 * accumulates duplicates.
 */
export async function syncCourseFiles(opts: {
  client: CanvasClient;
  courseId: number;
  subjectId: string;
  store: StateStore;
  userId?: number;
}): Promise<FileSyncResult> {
  const result: FileSyncResult = { downloaded: 0, skipped: 0, failures: 0 };
  if (!storageConfigured()) {
    logger.info('canvas files: object storage not configured — skipping');
    return result;
  }

  let files = await opts.client.listCourseFiles(opts.courseId);
  const folderName = new Map<number, string>(); // fileId -> display folder

  if (files !== null) {
    const folders = await opts.client.listCourseFolders(opts.courseId);
    const folderById = new Map(folders.map((f) => [f.id, f.full_name]));
    for (const f of files) {
      const name = folderById.get(f.folder_id);
      if (name) folderName.set(f.id, name);
    }
  } else {
    // Files tab hidden (common at SFU) — recover files exposed via Modules.
    files = await filesViaModules(opts.client, opts.courseId, folderName);
    logger.info(
      { courseId: opts.courseId, found: files.length },
      'canvas files: files tab hidden — using module items',
    );
  }

  for (const file of files) {
    if (file.size > MAX_BYTES) {
      logger.warn(
        { filename: file.display_name, size: file.size },
        'canvas files: over size cap — skipping',
      );
      result.skipped++;
      continue;
    }
    try {
      const existing = await opts.store.getFileRecord(file.id, opts.userId);
      const canvasUpdated = file.updated_at ? new Date(file.updated_at) : null;
      if (
        existing &&
        existing.canvasUpdatedAt &&
        canvasUpdated &&
        existing.canvasUpdatedAt.getTime() >= canvasUpdated.getTime()
      ) {
        result.skipped++;
        continue;
      }

      // Canvas file URLs are signed and short-lived: fetch immediately.
      const res = await fetch(file.url, { redirect: 'follow' });
      if (!res.ok || !res.body) {
        throw new Error(`download HTTP ${res.status}`);
      }
      const key = objectKey(opts.userId ?? 1, opts.subjectId, file.id, file.display_name);
      await putObjectStream(key, res.body, file['content-type']);

      await opts.store.upsertFileRecord(
        {
          canvasFileId: file.id,
          subjectId: opts.subjectId,
          objectKey: key,
          filename: file.display_name || file.filename,
          contentType: file['content-type'] ?? null,
          size: file.size ?? null,
          folderPath: folderName.get(file.id) ?? null,
          canvasUpdatedAt: canvasUpdated,
        },
        opts.userId,
      );
      result.downloaded++;
      logger.info({ key, filename: file.display_name }, 'canvas files: stored');
    } catch (err) {
      result.failures++;
      logger.error(
        { err: (err as Error).message, fileId: file.id, filename: file.display_name },
        'canvas files: sync failed',
      );
    }
  }
  return result;
}

function objectKey(userId: number, subjectId: string, fileId: number, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'file';
  return `u${userId}/${subjectId}/${fileId}/${safe}`;
}

/** Collect file objects reachable through module items, deduped by file id.
 *  The module's name doubles as the display folder. */
async function filesViaModules(
  client: CanvasClient,
  courseId: number,
  folderName: Map<number, string>,
): Promise<CanvasFile[]> {
  const out = new Map<number, CanvasFile>();
  const modules = await client.listModules(courseId);
  for (const mod of modules) {
    const items = await client.listModuleItems(courseId, mod.id);
    for (const item of items) {
      if (item.type !== 'File' || !item.content_id || out.has(item.content_id)) continue;
      const file = await client.getCourseFile(courseId, item.content_id);
      if (!file) continue; // locked or otherwise inaccessible
      out.set(file.id, file);
      folderName.set(file.id, mod.name);
    }
  }
  return [...out.values()];
}
