/* global React, ReactDOM, Util, SubNav */
const { useState, useEffect, useCallback, useMemo } = React;

// ---------------------------------------------------------------------------
// CourSys Atom subscription modal — paste the news URL, save, sync now.
// Mirrors IcalSubscriptionButton's flow + locked-modal-while-syncing pattern.
// ---------------------------------------------------------------------------

function AtomSubscriptionButton({ onSynced }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState(null); // { phase, processed, total }
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const close = () => {
    if (syncing) return;
    setOpen(false);
    setError(null);
    setResult(null);
    setProgress(null);
  };

  const openModal = async () => {
    setOpen(true);
    setError(null);
    setResult(null);
    if (!loaded) {
      try {
        const res = await fetch('/api/settings/atom-url');
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
      const res = await fetch('/api/settings/atom-url', {
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

  const syncNow = async () => {
    setBusy(true); setSyncing(true);
    setError(null); setResult(null); setProgress(null);
    try {
      const res = await fetch('/api/import/atom', { method: 'POST' });
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
          else if (evt.stage === 'error') streamError = evt.message;
          else if (evt.stage === 'fetch' && evt.status === 'done') {
            setProgress({ phase: 'fetched', processed: evt.fetched, total: evt.fetched });
          } else if (evt.stage === 'persist') {
            setProgress({
              phase: 'persisting',
              processed: evt.processed ?? evt.total ?? 0,
              total: evt.total ?? 0,
            });
          }
        }
      }
      if (streamError) throw new Error(streamError);
      if (!finalResult) throw new Error('sync ended without a final result');
      setResult(finalResult);
      if (onSynced) await onSynced();
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
          <h2>CourSys announcements (Atom)</h2>
          <button
            type="button" className="close" onClick={close} aria-label="Close"
            disabled={syncing}
            style={syncing ? { opacity: 0.3, cursor: 'not-allowed' } : undefined}
          >{'x'}</button>
        </header>
        <div className="body">
          <p style={{ fontSize: 13, color: 'var(--ink-muted-80)', margin: '4px 0 12px' }}>
            Paste the CourSys news feed URL (looks like <code>https://coursys.sfu.ca/news/&lt;uuid&gt;/&lt;computing_id&gt;</code>). Each announcement is stored in the dashboard. A later LLM pass will turn date-bearing announcements into calendar items.
          </p>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--ink-muted-48)', marginBottom: 4 }}>Atom URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://coursys.sfu.ca/news/..."
            disabled={syncing}
            style={{ width: '100%', padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
          />

          {syncing && progress && (
            <div className="ical-phases" style={{ marginTop: 14 }}>
              <div className={`ical-phase ical-phase-running`}>
                <div className="ical-phase-head">
                  <span className="ical-phase-dot" />
                  <span className="ical-phase-label">
                    {progress.phase === 'fetched' ? 'Fetching feed' : 'Saving announcements'}
                  </span>
                  <span className="ical-phase-detail">
                    {progress.total ? `${progress.processed} / ${progress.total}` : '...'}
                  </span>
                </div>
                <div className="ical-phase-bar">
                  <div style={{ width: progress.total ? `${Math.round((progress.processed / progress.total) * 100)}%` : '5%' }} />
                </div>
              </div>
            </div>
          )}

          {result && (
            <div className="summary" style={{ marginTop: 14 }}>
              Fetched {result.fetched} entries · {result.inserted} new, {result.updated} updated
              {result.unattributed > 0 ? ` · ${result.unattributed} without a course code` : ''}
              {result.skipped > 0 ? ` · ${result.skipped} skipped` : ''}
              .
            </div>
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
      <button type="button" className="btn-ghost-pill" onClick={openModal}>Atom subscription</button>
      {modal && ReactDOM.createPortal(modal, document.body)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Announcements page — list every entry, group by subject, render the HTML
// body inline. Card click expands/collapses the body. Filter buttons by
// subject across the top.
// ---------------------------------------------------------------------------

function AnnouncementsPage({ subjectId }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState(subjectId || null);
  const [expanded, setExpanded] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/announcements');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setItems(Array.isArray(body) ? body : []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const subjectCounts = useMemo(() => {
    const map = new Map();
    for (const a of items) {
      const key = a.subjectId || '__unknown__';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [items]);

  const filtered = useMemo(() => {
    if (!filter) return items;
    if (filter === '__unknown__') return items.filter((a) => !a.subjectId);
    return items.filter((a) => a.subjectId === filter);
  }, [items, filter]);

  const toggle = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const fmtTime = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: false });
  };

  return (
    <div data-screen-label="Announcements">
      <SubNav
        title="Announcements"
        right={<AtomSubscriptionButton onSynced={load} />}
      />
      <div className="announcements-page">
        <div className="ann-hero">
          <div>
            <h1>Announcements</h1>
            <div className="sub">
              {items.length} entries pulled from the configured Atom feed.
            </div>
          </div>
        </div>

        {items.length > 0 && (
          <div className="ann-filters">
            <button
              type="button"
              className={"chip" + (filter === null ? " active" : "")}
              onClick={() => setFilter(null)}
            >All ({items.length})</button>
            {(window.SUBJECTS || [])
              .filter((s) => s.id !== 'holidays' && subjectCounts.has(s.id))
              .map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={"chip" + (filter === s.id ? " active" : "")}
                  onClick={() => setFilter(s.id)}
                  style={{ borderColor: filter === s.id ? s.color : undefined }}
                >
                  <span className="dot" style={{ background: s.color }} />
                  {s.code || s.id} ({subjectCounts.get(s.id)})
                </button>
              ))}
            {subjectCounts.has('__unknown__') && (
              <button
                type="button"
                className={"chip" + (filter === '__unknown__' ? " active" : "")}
                onClick={() => setFilter('__unknown__')}
              >No course ({subjectCounts.get('__unknown__')})</button>
            )}
          </div>
        )}

        {loading && <div className="ann-empty">Loading…</div>}
        {!loading && error && <div className="form-error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="ann-empty">
            No announcements yet. Click <strong>Atom subscription</strong> above to add your CourSys news URL.
          </div>
        )}

        <div className="ann-list">
          {filtered.map((a) => {
            const subj = window.SUBJECTS.find((s) => s.id === a.subjectId);
            const isOpen = expanded.has(a.entryId);
            return (
              <article key={a.entryId} className="ann-card">
                <header onClick={() => toggle(a.entryId)}>
                  <div className="ann-tag" style={{ background: subj?.color || '#a8a8ad' }}>
                    {subj?.code || a.courseCode || '—'}
                  </div>
                  <div className="ann-titleblock">
                    <div className="ann-title">{a.title || '(untitled)'}</div>
                    <div className="ann-meta">
                      {a.author ? `${a.author} · ` : ''}{fmtTime(a.publishedAt) || fmtTime(a.fetchedAt)}
                      {a.link && (
                        <>
                          {' · '}
                          <a href={a.link} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>open original</a>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="ann-chev">{isOpen ? '−' : '+'}</div>
                </header>
                {isOpen && (
                  <div
                    className="ann-body"
                    dangerouslySetInnerHTML={{ __html: a.contentHtml || '<em>(no content)</em>' }}
                  />
                )}
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AnnouncementsPage, AtomSubscriptionButton });
