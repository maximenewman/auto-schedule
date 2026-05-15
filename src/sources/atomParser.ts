/**
 * Minimal Atom 1.0 parser for the CourSys news feed. We only pull out the
 * fields we surface in the dashboard: id, title, published/updated, content
 * (HTML), link, author, and the <category term> values used to attribute an
 * entry to a course code. No external XML dependency — Atom is regular
 * enough that a small hand-rolled tokeniser handles every entry CourSys
 * emits without choking on the long HTML bodies.
 */

export interface AtomEntry {
  /** Stable id — usually a tag URI like
   *  `tag:coursys.sfu.ca,2026:news-item:42`. We use this for dedup. */
  id: string;
  title: string;
  /** RFC3339, falls back to `updated` when `published` is absent. */
  publishedISO: string;
  /** RFC3339, the last time the entry was edited. */
  updatedISO: string;
  /** HTML body of the announcement. Inline images / tags preserved. */
  contentHtml: string;
  /** href on `<link rel="alternate">` if present, else first link. */
  link: string | null;
  /** Free-text author name; CourSys puts the instructor here. */
  author: string | null;
  /** All `<category term="...">` values. CourSys puts the course code,
   *  e.g. `["CMPT 307"]`. */
  categories: string[];
}

export interface AtomFeed {
  /** The `<title>` on the root `<feed>`. */
  title: string;
  /** `<updated>` on the root feed, RFC3339. */
  updatedISO: string;
  entries: AtomEntry[];
}

export function parseAtom(xml: string): AtomFeed {
  const feedEl = extractElement(xml, 'feed');
  if (!feedEl) {
    throw new Error('atom: no <feed> root element');
  }
  return {
    title: textOf(feedEl, 'title') ?? '',
    updatedISO: textOf(feedEl, 'updated') ?? '',
    entries: extractAllElements(feedEl, 'entry').map(parseEntry),
  };
}

function parseEntry(entryXml: string): AtomEntry {
  return {
    id: textOf(entryXml, 'id') ?? '',
    title: textOf(entryXml, 'title') ?? '',
    publishedISO: textOf(entryXml, 'published') ?? textOf(entryXml, 'updated') ?? '',
    updatedISO: textOf(entryXml, 'updated') ?? textOf(entryXml, 'published') ?? '',
    contentHtml: rawTextOf(entryXml, 'content') ?? rawTextOf(entryXml, 'summary') ?? '',
    link: pickLink(entryXml),
    author: parseAuthor(entryXml),
    categories: parseCategories(entryXml),
  };
}

// ---------- helpers ---------------------------------------------------------

/** Find the body of the first `<tag ...>...</tag>` pair. Returns the slice
 *  between the opening tag's `>` and the matching `</tag>`, ignoring nesting
 *  (Atom never nests the same tag inside itself for the fields we care about). */
function extractElement(xml: string, tag: string): string | null {
  const open = new RegExp(`<\\s*${tag}(?:\\s[^>]*)?>`, 'i');
  const close = new RegExp(`<\\s*/\\s*${tag}\\s*>`, 'i');
  const o = open.exec(xml);
  if (!o) return null;
  const after = o.index + o[0].length;
  const c = close.exec(xml.slice(after));
  if (!c) return null;
  return xml.slice(after, after + c.index);
}

function extractAllElements(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<\\s*${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*/\\s*${tag}\\s*>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1] ?? '');
  return out;
}

/** Get the decoded text content of the first <tag>...</tag>. Strips wrapper
 *  whitespace and decodes basic XML entities. Used for plain-text fields. */
function textOf(xml: string, tag: string): string | null {
  const raw = rawTextOf(xml, tag);
  if (raw == null) return null;
  return decodeEntities(stripTags(raw)).trim();
}

/** Get raw inner XML of the first <tag>...</tag>. Used for `<content>`
 *  where the body is HTML we want to preserve verbatim (after entity
 *  decoding — CourSys serves Atom with HTML-escaped content). */
function rawTextOf(xml: string, tag: string): string | null {
  const el = extractElement(xml, tag);
  if (el === null) return null;
  return decodeEntities(el).trim();
}

function pickLink(entryXml: string): string | null {
  // Atom `<link>` is self-closing with attrs. Prefer rel="alternate"; if
  // none specified, take the first href.
  const links: { rel: string; href: string }[] = [];
  const re = /<\s*link(\s[^>]*)\/?\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(entryXml)) !== null) {
    const attrs = m[1] ?? '';
    const href = attrAt(attrs, 'href');
    if (!href) continue;
    const rel = attrAt(attrs, 'rel') ?? 'alternate';
    links.push({ rel, href });
  }
  const alt = links.find((l) => l.rel === 'alternate');
  return alt?.href ?? links[0]?.href ?? null;
}

function parseAuthor(entryXml: string): string | null {
  const authorEl = extractElement(entryXml, 'author');
  if (!authorEl) return null;
  return textOf(authorEl, 'name') ?? null;
}

function parseCategories(entryXml: string): string[] {
  const out: string[] = [];
  const re = /<\s*category(\s[^>]*)\/?\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(entryXml)) !== null) {
    const term = attrAt(m[1] ?? '', 'term');
    if (term) out.push(decodeEntities(term).trim());
  }
  return out;
}

function attrAt(attrs: string, name: string): string | null {
  // Match name="value" or name='value'.
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
