import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Cookie } from 'puppeteer';
import type { Attachment } from '../agent/schema.js';
import type { StateStore } from '../state/store.js';
import { loadCookies } from '../auth/coursys.js';
import { logger } from '../logger.js';

export interface DownloadContext {
  googleAuth: OAuth2Client;
  store: StateStore;
}

export interface DownloadResult {
  path: string;
  hash: string;
  bytes: number;
  reused: boolean;
}

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB cap per file

export async function downloadAttachment(
  attachment: Attachment,
  destFolder: string,
  ctx: DownloadContext,
): Promise<DownloadResult | null> {
  const absFolder = resolve(destFolder);
  mkdirSync(absFolder, { recursive: true });

  try {
    const buffer = await fetchBytes(attachment, ctx);
    if (!buffer) return null;
    if (buffer.byteLength > MAX_BYTES) {
      logger.warn(
        { url: attachment.url, bytes: buffer.byteLength, cap: MAX_BYTES },
        'attachment exceeds size cap; skipping',
      );
      return null;
    }
    const hash = createHash('sha256').update(buffer).digest('hex');
    if (ctx.store.hasDownloadedFile(hash)) {
      logger.debug({ hash, url: attachment.url }, 'attachment already downloaded; skipping');
      return { path: '', hash, bytes: buffer.byteLength, reused: true };
    }
    const safeName = sanitizeFilename(attachment.filename);
    const target = uniquePath(join(absFolder, safeName));
    writeFileSync(target, buffer);
    ctx.store.recordDownloadedFile(hash, target);
    logger.info({ target, hash, bytes: buffer.byteLength }, 'attachment downloaded');
    return { path: target, hash, bytes: buffer.byteLength, reused: false };
  } catch (err) {
    logger.error({ err, url: attachment.url }, 'attachment download failed');
    return null;
  }
}

async function fetchBytes(
  attachment: Attachment,
  ctx: DownloadContext,
): Promise<Buffer | null> {
  if (attachment.url.startsWith('gmail://')) {
    return fetchFromGmail(attachment.url, ctx.googleAuth);
  }
  if (/^https?:\/\//i.test(attachment.url)) {
    return fetchHttp(attachment.url);
  }
  logger.warn({ url: attachment.url }, 'unrecognized attachment URL scheme');
  return null;
}

async function fetchFromGmail(
  url: string,
  auth: OAuth2Client,
): Promise<Buffer | null> {
  // gmail://<messageId>/<attachmentId>
  const match = url.match(/^gmail:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`bad gmail attachment url: ${url}`);
  }
  const messageId = match[1];
  const attachmentId = match[2];
  if (!messageId || !attachmentId) {
    throw new Error(`bad gmail attachment url: ${url}`);
  }
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });
  const data = res.data.data;
  if (!data) return null;
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64');
}

async function fetchHttp(url: string): Promise<Buffer | null> {
  const headers: Record<string, string> = {
    'User-Agent': 'auto-schedule/0.1 (+https://github.com/maximenewman/auto-schedule)',
  };
  // CourSys downloads need the session cookie. Best-effort: if cookies are
  // present and the host matches, attach them.
  try {
    const target = new URL(url);
    if (target.hostname.endsWith('coursys.sfu.ca')) {
      const cookies = loadCookies();
      const header = cookies
        .filter((c: Cookie) => c.domain.includes('coursys.sfu.ca'))
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      if (header) headers['Cookie'] = header;
    }
  } catch {
    // No cookies  -  fine for public hosts.
  }

  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`http ${res.status} fetching ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function sanitizeFilename(name: string): string {
  const trimmed = (name || 'attachment').trim();
  const baseOnly = basename(trimmed);
  return baseOnly.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 200) || 'attachment';
}

function uniquePath(target: string): string {
  if (!existsSync(target)) return target;
  const dot = target.lastIndexOf('.');
  const stem = dot > 0 ? target.slice(0, dot) : target;
  const ext = dot > 0 ? target.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}
