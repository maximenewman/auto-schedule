/**
 * Minimal RFC 5545 (iCalendar) parser for the bits we need from CourSys:
 * UID, SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, RRULE, CATEGORIES.
 *
 * Deliberately tiny  -  no recurrence expansion (we pass RRULE through to
 * Google), no VTIMEZONE handling beyond TZID lookup, no support for
 * floating-point durations or weird parameters. CourSys output is plain.
 */

export interface IcalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string | null;
  /** RFC3339 with offset, in `America/Vancouver`. */
  dtstart: string;
  /** RFC3339 with offset, in `America/Vancouver`. May equal `dtstart` for instants. */
  dtend: string;
  /** Full RRULE string including the `RRULE:` prefix, or null. */
  rrule: string | null;
  categories: string[];
  /** True if the VEVENT used `VALUE=DATE` (all-day, no time). */
  allDay: boolean;
}

const DEFAULT_TZ = 'America/Vancouver';

/** Unfold (RFC 5545 section3.1): a line beginning with SPACE or TAB is a continuation. */
function unfold(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface RawProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function splitProperty(line: string): RawProp | null {
  // Find the first ':' that's not inside a quoted parameter value.
  let i = 0;
  let inQuote = false;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) break;
    i++;
  }
  if (i >= line.length) return null;
  const left = line.slice(0, i);
  const value = line.slice(i + 1);

  // left = NAME[;PARAM=VAL[;PARAM=VAL...]]
  const segs: string[] = [];
  let buf = '';
  inQuote = false;
  for (const c of left) {
    if (c === '"') inQuote = !inQuote;
    if (c === ';' && !inQuote) { segs.push(buf); buf = ''; }
    else buf += c;
  }
  segs.push(buf);
  const name = segs[0]!.toUpperCase();
  const params: Record<string, string> = {};
  for (let k = 1; k < segs.length; k++) {
    const seg = segs[k]!;
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const pk = seg.slice(0, eq).toUpperCase();
    let pv = seg.slice(eq + 1);
    if (pv.startsWith('"') && pv.endsWith('"')) pv = pv.slice(1, -1);
    params[pk] = pv;
  }
  return { name, params, value };
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function offsetFor(localDate: string, tz: string): string {
  const sample = new Date(`${localDate}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  }).formatToParts(sample);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-08:00';
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(tzName);
  if (!m) return '-08:00';
  return `${m[1]}${m[2]}:${m[3] ?? '00'}`;
}

function toIsoLocal(date: string, time: string, tz: string): string {
  // date = "YYYYMMDD", time = "HHMMSS"
  const yyyy = date.slice(0, 4);
  const mm = date.slice(4, 6);
  const dd = date.slice(6, 8);
  const hh = time.slice(0, 2);
  const mn = time.slice(2, 4);
  const ss = time.slice(4, 6) || '00';
  const localDate = `${yyyy}-${mm}-${dd}`;
  return `${localDate}T${hh}:${mn}:${ss}${offsetFor(localDate, tz)}`;
}

function toIsoUtc(date: string, time: string): string {
  const yyyy = date.slice(0, 4);
  const mm = date.slice(4, 6);
  const dd = date.slice(6, 8);
  const hh = time.slice(0, 2);
  const mn = time.slice(2, 4);
  const ss = time.slice(4, 6) || '00';
  return `${yyyy}-${mm}-${dd}T${hh}:${mn}:${ss}Z`;
}

function parseDateTime(prop: RawProp): { iso: string; allDay: boolean } {
  const v = prop.value.trim();
  // Date only: YYYYMMDD
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(v)) {
    const yyyy = v.slice(0, 4);
    const mm = v.slice(4, 6);
    const dd = v.slice(6, 8);
    // Anchor at midnight America/Vancouver  -  Google honours the offset on
    // the dateTime regardless of `timeZone`, so this is unambiguous.
    const localDate = `${yyyy}-${mm}-${dd}`;
    return {
      iso: `${localDate}T00:00:00${offsetFor(localDate, DEFAULT_TZ)}`,
      allDay: true,
    };
  }
  // UTC: ...Z
  if (v.endsWith('Z')) {
    const [date, timeZ] = v.split('T');
    return { iso: toIsoUtc(date!, timeZ!.replace(/Z$/, '')), allDay: false };
  }
  // Local with TZID parameter (or floating  -  treat as default TZ).
  const [date, time] = v.split('T');
  const tz = prop.params.TZID || DEFAULT_TZ;
  return { iso: toIsoLocal(date!, time ?? '000000', tz), allDay: false };
}

function parseCategories(value: string): string[] {
  // Comma-separated, escape-aware.
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      buf += value[i + 1];
      i++;
      continue;
    }
    if (c === ',') {
      out.push(buf.trim());
      buf = '';
    } else {
      buf += c;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Bump a local-time ISO string forward by exactly one calendar day,
 *  preserving the offset/time-of-day. Used for all-day events that omit
 *  DTEND. */
function addOneLocalDay(iso: string): string {
  // "2026-09-07T00:00:00-07:00" -> "2026-09-08T00:00:00-07:00"
  const m = /^(\d{4})-(\d{2})-(\d{2})(T.*)$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + 1);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}${m[4]}`;
}

export function parseIcal(text: string): IcalEvent[] {
  const lines = unfold(text);
  const events: IcalEvent[] = [];
  let cur: Partial<IcalEvent> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { categories: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.dtstart) {
        // RFC 5545: when DTEND is absent on a DATE-valued event, the event
        // implicitly spans exactly one day. CourSys's HOLIDAY entries do
        // this, and without the +1 day fix the downstream renderer treats
        // them as zero-length midnight blocks and filters them out.
        let dtend = cur.dtend ?? cur.dtstart;
        if (cur.allDay && dtend === cur.dtstart) {
          dtend = addOneLocalDay(cur.dtstart);
        }
        events.push({
          uid: cur.uid,
          summary: cur.summary ?? '',
          description: cur.description ?? '',
          location: cur.location ?? null,
          dtstart: cur.dtstart,
          dtend,
          rrule: cur.rrule ?? null,
          categories: cur.categories ?? [],
          allDay: cur.allDay ?? false,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const p = splitProperty(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID':
        cur.uid = p.value.trim();
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(p.value);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(p.value);
        break;
      case 'LOCATION': {
        const loc = unescapeText(p.value).trim();
        cur.location = loc.length > 0 ? loc : null;
        break;
      }
      case 'DTSTART': {
        const r = parseDateTime(p);
        cur.dtstart = r.iso;
        cur.allDay = r.allDay;
        break;
      }
      case 'DTEND': {
        const r = parseDateTime(p);
        cur.dtend = r.iso;
        break;
      }
      case 'RRULE':
        cur.rrule = `RRULE:${p.value.trim()}`;
        break;
      case 'CATEGORIES':
        cur.categories = parseCategories(p.value);
        break;
      default:
        break;
    }
  }
  return events;
}
