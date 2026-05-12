import { google, type gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Source, Subject } from '../config/subjects.js';
import type { AttachmentRef, SourceFetcher, SourceItem } from './types.js';
import type { StateStore } from '../state/store.js';
import { logger } from '../logger.js';

const MAX_MESSAGES_PER_RUN = 25;

export class EmailSource implements SourceFetcher {
  private readonly gmail: gmail_v1.Gmail;

  constructor(
    auth: OAuth2Client,
    private readonly store: StateStore,
  ) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  async fetchNew(subject: Subject, source: Source): Promise<SourceItem[]> {
    if (source.type !== 'email') {
      throw new Error(`EmailSource called with non-email source: ${source.type}`);
    }
    const q = `label:${source.label}`;
    logger.info(
      { subjectId: subject.id, label: source.label },
      'email: querying gmail by label',
    );
    const list = await this.gmail.users.messages.list({
      userId: 'me',
      q,
      maxResults: MAX_MESSAGES_PER_RUN,
    });
    const allIds = (list.data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string');
    const messageIds = allIds.filter((id) => !this.store.hasSeenEmail(subject.id, id));
    logger.info(
      {
        subjectId: subject.id,
        label: source.label,
        scanned: allIds.length,
        alreadySeen: allIds.length - messageIds.length,
        newToProcess: messageIds.length,
      },
      'email: scan complete',
    );
    if (messageIds.length === 0) {
      return [];
    }

    const items: SourceItem[] = [];
    for (const id of messageIds) {
      const full = await this.gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'full',
      });
      const parsed = parseMessage(full.data);
      items.push({
        sourceItemId: id,
        content: parsed.text,
        attachments: parsed.attachments,
        meta: { gmailMessageId: id, subject: parsed.subject },
      });
    }
    return items;
  }

  markProcessed(subject: Subject, _source: Source, item: SourceItem): void {
    this.store.markEmailSeen(subject.id, item.sourceItemId);
  }
}

interface ParsedMessage {
  subject: string;
  text: string;
  attachments: AttachmentRef[];
}

function parseMessage(msg: gmail_v1.Schema$Message): ParsedMessage {
  const headers = msg.payload?.headers ?? [];
  const subjectHeader = headers.find((h) => h.name?.toLowerCase() === 'subject');
  const fromHeader = headers.find((h) => h.name?.toLowerCase() === 'from');
  const dateHeader = headers.find((h) => h.name?.toLowerCase() === 'date');

  const parts: string[] = [
    `Subject: ${subjectHeader?.value ?? '(no subject)'}`,
    `From: ${fromHeader?.value ?? '(unknown)'}`,
    `Date: ${dateHeader?.value ?? ''}`,
    '',
  ];

  const bodyChunks: string[] = [];
  const attachments: AttachmentRef[] = [];
  walkParts(msg.payload ?? null, msg.id ?? '', bodyChunks, attachments);
  parts.push(bodyChunks.join('\n'));

  return {
    subject: subjectHeader?.value ?? '',
    text: parts.join('\n').trim(),
    attachments,
  };
}

function walkParts(
  part: gmail_v1.Schema$MessagePart | null,
  messageId: string,
  bodyChunks: string[],
  attachments: AttachmentRef[],
): void {
  if (!part) return;

  const mime = part.mimeType ?? '';
  const filename = part.filename ?? '';
  const attachmentId = part.body?.attachmentId;

  if (filename && attachmentId) {
    attachments.push({
      url: `gmail://${messageId}/${attachmentId}`,
      filename,
      meta: {
        gmailMessageId: messageId,
        gmailAttachmentId: attachmentId,
        mimeType: mime,
      },
    });
    return;
  }

  if (mime === 'text/plain' && part.body?.data) {
    bodyChunks.push(decodeBase64Url(part.body.data));
    return;
  }
  if (mime === 'text/html' && part.body?.data && bodyChunks.length === 0) {
    bodyChunks.push(stripHtml(decodeBase64Url(part.body.data)));
    return;
  }

  for (const sub of part.parts ?? []) {
    walkParts(sub, messageId, bodyChunks, attachments);
  }
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
