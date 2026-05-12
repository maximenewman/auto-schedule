/* global React, Util */
// Shell + nav + router

const { useState, useEffect } = React;

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  // Parse:  '#/'  '#/subjects'  '#/subjects/cmpt307'
  const parts = hash.replace(/^#\//, '').split('/').filter(Boolean);
  return { hash, route: parts[0] || 'schedule', param: parts[1] || null, setHash };
}

function GlobalNav({ route }) {
  const items = [
    { id: 'schedule', label: 'Schedule', href: '#/' },
    { id: 'subjects', label: 'Subjects', href: '#/subjects' },
  ];
  const s = window.SYNC_STATUS;
  const sync = s.googleAuthOk && s.coursysAuthOk;
  return (
    <header className="global-nav" data-screen-label="Global nav">
      <div className="brand"><span className="dot"></span>auto-schedule</div>
      <nav>
        {items.map((it) => (
          <a key={it.id} href={it.href} className={route === it.id ? 'active' : ''}>{it.label}</a>
        ))}
        <a href="#/" style={{ color: 'rgba(255,255,255,0.6)' }}>Files</a>
        <a href="#/" style={{ color: 'rgba(255,255,255,0.6)' }}>Sync</a>
      </nav>
      <div className="status">
        <span><span className="dot-ok" style={{ background: sync ? '#30d158' : '#ff9f0a' }}></span>
          Last sync 08:00 · 3 added</span>
      </div>
    </header>
  );
}

function SubNav({ title, crumbs, right }) {
  return (
    <div className="sub-nav" data-screen-label="Sub nav">
      {crumbs ? (
        <div className="crumbs">
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span style={{ color: 'var(--ink-muted-32)' }}>›</span>}
              {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
            </React.Fragment>
          ))}
        </div>
      ) : null}
      <div className="title">{title}</div>
      <div className="spacer"></div>
      <div className="right">{right}</div>
    </div>
  );
}

Object.assign(window, { useHashRoute, GlobalNav, SubNav });
