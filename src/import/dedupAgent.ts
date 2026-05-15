import { generateObject, NoObjectGeneratedError } from 'ai';
import { createOpenAI, type OpenAIProvider } from '@ai-sdk/openai';
import { z } from 'zod';
import type { OAuth2Client } from 'google-auth-library';
import { loadSubjects, type Subject } from '../config/subjectsStore.js';
import type { CalendarItemRow, StateStore } from '../state/store.js';
import { listGoogleEvents } from '../sync/calendarRead.js';
import { logger } from '../logger.js';

const DEFAULT_MODEL = process.env.AGENT_MODEL ?? 'openai/gpt-4o-mini';
const HIDDEN_SUBJECT_IDS = new Set(['holidays']);

let cachedProvider: OpenAIProvider | undefined;
function getProvider(): OpenAIProvider {
  if (cachedProvider) return cachedProvider;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('missing env var OPENROUTER_API_KEY');
  cachedProvider = createOpenAI({
    apiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    headers: {
      'HTTP-Referer': 'https://github.com/maximenewman/auto-schedule',
      'X-Title': 'auto-schedule',
    },
  });
  return cachedProvider;
}

export const SubjectMergeSchema = z.object({
  fromId: z.string().describe('Subject id to remove. Its events get re-attributed to intoId.'),
  intoId: z.string().describe('Subject id to keep  -  the canonical version.'),
  reason: z.string().describe('Short explanation, e.g. "section letter accidentally captured" or "same course, different names".'),
});

export const EventMergeSchema = z.object({
  canonicalEventId: z.string().describe('The event id to keep. Pick the one with richer/more specific data (e.g. building name vs generic campus).'),
  redundantEventIds: z.array(z.string()).min(1).describe('Event ids to delete. They get redirected to canonicalEventId on future syncs.'),
  reason: z.string().describe('Why these are the same event.'),
});

export const DedupPlanSchema = z.object({
  subjectMerges: z.array(SubjectMergeSchema),
  eventMerges: z.array(EventMergeSchema),
});

export type DedupPlan = z.infer<typeof DedupPlanSchema>;

const SYSTEM_PROMPT = `You deduplicate course subjects and calendar events for a student's planner.

You will receive:
  - SUBJECTS: a list of subject rows (id, code, name, professor).
  - EVENT CLUSTERS: groups of events that overlap in time on the same day.

Your output is a JSON plan with two arrays: subjectMerges and eventMerges. Be conservative  -  when uncertain, skip the merge.

================ SUBJECT MERGE RULES ================
Two subjects are duplicates if they refer to the same course, regardless of formatting differences.

Examples:

+ MERGE  -  section letter accidentally captured as part of the course number:
  - "cmpt307" (code "CMPT 307", name "Data Structures and Algorithms")
  - "cmpt307d" (code "CMPT 307D", name "CMPT 307D")
  -> { fromId: "cmpt307d", intoId: "cmpt307", reason: "cmpt307d is cmpt307 with a section suffix" }

+ MERGE  -  code vs full name for the same course:
  - "cmpt307" (code "CMPT 307", name "Data Structures and Algorithms")
  - "ds-algo" (code "DS Algo", name "Data Structures and Algorithms")
  -> { fromId: "ds-algo", intoId: "cmpt307", reason: "same course, code vs informal name" }

x DO NOT MERGE  -  different course numbers:
  - "cmpt307" vs "cmpt315" -> keep both

x DO NOT MERGE  -  different departments:
  - "cmpt307" vs "stat307" -> keep both

x DO NOT MERGE  -  Holidays is a synthetic bucket, never merge anything into it or out of it.

When picking the canonical (intoId) prefer:
  - The subject with a real professor over "TBD"
  - The shorter / more conventional code (e.g. "cmpt307" beats "cmpt307d")

================ EVENT MERGE RULES ================
Two events are duplicates if they describe the same physical session:
  - Same date AND overlapping or identical time window
  - Same subject (after any subject merges you propose)
  - Similar summary OR same kind (both "lecture", both "tutorial", etc.)

When merging, pick canonicalEventId by preferring:
  - More specific room ("Shrum Science Centre Chemistry - C9002" beats "Burnaby Campus C9002")
  - Richer description
  - Already-edited (looks user-touched)

Examples:

+ MERGE  -  PDF and iCal sources both produced the same lecture:
  - Event A: id "cmpt307-lec-...", summary "CMPT 307 LEC", room "Shrum Science Centre Chemistry - C9002", kind lecture, Wed 13:30-14:20
  - Event B: id "cmpt307d-2026sucmpt...", summary "CMPT 307 D1 Lecture", room "Burnaby Campus C9002", kind lecture, Wed 13:30-14:20
  -> canonicalEventId: A (more specific room), redundantEventIds: [B]

x DO NOT MERGE  -  different kinds in the same slot (a tutorial scheduled over a lecture is a different session):
  - Event A: lecture
  - Event B: tutorial, same time
  -> leave both

x DO NOT MERGE  -  different subjects (a real conflict, not a duplicate):
  - Event A: subject "cmpt307", lecture
  - Event B: subject "stat271", office-hours
  -> leave both

x DO NOT MERGE  -  holidays clusters: HOLIDAY events from the holidays subject are intentionally separate.

x DO NOT MERGE  -  events that a subject merge would already collapse. When you emit { fromId, intoId } in subjectMerges, the system automatically deletes every Google event tied to fromId and re-creates them under intoId on the next sync. Stacking an event merge on top of that is wasted work and may reference event IDs that no longer exist after the subject merge runs.
  -> If two events differ only because they belong to a subject pair you are already merging, leave them out of eventMerges entirely. Emit eventMerges ONLY when the two duplicate events sit under a subject that is NOT being merged.

================ HARD CONSTRAINTS ================
- Every canonicalEventId and every redundantEventId you emit MUST appear verbatim somewhere in the EVENT CLUSTERS section of the input. Do not invent IDs by transforming naming patterns. If an ID isn't in the input, it doesn't exist.
- subjectMerges + eventMerges combined should rarely exceed ~10 entries. Cluster duplicates by pattern and prefer subjectMerges, which scale: one subject merge handles every weekly occurrence at once.
- Output valid JSON matching the schema. If you are uncertain, emit fewer merges rather than more.

Only emit a merge when you are confident the two rows describe the same real-world session.`;

export interface DedupCtx {
  store: StateStore;
  googleAuth: OAuth2Client;
  userId?: number;
}

export interface DedupAgentResult {
  plan: DedupPlan;
  promptTokens?: number;
  completionTokens?: number;
  /** Non-empty when the model's raw output was unusable (truncated, schema
   *  mismatch, etc) but we were able to salvage a partial plan via JSON
   *  repair. Surfaced through the iCal sync progress stream so the UI can
   *  warn the user. */
  warning?: string;
}

/**
 * Single LLM call that returns a structured dedup plan. The caller executes
 * the plan through `mergeSubject` and `mergeEvent` from `dedup.ts`.
 *
 * We pre-filter events: only clusters of 2+ overlapping events are sent to
 * the model, so the prompt stays small even on a busy term.
 */
export async function planDedup(ctx: DedupCtx): Promise<DedupAgentResult> {
  const subjects = (await loadSubjects(ctx.store, ctx.userId)).filter(
    (s) => !HIDDEN_SUBJECT_IDS.has(s.id),
  );
  const events = await fetchEventsForDedup(ctx);
  const clusters = clusterByTimeConflict(events);
  const validSubjectIds = new Set<string>(subjects.map((s) => s.id));

  // ---------------------------------------------------------------------
  // Deterministic pre-pass: detect events that share an `itemId` but live
  // under different `subjectId` prefixes. These are always the same logical
  // iCal item duplicated by a prior subject-rename bug, and the LLM has
  // historically wasted its entire token budget enumerating them one by
  // one (then getting truncated). Resolving them here gives the LLM a
  // smaller, more interesting input.
  // ---------------------------------------------------------------------
  const { autoMerges, remainingClusters } = preMergeBySharedItemId(
    clusters,
    validSubjectIds,
  );
  if (autoMerges.length > 0) {
    logger.info(
      { count: autoMerges.length },
      'dedup: pre-pass collapsed shared-itemId duplicates',
    );
  }

  // Nothing left worth asking the LLM about.
  if (subjects.length < 2 && remainingClusters.length === 0) {
    return { plan: { subjectMerges: [], eventMerges: autoMerges } };
  }

  const prompt = buildPrompt(subjects, remainingClusters);
  logger.info(
    {
      subjects: subjects.length,
      clusters: remainingClusters.length,
      autoMergesFromPrePass: autoMerges.length,
      model: DEFAULT_MODEL,
    },
    'dedup: asking agent',
  );

  // Build the set of event IDs the model is allowed to reference. Anything
  // outside this set is hallucinated and gets dropped before execution.
  const validEventIds = new Set<string>();
  for (const cluster of remainingClusters) for (const e of cluster) validEventIds.add(e.eventId);

  try {
    const result = await generateObject({
      model: getProvider()(DEFAULT_MODEL),
      schema: DedupPlanSchema,
      temperature: 0.1,
      // 8000 leaves headroom even if the model goes off-script. The
      // pre-pass should keep the actual output tiny in normal cases.
      maxTokens: 8000,
      // Encourage structured output via JSON-mode; the AI SDK already
      // schema-validates, but `mode: 'json'` makes the OpenAI-compatible
      // endpoint refuse to emit prose.
      mode: 'json',
      system: SYSTEM_PROMPT,
      prompt,
    });

    // Drop event merges that reference IDs not in the input — the model
    // sometimes synthesises canonical IDs by string-manipulating the
    // subject prefix (e.g. cmpt427d → cmpt427) which yields IDs that do
    // not exist as Google events yet.
    const beforeEvents = result.object.eventMerges.length;
    const cleanedEventMerges = result.object.eventMerges.filter((m) => {
      if (!validEventIds.has(m.canonicalEventId)) return false;
      return m.redundantEventIds.every((id) => validEventIds.has(id));
    });
    const beforeSubjects = result.object.subjectMerges.length;
    const cleanedSubjectMerges = result.object.subjectMerges.filter(
      (m) => validSubjectIds.has(m.fromId) && validSubjectIds.has(m.intoId) && m.fromId !== m.intoId,
    );
    // Correct each event merge so the canonical points at an event whose
    // subjectId still exists in the user's subjects list. If the model
    // picked a canonical tied to a deleted subject, swap it with a redundant
    // that has a valid subject — otherwise post-merge the surviving event
    // would have no owner in the UI.
    const correctedEventMerges = cleanedEventMerges
      .map((m) => correctCanonical(m, remainingClusters, validSubjectIds))
      .filter((m): m is NonNullable<typeof m> => m !== null);

    // Drop event merges that would be subsumed by a subject merge: if any
    // referenced event row belongs to a `fromId` that is itself being merged,
    // the subject pass will already delete those Google events.
    const fromIds = new Set(cleanedSubjectMerges.map((m) => m.fromId));
    const subsumedFilter = correctedEventMerges.filter((m) => {
      const all = [m.canonicalEventId, ...m.redundantEventIds];
      const subjectsTouched = new Set<string>();
      for (const id of all) {
        for (const cluster of remainingClusters) {
          const ev = cluster.find((e) => e.eventId === id);
          if (ev) subjectsTouched.add(ev.subjectId);
        }
      }
      for (const sid of subjectsTouched) if (fromIds.has(sid)) return false;
      return true;
    });

    const plan: DedupPlan = {
      subjectMerges: cleanedSubjectMerges,
      eventMerges: [...autoMerges, ...subsumedFilter],
    };
    logger.info(
      {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        subjectMerges: plan.subjectMerges.length,
        subjectsDropped: beforeSubjects - plan.subjectMerges.length,
        autoEventMerges: autoMerges.length,
        llmEventMerges: subsumedFilter.length,
        eventsDroppedHallucinated: beforeEvents - cleanedEventMerges.length,
        eventsDroppedSubsumed: correctedEventMerges.length - subsumedFilter.length,
      },
      'dedup: agent returned plan',
    );
    return {
      plan,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
    };
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      // generateObject failed schema validation — usually because the model
      // got truncated mid-string or emitted prose. Try to salvage whatever
      // complete entries it managed before giving up.
      const salvaged = salvagePartialPlan(
        err.text ?? '',
        validSubjectIds,
        validEventIds,
        remainingClusters,
      );
      if (salvaged) {
        const combined: DedupPlan = {
          subjectMerges: salvaged.subjectMerges,
          eventMerges: [...autoMerges, ...salvaged.eventMerges],
        };
        logger.warn(
          {
            subjectMerges: combined.subjectMerges.length,
            eventMerges: combined.eventMerges.length,
            autoMergesPrepended: autoMerges.length,
            sample: err.text?.slice(0, 200),
          },
          'dedup: model output unparseable, salvaged partial plan via JSON repair',
        );
        return {
          plan: combined,
          warning: `agent output was truncated; recovered ${combined.subjectMerges.length} subject merge(s) + ${combined.eventMerges.length} event merge(s) (${autoMerges.length} via deterministic pre-pass)`,
        };
      }
      logger.warn(
        { text: err.text?.slice(0, 500) },
        'dedup: model produced unusable output and nothing was salvageable',
      );
      return {
        plan: { subjectMerges: [], eventMerges: autoMerges },
        warning: autoMerges.length > 0
          ? `agent returned no parseable plan; using ${autoMerges.length} pre-pass merge(s) only`
          : 'agent returned no parseable plan',
      };
    }
    throw err;
  }
}

/**
 * Find clusters where multiple events share the same `itemId` but live under
 * different `subjectId`s. That means the same source row produced N events
 * because subject-renames happened over time. Merge them deterministically:
 * canonical = the row whose `subjectId` currently exists in the user's
 * subject list (so the surviving event still has a home in the UI).
 */
function preMergeBySharedItemId(
  clusters: CalendarItemRow[][],
  validSubjectIds: Set<string>,
): {
  autoMerges: DedupPlan['eventMerges'];
  remainingClusters: CalendarItemRow[][];
} {
  const autoMerges: DedupPlan['eventMerges'] = [];
  const remainingClusters: CalendarItemRow[][] = [];

  for (const cluster of clusters) {
    const byItemId = new Map<string, CalendarItemRow[]>();
    for (const e of cluster) {
      const bucket = byItemId.get(e.itemId);
      if (bucket) bucket.push(e);
      else byItemId.set(e.itemId, [e]);
    }
    const consumed = new Set<string>();
    for (const [itemId, rows] of byItemId) {
      if (rows.length < 2) continue;
      // Sort: valid subject first, then shorter subjectId.
      const sorted = [...rows].sort((a, b) => {
        const aValid = validSubjectIds.has(a.subjectId);
        const bValid = validSubjectIds.has(b.subjectId);
        if (aValid !== bValid) return aValid ? -1 : 1;
        return a.subjectId.length - b.subjectId.length;
      });
      const canonical = sorted[0]!;
      const redundant = sorted.slice(1);
      autoMerges.push({
        canonicalEventId: canonical.eventId,
        redundantEventIds: redundant.map((r) => r.eventId),
        reason: `same iCal item "${itemId}" duplicated under subjects [${rows.map((r) => r.subjectId).join(', ')}]; keeping ${canonical.subjectId}`,
      });
      for (const r of rows) consumed.add(r.eventId);
    }
    // Second-tier merge inside the same cluster: events that share
    //   (subjectId, startISO, endISO) and have compatible kinds are the
    // same physical session sourced twice (PDF + iCal). Canonical = the
    // event with the more specific room ("Shrum Science Centre …" beats
    // "Burnaby Campus C9002"), source preference as tiebreaker.
    const leftoverAfterItem = cluster.filter((e) => !consumed.has(e.eventId));
    const byTimeKey = new Map<string, CalendarItemRow[]>();
    for (const e of leftoverAfterItem) {
      const key = `${e.subjectId}|${e.startISO}|${e.endISO}`;
      const bucket = byTimeKey.get(key);
      if (bucket) bucket.push(e);
      else byTimeKey.set(key, [e]);
    }
    for (const [, rows] of byTimeKey) {
      if (rows.length < 2) continue;
      if (!compatibleKinds(rows)) continue;
      const sorted = [...rows].sort((a, b) => roomScore(b) - roomScore(a));
      const canonical = sorted[0]!;
      const redundant = sorted.slice(1);
      autoMerges.push({
        canonicalEventId: canonical.eventId,
        redundantEventIds: redundant.map((r) => r.eventId),
        reason: `same subject + same time slot (${canonical.subjectId}, ${canonical.startISO} → ${canonical.endISO}); keeping the event with the more specific room`,
      });
      for (const r of rows) consumed.add(r.eventId);
    }

    const leftover = cluster.filter((e) => !consumed.has(e.eventId));
    if (leftover.length >= 2) remainingClusters.push(leftover);
  }
  return { autoMerges, remainingClusters };
}

/** All events have the same `kind`, OR they're a mix of "other" + a specific
 *  kind (PDF agent sometimes emits "other" for sessions it couldn't classify;
 *  iCal labels them precisely — those are still the same session). */
function compatibleKinds(rows: CalendarItemRow[]): boolean {
  const kinds = new Set(rows.map((r) => r.kind));
  if (kinds.size === 1) return true;
  // A lecture session that the agent labelled "other" should still merge
  // with the iCal LEC entry. Only allow a single "real" kind alongside "other".
  if (!kinds.has('other')) return false;
  kinds.delete('other');
  return kinds.size === 1;
}

/** Higher score = more specific room. Rooms with a building name + a coded
 *  room number ("Shrum Science Centre Chemistry - C9002") beat generic
 *  "Burnaby Campus C9002" beat null. */
function roomScore(r: CalendarItemRow): number {
  const room = r.room ?? '';
  if (!room) return 0;
  let score = room.length; // longer ≈ more specific in practice
  if (/\s-\s/.test(room)) score += 50;       // "Building - Room" pattern
  if (/[A-Z]{2,}\d/.test(room)) score += 25; // contains a code like SSCC9002
  if (/Campus$/i.test(room)) score -= 30;    // generic "X Campus" demoted
  return score;
}

/** Make sure `canonicalEventId` belongs to a subject that still exists.
 *  If not, swap it with a redundant id whose subject is valid. Returns null
 *  if no event in the merge has a valid subject. */
function correctCanonical(
  m: { canonicalEventId: string; redundantEventIds: string[]; reason: string },
  clusters: CalendarItemRow[][],
  validSubjectIds: Set<string>,
): { canonicalEventId: string; redundantEventIds: string[]; reason: string } | null {
  const lookupSubject = (eventId: string): string | null => {
    for (const cluster of clusters) {
      const ev = cluster.find((e) => e.eventId === eventId);
      if (ev) return ev.subjectId;
    }
    return null;
  };
  const canonicalSubject = lookupSubject(m.canonicalEventId);
  if (canonicalSubject && validSubjectIds.has(canonicalSubject)) return m;
  for (let i = 0; i < m.redundantEventIds.length; i++) {
    const rid = m.redundantEventIds[i]!;
    const rSubject = lookupSubject(rid);
    if (rSubject && validSubjectIds.has(rSubject)) {
      const newRedundant = [...m.redundantEventIds];
      newRedundant[i] = m.canonicalEventId;
      return {
        canonicalEventId: rid,
        redundantEventIds: newRedundant,
        reason: `${m.reason} (canonical swapped to ${rid.slice(0, 12)}… because original pointed at a deleted subject)`,
      };
    }
  }
  return null;
}

/**
 * Walk a possibly-truncated JSON blob, pull out the leading {...} entries
 * inside each top-level array, and rebuild a DedupPlan from whatever fully
 * parsed. Used when generateObject's strict schema validation rejects the
 * model's output (almost always due to `maxTokens` cutting off a string).
 */
function salvagePartialPlan(
  text: string,
  validSubjectIds: Set<string>,
  validEventIds: Set<string>,
  clusters: CalendarItemRow[][],
): DedupPlan | null {
  const subjectEntries = extractEntriesFromArray(text, 'subjectMerges');
  const eventEntries = extractEntriesFromArray(text, 'eventMerges');
  if (subjectEntries.length === 0 && eventEntries.length === 0) return null;

  const subjectMerges = subjectEntries
    .filter((e): e is { fromId: string; intoId: string; reason: string } =>
      typeof e === 'object' && e !== null
      && typeof (e as Record<string, unknown>).fromId === 'string'
      && typeof (e as Record<string, unknown>).intoId === 'string'
      && validSubjectIds.has((e as { fromId: string }).fromId)
      && validSubjectIds.has((e as { intoId: string }).intoId)
      && (e as { fromId: string }).fromId !== (e as { intoId: string }).intoId,
    )
    .map((e) => ({ fromId: e.fromId, intoId: e.intoId, reason: e.reason ?? '' }));

  const fromIds = new Set(subjectMerges.map((m) => m.fromId));
  const eventMerges: DedupPlan['eventMerges'] = [];
  for (const e of eventEntries) {
    if (typeof e !== 'object' || e === null) continue;
    const obj = e as Record<string, unknown>;
    const canonical = typeof obj.canonicalEventId === 'string' ? obj.canonicalEventId : null;
    const redundant = Array.isArray(obj.redundantEventIds)
      ? obj.redundantEventIds.filter((r): r is string => typeof r === 'string')
      : null;
    if (!canonical || !redundant || redundant.length === 0) continue;
    if (!validEventIds.has(canonical)) continue;
    if (!redundant.every((id) => validEventIds.has(id))) continue;
    // Drop if a subject merge already covers this — the subject pass deletes
    // those Google events on its own.
    const allIds = [canonical, ...redundant];
    const subjectsTouched = new Set<string>();
    for (const id of allIds) {
      for (const cluster of clusters) {
        const ev = cluster.find((c) => c.eventId === id);
        if (ev) subjectsTouched.add(ev.subjectId);
      }
    }
    let subsumed = false;
    for (const sid of subjectsTouched) if (fromIds.has(sid)) { subsumed = true; break; }
    if (subsumed) continue;

    const corrected = correctCanonical(
      { canonicalEventId: canonical, redundantEventIds: redundant, reason: typeof obj.reason === 'string' ? obj.reason : '' },
      clusters,
      validSubjectIds,
    );
    if (corrected) eventMerges.push(corrected);
  }

  return { subjectMerges, eventMerges };
}

/** Extract leading complete `{...}` entries from `"<key>": [ ... ]` in a
 *  possibly-truncated JSON blob. Stops at the first malformed entry. */
function extractEntriesFromArray(text: string, key: string): unknown[] {
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`);
  const m = re.exec(text);
  if (!m) return [];
  const out: unknown[] = [];
  let i = m.index + m[0].length;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) i++;
    if (i >= text.length) break;
    if (text[i] === ']') break;
    if (text[i] !== '{') break;
    // Find matching closing brace, respecting strings + escapes.
    let depth = 0;
    let inStr = false;
    let escape = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) break; // truncated mid-entry
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      break;
    }
    i = end + 1;
  }
  return out;
}

async function fetchEventsForDedup(ctx: DedupCtx): Promise<CalendarItemRow[]> {
  const now = Date.now();
  // +/-90 days covers one full term comfortably and keeps the prompt bounded.
  const fromISO = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
  const toISO = new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString();
  return await listGoogleEvents(ctx.googleAuth, ctx.store, { fromISO, toISO, userId: ctx.userId });
}

function clusterByTimeConflict(events: CalendarItemRow[]): CalendarItemRow[][] {
  // Group events whose [start, end) ranges overlap on the same day. Only
  // emit clusters of size >= 2 since single-event "clusters" can't contain
  // duplicates. Holidays subject is filtered out  -  its overlap with class
  // events is intentional.
  const filtered = events.filter((e) => !HIDDEN_SUBJECT_IDS.has(e.subjectId));
  const sorted = [...filtered].sort((a, b) => a.startISO.localeCompare(b.startISO));
  const clusters: CalendarItemRow[][] = [];
  let cur: CalendarItemRow[] = [];
  let curEnd = '';
  for (const ev of sorted) {
    if (cur.length === 0 || ev.startISO >= curEnd) {
      if (cur.length >= 2) clusters.push(cur);
      cur = [ev];
      curEnd = ev.endISO;
    } else {
      cur.push(ev);
      if (ev.endISO > curEnd) curEnd = ev.endISO;
    }
  }
  if (cur.length >= 2) clusters.push(cur);
  return clusters;
}

function buildPrompt(subjects: Subject[], clusters: CalendarItemRow[][]): string {
  const subjLines = subjects.map((s) =>
    `  - id: ${s.id}  -  code: ${s.code ?? s.id}  -  name: ${s.name}  -  professor: ${s.professor || '(none)'}`,
  );
  const clusterBlocks = clusters.map((cluster, i) => {
    const head = `Cluster ${i + 1} (${cluster[0]!.startISO} -> ${cluster[0]!.endISO} and overlapping):`;
    const rows = cluster.map((e) =>
      `  - eventId: ${e.eventId}  -  subjectId: ${e.subjectId}  -  kind: ${e.kind}  -  summary: ${JSON.stringify(e.summary)}  -  room: ${JSON.stringify(e.room ?? '')}  -  ${e.startISO} -> ${e.endISO}`,
    );
    return [head, ...rows].join('\n');
  });
  return [
    'SUBJECTS:',
    ...(subjLines.length ? subjLines : ['  (none)']),
    '',
    'EVENT CLUSTERS:',
    ...(clusterBlocks.length ? clusterBlocks : ['  (no time conflicts in the current window)']),
    '',
    'Return your dedup plan.',
  ].join('\n');
}
