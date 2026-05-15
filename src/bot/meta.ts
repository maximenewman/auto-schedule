import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';

const GRAPH_API_VERSION = process.env.WA_GRAPH_VERSION ?? 'v21.0';

interface MetaConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  recipient: string;
  verifyToken: string;
}

export class MetaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetaConfigError';
  }
}

export function loadMetaConfig(): MetaConfig {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;
  const appSecret = process.env.WA_APP_SECRET;
  const recipient = process.env.WA_RECIPIENT;
  const verifyToken = process.env.WA_VERIFY_TOKEN;
  const missing: string[] = [];
  if (!phoneNumberId) missing.push('WA_PHONE_NUMBER_ID');
  if (!accessToken) missing.push('WA_ACCESS_TOKEN');
  if (!appSecret) missing.push('WA_APP_SECRET');
  if (!recipient) missing.push('WA_RECIPIENT');
  if (!verifyToken) missing.push('WA_VERIFY_TOKEN');
  if (missing.length > 0) {
    throw new MetaConfigError(
      `missing WhatsApp env vars: ${missing.join(', ')}`,
    );
  }
  return {
    phoneNumberId: phoneNumberId!,
    accessToken: accessToken!,
    appSecret: appSecret!,
    recipient: recipient!,
    verifyToken: verifyToken!,
  };
}

async function postMessage(
  cfg: MetaConfig,
  body: Record<string, unknown>,
): Promise<void> {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${cfg.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`meta send failed: ${res.status} ${res.statusText} ${text}`);
  }
}

export async function sendText(
  to: string,
  body: string,
  cfg = loadMetaConfig(),
): Promise<void> {
  // Free-form text only works inside the 24h customer service window.
  // For proactive pushes (cron digests) use sendTemplate instead.
  await postMessage(cfg, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: truncateForWhatsApp(body) },
  });
  logger.info({ to, bytes: body.length }, 'whatsapp: sent text');
}

export async function sendTemplate(
  to: string,
  templateName: string,
  params: string[],
  languageCode = 'en_US',
  cfg = loadMetaConfig(),
): Promise<void> {
  await postMessage(cfg, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components:
        params.length > 0
          ? [
              {
                type: 'body',
                parameters: params.map((text) => ({ type: 'text', text })),
              },
            ]
          : [],
    },
  });
  logger.info(
    { to, templateName, paramCount: params.length },
    'whatsapp: sent template',
  );
}

/**
 * Meta caps text bodies at 4096 chars. Trim defensively so a long LLM reply
 * doesn't make the whole send fail.
 */
function truncateForWhatsApp(body: string): string {
  const MAX = 4000;
  if (body.length <= MAX) return body;
  return body.slice(0, MAX - 1) + '…';
}

/**
 * Verify the `X-Hub-Signature-256` header Meta attaches to every webhook
 * delivery. The signature is `sha256=` + HMAC-SHA256(rawBody, app_secret).
 */
export function verifyWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  cfg = loadMetaConfig(),
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = signatureHeader.slice('sha256='.length);
  const buf =
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const actual = createHmac('sha256', cfg.appSecret).update(buf).digest('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Subscribe-time handshake. Meta calls `GET /bot/whatsapp?hub.mode=subscribe&
 * hub.verify_token=...&hub.challenge=...`. Echo the challenge iff the token
 * matches.
 */
export function handleVerifyHandshake(
  query: Record<string, unknown>,
  cfg = loadMetaConfig(),
): { ok: true; challenge: string } | { ok: false; reason: string } {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode !== 'subscribe') return { ok: false, reason: 'mode != subscribe' };
  if (typeof token !== 'string' || token !== cfg.verifyToken) {
    return { ok: false, reason: 'verify_token mismatch' };
  }
  if (typeof challenge !== 'string') {
    return { ok: false, reason: 'missing challenge' };
  }
  return { ok: true, challenge };
}

export interface InboundTextMessage {
  from: string;
  text: string;
  messageId: string;
  timestamp: string;
}

/**
 * Pull the first text message out of Meta's deeply-nested webhook payload.
 * Webhooks can also be delivery/read status updates with no `messages` field —
 * those return null so the caller can ack and move on.
 */
export function parseInboundText(payload: unknown): InboundTextMessage | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as {
    entry?: Array<{
      changes?: Array<{
        value?: {
          messages?: Array<{
            from?: string;
            id?: string;
            timestamp?: string;
            type?: string;
            text?: { body?: string };
          }>;
        };
      }>;
    }>;
  };
  for (const entry of root.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const m of change.value?.messages ?? []) {
        if (m.type !== 'text') continue;
        const body = m.text?.body;
        if (!body || !m.from || !m.id || !m.timestamp) continue;
        return {
          from: m.from,
          text: body,
          messageId: m.id,
          timestamp: m.timestamp,
        };
      }
    }
  }
  return null;
}
