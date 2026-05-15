/* global React, ReactDOM, useHashRoute, GlobalNav, SchedulePage, SubjectsPage, SubjectDetail, AnnouncementsPage, useTweaks, TweaksPanel, TweakSection, TweakRadio */
const { useState, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "hero": "timeline",
  "liveClock": true
}/*EDITMODE-END*/;

function App() {
  const { route, param } = useHashRoute();
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [now, setNow] = useState(() => new Date());
  const [, setTick] = useState(0);
  const forceRender = () => setTick((n) => n + 1);

  useEffect(() => {
    if (!tweaks.liveClock) return;
    const id = setInterval(() => setNow(new Date()), 30 * 1000);
    return () => clearInterval(id);
  }, [tweaks.liveClock]);

  // Poll /api/status every 30s. If the pipeline finished (lastRunISO advanced)
  // since our last fetch, re-pull events and re-render.
  useEffect(() => {
    let cancelled = false;
    let lastSeenRun = window.SYNC_STATUS.lastRunISO;
    const id = setInterval(async () => {
      try {
        const status = await window.api.status();
        if (cancelled) return;
        window.SYNC_STATUS = status;
        if (status.lastRunISO && status.lastRunISO !== lastSeenRun) {
          lastSeenRun = status.lastRunISO;
          await window.refreshData();
        }
        forceRender();
      } catch (err) {
        console.warn('status poll failed', err);
      }
    }, 30 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  let body;
  if (route === 'subjects' && param) {
    body = <SubjectDetail id={param} now={now} />;
  } else if (route === 'subjects') {
    body = <SubjectsPage now={now} />;
  } else if (route === 'announcements') {
    body = <AnnouncementsPage subjectId={param} />;
  } else {
    body = <SchedulePage now={now} tweaks={tweaks} />;
  }

  return (
    <div className="app">
      <GlobalNav route={route} />
      {body}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Today panel">
          <TweakRadio
            value={tweaks.hero}
            onChange={(v) => setTweak('hero', v)}
            options={[
              { value: 'hero', label: 'Now hero' },
              { value: 'timeline', label: 'Timeline' },
              { value: 'list', label: 'Compact list' },
            ]}
          />
        </TweakSection>
        <TweakSection label="Clock">
          <TweakRadio
            value={tweaks.liveClock ? 'on' : 'off'}
            onChange={(v) => setTweak('liveClock', v === 'on')}
            options={[
              { value: 'off', label: 'Frozen' },
              { value: 'on', label: 'Live' },
            ]}
          />
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

function LoadingState({ error }) {
  return (
    <div style={{ padding: '64px 32px', fontFamily: 'system-ui, sans-serif', color: '#1d1d1f' }}>
      <h1 style={{ fontWeight: 600, fontSize: 28, margin: '0 0 8px' }}>auto-schedule</h1>
      <div style={{ color: '#7a7a7a', fontSize: 15 }}>
        {error
          ? <span style={{ color: '#d93025' }}>Failed to load: {String(error.message || error)}</span>
          : 'Loading subjects, events, and pipeline status...'}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<LoadingState />);

window.bootData()
  .then(() => root.render(<App />))
  .catch((err) => {
    console.error('boot failed', err);
    root.render(<LoadingState error={err} />);
  });
