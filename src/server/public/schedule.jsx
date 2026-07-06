/* global React, Util */
const { useState, useEffect, useMemo } = React;

const HOUR_START = 8;
const HOUR_END = 22;
const HOUR_PX = 44;

function WeekGrid({ weekStart, now, onEventClick }) {
  const days = Array.from({ length: 7 }, (_, i) => Util.addDays(weekStart, i));
  const events = Util.eventsForWeek(weekStart);
  const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => i + HOUR_START);

  return (
    <div className="week-grid">
      <div className="day-head spacer"></div>
      {days.map((d, i) => {
        const isToday = Util.sameDay(d, now);
        return (
          <div key={i} className={"day-head" + (isToday ? " today" : "")}>
            <div className="dow">{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
            <div className="dom">{d.getDate()}</div>
          </div>
        );
      })}

      {/* Hour gutter */}
      <div className="hour-col">
        {hours.map((h) => (
          <div key={h} className="hour-cell">
            <span className="hour-label">{Util.fmtTimeShort(new Date(2026, 0, 1, h, 0))}</span>
          </div>
        ))}
      </div>

      {days.map((d, i) => {
        const isToday = Util.sameDay(d, now);
        const dayEvents = events.filter((e) => Util.sameDay(e.start, d));
        return (
          <div key={i} className={"day-col" + (isToday ? " today" : "")}
            style={{ height: (HOUR_END - HOUR_START) * HOUR_PX }}>
            {hours.map((h) => (
              <div key={h} className="hour-cell" style={{ borderRight: 0 }}></div>
            ))}
            {isToday && Util.hoursDecimal(now) >= HOUR_START && Util.hoursDecimal(now) <= HOUR_END && (
              <div className="now-line" style={{ top: (Util.hoursDecimal(now) - HOUR_START) * HOUR_PX }}></div>
            )}
            {dayEvents.map((e) => {
              const subj = Util.subjectById(e.subjectId);
              if (!subj) return null;
              const isInstant = e.start.getTime() === e.end.getTime();
              const sameDay = Util.sameDay(e.start, e.end);
              const startH = Util.hoursDecimal(e.start);
              // Holidays come from CourSys with `DTSTART;VALUE=DATE` and
              // no DTEND, so our parser stores start === end at midnight.
              // Treat any event anchored at midnight that's either instant
              // or crosses a day boundary as a full-day banner.
              const isAllDay = startH === 0 && (isInstant || !sameDay);
              // Events that end on a later day (multi-day events) get
              // their endH clamped to 24 instead of `getHours() === 0` of
              // midnight-next-day, otherwise the filter below silently
              // drops them.
              let endH;
              if (isAllDay) endH = HOUR_END; // banner — drawn separately
              else if (isInstant) endH = startH + 0.6;
              else if (!sameDay) endH = 24;
              else endH = Util.hoursDecimal(e.end);
              if (!isAllDay && (endH < HOUR_START || startH > HOUR_END)) return null;
              // All-day events render as a thin banner pinned to the top of
              // the day column instead of a full-column block.
              const top = isAllDay
                ? 0
                : (Math.max(startH, HOUR_START) - HOUR_START) * HOUR_PX;
              const height = isAllDay
                ? 22
                : (Math.min(endH, HOUR_END) - Math.max(startH, HOUR_START)) * HOUR_PX - 2;
              return (
                <div key={e.itemId + e.start.toISOString()}
                  className={"event kind-" + e.kind + (isAllDay ? " event-allday" : "")}
                  style={{ top, height, borderLeftColor: subj.color }}
                  onClick={() => onEventClick && onEventClick(e)}
                  title={`${subj.code}  -  ${e.summary}  -  ${isAllDay ? 'All day' : Util.fmtTime(e.start)}`}>
                  {!isAllDay && (
                    <div className="ev-time">{isInstant ? `Due ${Util.fmtTime(e.start)}` : `${Util.fmtTime(e.start)}`}</div>
                  )}
                  <div className="ev-title">{subj.code}  -  {e.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</div>
                  {!isAllDay && e.room && height > 50 && <div className="ev-room">{e.room}</div>}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function NowHero({ now }) {
  const { happening, next } = Util.classifyNow(now);
  if (happening) {
    const subj = Util.subjectById(happening.subjectId);
    if (!subj) return null;
    const totalMin = Util.minutesBetween(happening.start, happening.end);
    const elapsed = Util.minutesBetween(happening.start, now);
    const pct = Math.max(0, Math.min(100, (elapsed / totalMin) * 100));
    const remaining = Math.max(0, Math.round(totalMin - elapsed));
    return (
      <div className="now-hero">
        <div className="now-badge"><span className="pulse" style={{ background: subj.color }}></span>Now</div>
        <h2>{subj.code}  -  {happening.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</h2>
        <div className="meta">{Util.fmtTime(happening.start)} - {Util.fmtTime(happening.end)}  -  {happening.room}</div>
        <div className="progress"><div style={{ width: pct + '%', background: subj.color }}></div></div>
        <div className="meta" style={{ marginTop: 8, fontSize: 12 }}>
          {remaining} min remaining  -  {Util.kindLabel(happening.kind)}
        </div>
      </div>
    );
  }
  if (next) {
    const subj = Util.subjectById(next.subjectId);
    if (!subj) return null;
    return (
      <div className="next-card">
        <div className="label">Up next</div>
        <div className="title">{subj.code}  -  {next.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</div>
        <div className="meta">{Util.fmtTime(next.start)} - {Util.fmtTime(next.end)}  -  {next.room}</div>
        <div className="in">{Util.relTime(next.start, now)}</div>
      </div>
    );
  }
  return (
    <div className="next-card">
      <div className="label">All clear</div>
      <div className="title">No more events today</div>
      <div className="meta">Enjoy the rest of your day.</div>
    </div>
  );
}

function TodayList({ now }) {
  const today = Util.eventsForDay(now);
  return (
    <div className="today-list">
      <h3>Today  -  {Util.fmtDayLong(now)}</h3>
      {today.length === 0 && <div style={{ padding: '12px 22px', color: 'var(--ink-muted-48)', fontSize: 14 }}>Nothing scheduled.</div>}
      {today.map((e) => {
        const subj = Util.subjectById(e.subjectId);
        if (!subj) return null;
        const isInstant = e.start.getTime() === e.end.getTime();
        const past = e.end < now;
        const cur = !isInstant && e.start <= now && e.end > now;
        return (
          <div key={e.subjectId + '-' + e.itemId} className={"today-row" + (past ? " past" : "") + (cur ? " now" : "")}>
            <div className="time">{Util.fmtTime(e.start)}</div>
            <div className="bar" style={{ background: subj.color }}></div>
            <div className="title">
              {subj.code}  -  {e.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}
              <span className="sub">{isInstant ? `Due  -  ${Util.kindLabel(e.kind)}` : `${Util.kindLabel(e.kind)}  -  ${e.room}`}</span>
            </div>
            <div className="right">{isInstant ? '' : Util.fmtTime(e.end)}</div>
          </div>
        );
      })}
    </div>
  );
}

function TodayTimeline({ now }) {
  const today = Util.eventsForDay(now);
  return (
    <div className="today-tl">
      <h3>Today  -  {Util.fmtDayLong(now)}</h3>
      <div className="tl-rail">
        {today.length === 0 && <div style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>Nothing scheduled.</div>}
        {today.map((e) => {
          const subj = Util.subjectById(e.subjectId);
          if (!subj) return null;
          const past = e.end < now;
          const isInstant = e.start.getTime() === e.end.getTime();
          const cur = !isInstant && e.start <= now && e.end > now;
          return (
            <div key={e.subjectId + '-' + e.itemId} className={"tl-item" + (past ? " past" : "") + (cur ? " now" : "")}>
              <div className="tl-time">{Util.fmtTimeShort(e.start)}</div>
              <div className="tl-dot" style={{ borderColor: cur ? subj.color : (past ? undefined : subj.color), background: cur ? subj.color : undefined }}></div>
              <div className="tl-title">{subj.code}  -  {e.summary.replace(/^(Lecture|Tutorial|Office hours)  -  /, '')}</div>
              <div className="tl-sub">{Util.kindLabel(e.kind)}  -  {e.room}{isInstant ? '' : `  -  until ${Util.fmtTimeShort(e.end)}`}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Deadlines({ now }) {
  const items = Util.upcomingDeadlines(now, 5);
  return (
    <div className="deadlines">
      <h3>Upcoming deadlines</h3>
      {items.length === 0 && <div style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>No upcoming deadlines.</div>}
      {items.map((e) => {
        const subj = Util.subjectById(e.subjectId);
        if (!subj) return null;
        const mins = Util.minutesBetween(now, e.start);
        const urgent = mins < 48 * 60;
        const when = e.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        return (
          <a key={e.subjectId + '-' + e.itemId} href={`#/subjects/${subj.id}`} className="deadline-row" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div>
              <div className="dr-title">{subj.code}  -  {e.summary}</div>
              <div className="dr-sub">{Util.kindLabel(e.kind)}  -  {when}</div>
            </div>
            <div className={"dr-when" + (urgent ? " urgent" : "")}>{Util.relTime(e.start, now)}</div>
          </a>
        );
      })}
    </div>
  );
}

// Phases the streamed POST /api/import/ical reports against. Rendered in
// this order as a vertical checklist so the user sees what's happening.
const ICAL_PHASES = [
  { key: 'fetch',  label: 'Pull events from CourSys' },
  // "Sync to Google Calendar" covers both the iCal upsert and the
  // reconcile-push that re-creates any locally-known events Google has
  // lost. They share the `upsert` progress row.
  { key: 'upsert', label: 'Sync to Google Calendar' },
  { key: 'dedup',  label: 'Merge duplicate subjects' },
  { key: 'enrich', label: 'Look up instructors (sfucourses.com)' },
];

function PhaseRow({ label, state }) {
  // state: { status: 'pending' | 'running' | 'done' | 'error', processed?, total?, detail? }
  const pct = state.total
    ? Math.round(((state.processed ?? 0) / state.total) * 100)
    : (state.status === 'done' ? 100 : 0);
  return (
    <div className={`ical-phase ical-phase-${state.status}`}>
      <div className="ical-phase-head">
        <span className="ical-phase-dot" />
        <span className="ical-phase-label">{label}</span>
        <span className="ical-phase-detail">
          {state.status === 'running' && state.total
            ? `${state.processed ?? 0} / ${state.total}`
            : state.status === 'done'
              ? (state.detail ?? '+')
              : state.status === 'error'
                ? 'failed'
                : ''}
        </span>
      </div>
      <div className="ical-phase-bar"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function emptyPhases() {
  const out = {};
  for (const p of ICAL_PHASES) out[p.key] = { status: 'pending' };
  return out;
}

function IcalSubscriptionButton() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);     // any in-flight request
  const [syncing, setSyncing] = useState(false); // streaming sync specifically
  const [phases, setPhases] = useState(emptyPhases);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const close = () => {
    // Lock the modal while a sync is in progress; only allow dismissal
    // once the stream has emitted `done` (or an error).
    if (syncing) return;
    setOpen(false);
    setError(null);
    setResult(null);
    setPhases(emptyPhases());
  };

  const openModal = async () => {
    setOpen(true);
    setResult(null);
    setError(null);
    setPhases(emptyPhases());
    if (!loaded) {
      try {
        const res = await fetch('/api/settings/ical-url');
        const body = await res.json();
        setUrl(body.url ?? '');
      } catch (err) {
        setError(err.message || String(err));
      } finally {
        setLoaded(true);
      }
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/settings/ical-url', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setUrl(body.url ?? '');
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const applyEvent = (evt, setLocalPhases) => {
    setLocalPhases((prev) => {
      const next = { ...prev };
      const cur = { ...(next[evt.stage] || { status: 'pending' }) };
      if (evt.stage === 'fetch') {
        if (evt.status === 'start') cur.status = 'running';
        if (evt.status === 'done') { cur.status = 'done'; cur.detail = `${evt.fetched} events`; }
      } else if (evt.stage === 'upsert') {
        if (evt.status === 'start') { cur.status = 'running'; cur.total = evt.total; cur.processed = 0; }
        if (evt.status === 'tick')  { cur.status = 'running'; cur.total = evt.total; cur.processed = evt.processed; }
        if (evt.status === 'done')  {
          cur.status = 'done';
          cur.processed = cur.total;
          const parts = [
            `+${evt.inserted} new`,
            `${evt.updated} updated`,
            `${evt.unchanged} unchanged`,
          ];
          if (evt.failures) parts.push(`${evt.failures} failed`);
          cur.detail = parts.join('  -  ');
        }
      } else if (evt.stage === 'dedup') {
        if (evt.status === 'analyzing') {
          cur.status = 'running';
          cur.processed = 0;
          cur.total = 0;
          cur.detail = 'agent analysing...';
        }
        if (evt.status === 'tick') {
          cur.status = 'running';
          cur.processed = evt.processed;
          cur.total = evt.total;
          cur.detail = `${evt.kind} merge: ${evt.detail ?? ''}`;
        }
        if (evt.status === 'done') {
          cur.status = 'done';
          const parts = [];
          if (evt.subjectMerges) parts.push(`${evt.subjectMerges} subject${evt.subjectMerges === 1 ? '' : 's'}`);
          if (evt.eventMerges) parts.push(`${evt.eventMerges} event${evt.eventMerges === 1 ? '' : 's'}`);
          cur.detail = parts.length ? parts.join('  -  ') + ' merged' : 'no duplicates';
        }
      } else if (evt.stage === 'enrich') {
        if (evt.status === 'start') {
          cur.status = 'running';
          cur.processed = 0;
          cur.total = evt.total;
          cur.detail = evt.total === 0 ? 'no subjects need filling' : 'querying sfucourses.com...';
          if (evt.total === 0) cur.status = 'done';
        }
        if (evt.status === 'tick') {
          cur.status = 'running';
          cur.processed = evt.processed;
          cur.total = evt.total;
          cur.detail = `${evt.subjectId}${evt.filled ? ' (filled)' : ''}`;
        }
        if (evt.status === 'done') {
          cur.status = 'done';
          cur.detail = evt.filled > 0
            ? `filled ${evt.filled}/${evt.tried} subject${evt.tried === 1 ? '' : 's'}`
            : evt.tried === 0
              ? 'no subjects need filling'
              : `tried ${evt.tried}, no matches`;
        }
      } else if (evt.stage === 'error') {
        // Mark whichever stage was currently running as errored.
        for (const k of Object.keys(next)) {
          if (next[k].status === 'running') next[k] = { ...next[k], status: 'error' };
        }
        return next;
      }
      next[evt.stage] = cur;
      return next;
    });
  };

  const syncNow = async () => {
    setBusy(true);
    setSyncing(true);
    setError(null);
    setResult(null);
    setPhases(emptyPhases());
    try {
      const res = await fetch('/api/import/ical', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let finalResult = null;
      let streamError = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.stage === 'done') finalResult = evt.result;
          if (evt.stage === 'error') streamError = evt.message;
          applyEvent(evt, setPhases);
        }
      }
      if (streamError) throw new Error(streamError);
      if (!finalResult) throw new Error('sync ended without a final result');
      setResult(finalResult);
      await window.bootData();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      setSyncing(false);
    }
  };

  const modal = open ? (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-result" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>CourSys iCal subscription</h2>
          <button
            type="button"
            className="close"
            onClick={close}
            aria-label="Close"
            disabled={syncing}
            style={syncing ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
          >x</button>
        </header>
        <div className="body">
          <p style={{ fontSize: 13, color: 'var(--ink-muted-80)', margin: '4px 0 12px' }}>
            Paste the global iCal URL from CourSys. Sync runs every pipeline tick and includes an automatic dedup pass so PDF- and iCal-created subjects collapse together.
          </p>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted-48)', marginBottom: 4 }}>iCal URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://coursys.sfu.ca/calendar/..."
            disabled={syncing}
            style={{ width: '100%', padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
          />

          {(syncing || result) && (
            <div className="ical-phases">
              {ICAL_PHASES.map((p) => (
                <PhaseRow key={p.key} label={p.label} state={phases[p.key]} />
              ))}
            </div>
          )}

          {result && (
            <>
              <div className="summary" style={{ marginTop: 14 }}>
                {result.fetched} VEVENTs fetched  -  {result.attributed} attributed
                {result.subjectsCreated > 0 ? `  -  ${result.subjectsCreated} subjects auto-created` : ''}
                {result.subjectMerges > 0 ? `  -  ${result.subjectMerges} subject${result.subjectMerges === 1 ? '' : 's'} merged` : ''}
                {result.eventMerges > 0 ? `  -  ${result.eventMerges} event${result.eventMerges === 1 ? '' : 's'} merged` : ''}
                {result.googleEventsDeleted > 0 ? `  -  ${result.googleEventsDeleted} stale Google events removed` : ''}
                {result.subjectsEnriched > 0 ? `  -  ${result.subjectsEnriched} instructor${result.subjectsEnriched === 1 ? '' : 's'} filled` : ''}
                .
              </div>
              {result.dedupWarning && (
                <div style={{
                  marginTop: 10, padding: '8px 10px', borderRadius: 6,
                  background: '#fff5e6', color: '#8a4b00', fontSize: 13,
                  border: '1px solid #ffd6a8',
                }}>
                  <strong>Dedup agent warning:</strong> {result.dedupWarning}
                </div>
              )}
            </>
          )}
          {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn-ghost-pill" onClick={save} disabled={busy}>
            {busy && !syncing ? 'Saving...' : 'Save URL'}
          </button>
          <button type="button" className="btn-primary" onClick={syncNow} disabled={busy || !url.trim()}>
            {syncing ? 'Syncing...' : 'Sync now'}
          </button>
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button type="button" className="btn-ghost-pill" onClick={openModal}>iCal subscription</button>
      {modal && ReactDOM.createPortal(modal, document.body)}
    </>
  );
}

function ImportSfuButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = React.useRef(null);

  const close = () => { setResult(null); setError(null); };

  const handleFile = async (file) => {
    close();
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('pdf', file, file.name);
      const res = await fetch('/api/import/sfu', { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body);
      await window.bootData();
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const modal = (result || error) ? (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal import-result" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{error ? 'Import failed' : 'Schedule imported'}</h2>
          <button type="button" className="close" onClick={close} aria-label="Close">x</button>
        </header>
        <div className="body">
          {error ? (
            <div className="form-error">{error}</div>
          ) : (
            <>
              <div className="term-line">
                Term: <strong>{result.term.label}</strong>  -  {result.term.startDate} -> {result.term.endDate}
              </div>
              <ul className="course-list">
                {result.courses.map((c) => (
                  <li key={c.code}>
                    <strong>{c.code}</strong>  -  {c.title}
                    <div className="sub">
                      {c.sections} section{c.sections === 1 ? '' : 's'}  -  {c.meetings} meeting{c.meetings === 1 ? '' : 's'}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="summary">
                Subjects created: {result.result.subjectsCreated}  -  merged: {result.result.subjectsMerged}<br />
                Events inserted: {result.result.eventsInserted}  -  updated: {result.result.eventsUpdated}  -  unchanged: {result.result.eventsUnchanged}
                {result.result.failures > 0 ? `  -  failures: ${result.result.failures}` : ''}
              </div>
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button type="button" className="btn-primary" onClick={close}>Done</button>
        </footer>
      </div>
    </div>
  ) : null;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files && e.target.files[0];
          if (f) handleFile(f);
        }}
      />
      <button
        type="button"
        className="btn-ghost-pill"
        onClick={() => inputRef.current && inputRef.current.click()}
        disabled={busy}
      >
        {busy ? 'Importing...' : 'Import SFU schedule'}
      </button>
      {/* Portal to body so the fixed-position backdrop isn't constrained by
          the sticky SubNav it lives in, which would push it down on scroll. */}
      {modal && ReactDOM.createPortal(modal, document.body)}
    </>
  );
}

// SFU Room Finder deep link. Query is just the room code — building letters
// glued to the number ("AQ 3181" -> AQ3181, "SSCC 9001, Burnaby Campus" ->
// SSCC9001); Room Finder's search snaps to the code, extra words break it.
function roomFinderUrl(room) {
  const s = String(room);
  const m = /([A-Za-z]{1,6})\s*-?\s*(\d{3,5}(?:\.\d+)?)/.exec(s);
  const q = m
    ? `${m[1]}${m[2]}`.toUpperCase()
    : s.split(',')[0].replace(/\s+/g, '').toUpperCase();
  return 'https://roomfinder.sfu.ca/apps/sfuroomfinder_web/?q=' + encodeURIComponent(q);
}
window.roomFinderUrl = roomFinderUrl;

// Detail card for a clicked calendar event.
function EventDetails({ event, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const subj = Util.subjectById(event.subjectId);
  const isInstant = event.start.getTime() === event.end.getTime();
  const sameDay = Util.sameDay(event.start, event.end);
  const dateLine = event.start.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  const timeLine = isInstant
    ? `Due at ${Util.fmtTime(event.start)}`
    : sameDay
      ? `${Util.fmtTime(event.start)} - ${Util.fmtTime(event.end)}`
      : `${Util.fmtTime(event.start)} -> ${event.end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${Util.fmtTime(event.end)}`;

  const row = (label, value) => value ? (
    <div className="ed-row">
      <div className="ed-label">{label}</div>
      <div className="ed-value">{value}</div>
    </div>
  ) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal event-details" onClick={(e) => e.stopPropagation()}>
        <header>
          {subj && <span className="ed-dot" style={{ background: subj.color }}></span>}
          <h2>{event.summary}</h2>
          <button type="button" className="close" onClick={onClose} aria-label="Close">x</button>
        </header>
        <div className="ed-body">
          {row('Subject', subj ? `${subj.code || subj.id}${subj.name && subj.name !== subj.code ? `  -  ${subj.name}` : ''}` : event.subjectId)}
          {row('Type', <span className="ed-kind">{Util.kindLabel(event.kind)}</span>)}
          {row('Date', dateLine)}
          {row('Time', timeLine)}
          {row('Room', event.room && (
            <a href={roomFinderUrl(event.room)} target="_blank" rel="noopener noreferrer"
               title="Open in SFU Room Finder">
              {event.room} {'↗'}
            </a>
          ))}
          {row('Source', event.sourceLabel)}
          {event.description && <div className="ed-description">{event.description}</div>}
          {event.attachments && event.attachments.length > 0 && (
            <div className="ed-attachments">
              {event.attachments.map((a, i) => (
                <a key={i} href={a.url} target="_blank" rel="noopener noreferrer">
                  {a.filename || a.url}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SchedulePage({ now, tweaks }) {
  const [weekStart, setWeekStart] = useState(() => Util.startOfWeek(now));
  const [selectedEvent, setSelectedEvent] = useState(null);
  const weekEnd = Util.addDays(weekStart, 6);

  const heroVariant = tweaks.hero || 'hero';

  return (
    <div data-screen-label="Schedule">
      <SubNav
        title="Schedule"
        right={(
          <>
            <IcalSubscriptionButton />
            <ImportSfuButton />
            <button className="btn-ghost-pill" onClick={() => window.location.hash = '#/subjects'}>Subjects</button>
          </>
        )}
      />
      <div className="schedule-grid">
        <section className="week">
          <div className="week-head">
            <div>
              <div className="title">{Util.fmtMonthRange(weekStart, weekEnd)}</div>
              <div className="sub">Week of {weekStart.toLocaleDateString('en-US', { weekday: 'long' })}</div>
            </div>
            <div className="week-nav">
              <button className="nav-btn" onClick={() => setWeekStart(Util.addDays(weekStart, -7))} aria-label="Previous week">{'<'}</button>
              <button className="today-btn" onClick={() => setWeekStart(Util.startOfWeek(now))}>Today</button>
              <button className="nav-btn" onClick={() => setWeekStart(Util.addDays(weekStart, 7))} aria-label="Next week">{'>'}</button>
            </div>
          </div>
          <WeekGrid weekStart={weekStart} now={now} onEventClick={setSelectedEvent} />
        </section>
        <aside className="side-rail">
          {heroVariant === 'hero' && <NowHero now={now} />}
          {heroVariant === 'timeline' && <TodayTimeline now={now} />}
          {heroVariant === 'list' && <TodayList now={now} />}
          {heroVariant === 'hero' && <TodayList now={now} />}
          <Deadlines now={now} />
        </aside>
      </div>
      {selectedEvent && <EventDetails event={selectedEvent} onClose={() => setSelectedEvent(null)} />}
    </div>
  );
}

Object.assign(window, { SchedulePage });
