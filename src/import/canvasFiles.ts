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

  // Walk modules once regardless of Files-tab access: File items are the
  // fallback listing when the tab is hidden, and Page items hold wiki pages
  // that often exist even when the course's Pages index 404s.
  const moduleWalk = await walkModules(opts.client, opts.courseId);

  if (files !== null) {
    const folders = await opts.client.listCourseFolders(opts.courseId);
    const folderById = new Map(folders.map((f) => [f.id, f.full_name]));
    for (const f of files) {
      const name = folderById.get(f.folder_id);
      if (name) folderName.set(f.id, name);
    }
    // Files-tab path: mimic the course page's folder ordering.
    files.sort((a, b) =>
      (folderName.get(a.id) ?? '').localeCompare(folderName.get(b.id) ?? '') ||
      a.display_name.localeCompare(b.display_name),
    );
  } else {
    // Files tab hidden (common at SFU) — recover files exposed via Modules,
    // in Canvas position order ("Week 1, Week 2, ...").
    files = await resolveModuleFiles(opts.client, opts.courseId, moduleWalk, folderName);
    logger.info(
      { courseId: opts.courseId, found: files.length },
      'canvas files: files tab hidden — using module items',
    );
  }

  // Pages can embed file links that appear in neither Files nor Modules —
  // scan the Pages index (when enabled) plus every page reachable from a
  // module, and pick up whatever is new.
  const seen = new Set(files.map((f) => f.id));
  const pageFiles = await filesViaPages(
    opts.client, opts.courseId, moduleWalk.pages, folderName, seen,
  );
  if (pageFiles.length > 0) {
    files.push(...pageFiles);
    logger.info(
      { courseId: opts.courseId, found: pageFiles.length },
      'canvas files: additional files found in pages',
    );
  }

  let order = 0;
  for (const file of files) {
    const sortOrder = order++;
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
        // Content unchanged, but keep the ordering in step with Canvas.
        await opts.store.setFileSortOrder(file.id, sortOrder, opts.userId);
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
          sortOrder,
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

interface ModuleWalk {
  /** File items in module/item position order: [file id, module name]. */
  fileItems: Array<[number, string]>;
  /** Wiki pages reachable from modules: [page slug, page title]. */
  pages: Array<[string, string]>;
}

/** One pass over modules + items, in Canvas position order. */
async function walkModules(client: CanvasClient, courseId: number): Promise<ModuleWalk> {
  const walk: ModuleWalk = { fileItems: [], pages: [] };
  const modules = await client.listModules(courseId);
  for (const mod of modules) {
    const items = await client.listModuleItems(courseId, mod.id);
    for (const item of items) {
      if (item.type === 'File' && item.content_id) {
        walk.fileItems.push([item.content_id, mod.name]);
      } else if (item.type === 'Page' && item.page_url) {
        walk.pages.push([item.page_url, item.title ?? mod.name]);
      }
    }
  }
  return walk;
}

/** Resolve module File items into file objects, deduped by file id. The
 *  module's name doubles as the display folder. */
async function resolveModuleFiles(
  client: CanvasClient,
  courseId: number,
  walk: ModuleWalk,
  folderName: Map<number, string>,
): Promise<CanvasFile[]> {
  const out = new Map<number, CanvasFile>();
  for (const [fileId, modName] of walk.fileItems) {
    if (out.has(fileId)) continue;
    const file = await client.getCourseFile(courseId, fileId);
    if (!file) continue; // locked or otherwise inaccessible
    out.set(file.id, file);
    folderName.set(file.id, modName);
  }
  return [...out.values()];
}

/** Scan wiki pages for embedded file links ("/courses/:id/files/123" or
 *  "/files/123") and resolve any not already collected. Covers both the
 *  Pages index (when enabled) and pages reachable only through modules —
 *  many courses 404 the index yet still publish module pages. The page
 *  title doubles as the display folder. */
async function filesViaPages(
  client: CanvasClient,
  courseId: number,
  modulePages: Array<[string, string]>,
  folderName: Map<number, string>,
  seen: Set<number>,
): Promise<CanvasFile[]> {
  const out: CanvasFile[] = [];
  const pageSlugs = new Map<string, string>(modulePages);
  for (const page of await client.listPages(courseId)) {
    if (!pageSlugs.has(page.url)) pageSlugs.set(page.url, page.title);
  }

  const linkRe = new RegExp(`(?:/courses/${courseId})?/files/(\\d+)`, 'g');
  for (const [slug, title] of pageSlugs) {
    const body = await client.getPageBody(courseId, slug);
    if (!body) continue;
    for (const m of body.matchAll(linkRe)) {
      const fileId = Number(m[1]);
      if (!Number.isInteger(fileId) || seen.has(fileId)) continue;
      seen.add(fileId);
      const file = await client.getCourseFile(courseId, fileId);
      if (!file) continue; // cross-course link or locked
      out.push(file);
      folderName.set(file.id, title);
    }
  }
  return out;
}
