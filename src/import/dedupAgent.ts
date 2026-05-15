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

  if (subjects.length < 2 && clusters.length === 0) {
    return { plan: { subjectMerges: [], eventMerges: [] } };
  }

  const prompt = buildPrompt(subjects, clusters);
  logger.info(
    { subjects: subjects.length, clusters: clusters.length, model: DEFAULT_MODEL },
    'dedup: asking agent',
  );

  // Build the set of event IDs the model is allowed to reference. Anything
  // outside this set is hallucinated and gets dropped before execution.
  const validEventIds = new Set<string>();
  for (const cluster of clusters) for (const e of cluster) validEventIds.add(e.eventId);
  const validSubjectIds = new Set<string>(subjects.map((s) => s.id));

  try {
    const result = await generateObject({
      model: getProvider()(DEFAULT_MODEL),
      schema: DedupPlanSchema,
      temperature: 0.1,
      // 4000 fits ~80 merges; the prompt steers the model toward subjectMerges
      // (which scale) so it should rarely come anywhere near this ceiling.
      maxTokens: 4000,
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
    // Also drop event merges that would be subsumed by a subject merge: if
    // any referenced event row belongs to a `fromId` that is itself being
    // merged, the subject pass will already delete those Google events.
    const fromIds = new Set(cleanedSubjectMerges.map((m) => m.fromId));
    const subsumedFilter = cleanedEventMerges.filter((m) => {
      const all = [m.canonicalEventId, ...m.redundantEventIds];
      const subjectsTouched = new Set<string>();
      for (const id of all) {
        for (const cluster of clusters) {
          const ev = cluster.find((e) => e.eventId === id);
          if (ev) subjectsTouched.add(ev.subjectId);
        }
      }
      // Keep only if no event in this merge is under a subject scheduled for merge.
      for (const sid of subjectsTouched) if (fromIds.has(sid)) return false;
      return true;
    });

    const plan: DedupPlan = {
      subjectMerges: cleanedSubjectMerges,
      eventMerges: subsumedFilter,
    };
    logger.info(
      {
        promptTokens: result.usage?.promptTokens,
        completionTokens: result.usage?.completionTokens,
        subjectMerges: plan.subjectMerges.length,
        subjectsDropped: beforeSubjects - plan.subjectMerges.length,
        eventMerges: plan.eventMerges.length,
        eventsDroppedHallucinated: beforeEvents - cleanedEventMerges.length,
        eventsDroppedSubsumed: cleanedEventMerges.length - subsumedFilter.length,
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
      const salvaged = salvagePartialPlan(err.text ?? '', validSubjectIds, validEventIds);
      if (salvaged) {
        logger.warn(
          {
            subjectMerges: salvaged.subjectMerges.length,
            eventMerges: salvaged.eventMerges.length,
            sample: err.text?.slice(0, 200),
          },
          'dedup: model output unparseable, salvaged partial plan via JSON repair',
        );
        return {
          plan: salvaged,
          warning: `agent output was truncated or invalid; recovered ${salvaged.subjectMerges.length} subject merge(s) + ${salvaged.eventMerges.length} event merge(s) via repair`,
        };
      }
      logger.warn(
        { text: err.text?.slice(0, 500) },
        'dedup: model produced unusable output and nothing was salvageable',
      );
      return {
        plan: { subjectMerges: [], eventMerges: [] },
        warning: 'agent returned no parseable plan',
      };
    }
    throw err;
  }
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
    // Skip if a subject merge already covers this — same logic as the
    // main path.
    if (fromIds.size > 0) {
      // No subject-id lookup here, just drop the merge if any subject is
      // being merged (conservative — better to skip than redo).
      continue;
    }
    eventMerges.push({ canonicalEventId: canonical, redundantEventIds: redundant, reason: typeof obj.reason === 'string' ? obj.reason : '' });
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
