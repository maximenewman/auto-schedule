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
              const isInstant = e.start.getTime() === e.end.getTime();
              const startH = Util.hoursDecimal(e.start);
              const endH = isInstant ? startH + 0.6 : Util.hoursDecimal(e.end);
              if (endH < HOUR_START || startH > HOUR_END) return null;
              const top = (Math.max(startH, HOUR_START) - HOUR_START) * HOUR_PX;
              const height = (Math.min(endH, HOUR_END) - Math.max(startH, HOUR_START)) * HOUR_PX - 2;
              return (
                <div key={e.itemId + e.start.toISOString()}
                  className={"event kind-" + e.kind}
                  style={{ top, height, borderLeftColor: subj.color }}
                  onClick={() => onEventClick && onEventClick(e)}
                  title={`${subj.code} · ${e.summary} · ${Util.fmtTime(e.start)}`}>
                  <div className="ev-time">{isInstant ? `Due ${Util.fmtTime(e.start)}` : `${Util.fmtTime(e.start)}`}</div>
                  <div className="ev-title">{subj.code} · {e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
                  {e.room && height > 50 && <div className="ev-room">{e.room}</div>}
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
    const totalMin = Util.minutesBetween(happening.start, happening.end);
    const elapsed = Util.minutesBetween(happening.start, now);
    const pct = Math.max(0, Math.min(100, (elapsed / totalMin) * 100));
    const remaining = Math.max(0, Math.round(totalMin - elapsed));
    return (
      <div className="now-hero">
        <div className="now-badge"><span className="pulse" style={{ background: subj.color }}></span>Now</div>
        <h2>{subj.code} · {happening.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</h2>
        <div className="meta">{Util.fmtTime(happening.start)} – {Util.fmtTime(happening.end)} · {happening.room}</div>
        <div className="progress"><div style={{ width: pct + '%', background: subj.color }}></div></div>
        <div className="meta" style={{ marginTop: 8, fontSize: 12 }}>
          {remaining} min remaining · {Util.kindLabel(happening.kind)}
        </div>
      </div>
    );
  }
  if (next) {
    const subj = Util.subjectById(next.subjectId);
    return (
      <div className="next-card">
        <div className="label">Up next</div>
        <div className="title">{subj.code} · {next.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
        <div className="meta">{Util.fmtTime(next.start)} – {Util.fmtTime(next.end)} · {next.room}</div>
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
      <h3>Today · {Util.fmtDayLong(now)}</h3>
      {today.length === 0 && <div style={{ padding: '12px 22px', color: 'var(--ink-muted-48)', fontSize: 14 }}>Nothing scheduled.</div>}
      {today.map((e) => {
        const subj = Util.subjectById(e.subjectId);
        const isInstant = e.start.getTime() === e.end.getTime();
        const past = e.end < now;
        const cur = !isInstant && e.start <= now && e.end > now;
        return (
          <div key={e.subjectId + '-' + e.itemId} className={"today-row" + (past ? " past" : "") + (cur ? " now" : "")}>
            <div className="time">{Util.fmtTime(e.start)}</div>
            <div className="bar" style={{ background: subj.color }}></div>
            <div className="title">
              {subj.code} · {e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}
              <span className="sub">{isInstant ? `Due · ${Util.kindLabel(e.kind)}` : `${Util.kindLabel(e.kind)} · ${e.room}`}</span>
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
      <h3>Today · {Util.fmtDayLong(now)}</h3>
      <div className="tl-rail">
        {today.length === 0 && <div style={{ color: 'var(--ink-muted-48)', fontSize: 14 }}>Nothing scheduled.</div>}
        {today.map((e) => {
          const subj = Util.subjectById(e.subjectId);
          const past = e.end < now;
          const isInstant = e.start.getTime() === e.end.getTime();
          const cur = !isInstant && e.start <= now && e.end > now;
          return (
            <div key={e.subjectId + '-' + e.itemId} className={"tl-item" + (past ? " past" : "") + (cur ? " now" : "")}>
              <div className="tl-time">{Util.fmtTimeShort(e.start)}</div>
              <div className="tl-dot" style={{ borderColor: cur ? subj.color : (past ? undefined : subj.color), background: cur ? subj.color : undefined }}></div>
              <div className="tl-title">{subj.code} · {e.summary.replace(/^(Lecture|Tutorial|Office hours) · /, '')}</div>
              <div className="tl-sub">{Util.kindLabel(e.kind)} · {e.room}{isInstant ? '' : ` · until ${Util.fmtTimeShort(e.end)}`}</div>
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
      {items.map((e) => {
        const subj = Util.subjectById(e.subjectId);
        const mins = Util.minutesBetween(now, e.start);
        const urgent = mins < 48 * 60;
        const when = e.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
        return (
          <a key={e.subjectId + '-' + e.itemId} href={`#/subjects/${subj.id}`} className="deadline-row" style={{ color: 'inherit', textDecoration: 'none' }}>
            <div>
              <div className="dr-title">{subj.code} · {e.summary}</div>
              <div className="dr-sub">{Util.kindLabel(e.kind)} · {when}</div>
            </div>
            <div className={"dr-when" + (urgent ? " urgent" : "")}>{Util.relTime(e.start, now)}</div>
          </a>
        );
      })}
    </div>
  );
}

function SchedulePage({ now, tweaks }) {
  const [weekStart, setWeekStart] = useState(() => Util.startOfWeek(now));
  const weekEnd = Util.addDays(weekStart, 6);

  const heroVariant = tweaks.hero || 'hero';

  return (
    <div data-screen-label="Schedule">
      <SubNav
        title="Schedule"
        right={(
          <>
            <div className="sync-pill">
              <span className="dot"></span>
              Synced 08:00 · 3 added
            </div>
            <button className="btn-ghost-pill" onClick={() => window.location.hash = '#/subjects'}>Subjects</button>
            <button className="btn-primary">Sync now</button>
          </>
        )}
      />
      <div className="schedule-grid">
        <section className="week">
          <div className="week-head">
            <div>
              <div className="title">{Util.fmtMonthRange(weekStart, weekEnd)}</div>
              <div className="sub">Week of {weekStart.toLocaleDateString('en-US', { weekday: 'long' })} · Summer 2026</div>
            </div>
            <div className="week-nav">
              <button className="nav-btn" onClick={() => setWeekStart(Util.addDays(weekStart, -7))} aria-label="Previous week">‹</button>
              <button className="today-btn" onClick={() => setWeekStart(Util.startOfWeek(now))}>Today</button>
              <button className="nav-btn" onClick={() => setWeekStart(Util.addDays(weekStart, 7))} aria-label="Next week">›</button>
            </div>
          </div>
          <WeekGrid weekStart={weekStart} now={now} />
        </section>
        <aside className="side-rail">
          {heroVariant === 'hero' && <NowHero now={now} />}
          {heroVariant === 'timeline' && <TodayTimeline now={now} />}
          {heroVariant === 'list' && <TodayList now={now} />}
          {heroVariant === 'hero' && <TodayList now={now} />}
          <Deadlines now={now} />
        </aside>
      </div>
    </div>
  );
}

Object.assign(window, { SchedulePage });
