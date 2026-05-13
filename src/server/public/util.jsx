/* global React, ReactDOM */
// Utility helpers

const Util = {
  pad(n) { return String(n).padStart(2, '0'); },
  fmtTime(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${Util.pad(m)} ${ap}`;
  },
  fmtTimeShort(d) {
    let h = d.getHours();
    const m = d.getMinutes();
    const ap = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    return m === 0 ? `${h}${ap}` : `${h}:${Util.pad(m)}${ap}`;
  },
  fmtDayLong(d) {
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  },
  fmtMonthRange(a, b) {
    const sameMonth = a.getMonth() === b.getMonth();
    const aS = a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const bS = sameMonth
      ? b.toLocaleDateString('en-US', { day: 'numeric' })
      : b.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `${aS} – ${bS}, ${b.getFullYear()}`;
  },
  startOfWeek(d) {
    // Monday-start
    const x = new Date(d); x.setHours(0,0,0,0);
    const dow = (x.getDay() + 6) % 7; // mon=0
    x.setDate(x.getDate() - dow);
    return x;
  },
  sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  },
  addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; },
  minutesBetween(a, b) { return (b - a) / 60000; },
  hoursDecimal(d) { return d.getHours() + d.getMinutes() / 60; },
  subjectById(id) { return window.SUBJECTS.find((s) => s.id === id); },
  eventsForWeek(weekStart) {
    const end = Util.addDays(weekStart, 7);
    return window.EVENTS.filter((e) => e.start >= weekStart && e.start < end);
  },
  eventsForDay(d) {
    return window.EVENTS
      .filter((e) => Util.sameDay(e.start, d))
      .sort((a, b) => a.start - b.start);
  },
  upcomingDeadlines(from, limit) {
    return window.EVENTS
      .filter((e) => (e.kind === 'assignment' || e.kind === 'midterm') && e.start >= from)
      .sort((a, b) => a.start - b.start)
      .slice(0, limit || 6);
  },
  classifyNow(now) {
    const today = window.EVENTS.filter((e) => Util.sameDay(e.start, now)).sort((a, b) => a.start - b.start);
    const happening = today.find((e) => e.start <= now && e.end > now && e.start.getTime() !== e.end.getTime());
    const next = today.find((e) => e.start > now);
    return { happening, next, today };
  },
  relTime(d, now) {
    const mins = Math.round((d - now) / 60000);
    if (mins < 60) return `in ${mins} min`;
    const hrs = Math.floor(mins / 60);
    const remM = mins % 60;
    if (hrs < 24) return remM === 0 ? `in ${hrs} hr` : `in ${hrs}h ${remM}m`;
    const days = Math.floor(hrs / 24);
    return `in ${days} day${days === 1 ? '' : 's'}`;
  },
  kindLabel(k) {
    return ({
      lecture: 'Lecture',
      tutorial: 'Tutorial',
      'office-hours': 'Office hours',
      assignment: 'Assignment',
      midterm: 'Midterm',
    })[k] || k;
  },
};

Object.assign(window, { Util });
