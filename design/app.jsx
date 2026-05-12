/* global React, ReactDOM, useHashRoute, GlobalNav, SchedulePage, SubjectsPage, SubjectDetail, useTweaks, TweaksPanel, TweakSection, TweakRadio */
const { useState, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "hero": "timeline",
  "liveClock": true
}/*EDITMODE-END*/;

function App() {
  const { route, param } = useHashRoute();
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [now, setNow] = useState(() => new Date(window.TODAY));

  useEffect(() => {
    if (!tweaks.liveClock) return;
    const id = setInterval(() => {
      setNow((n) => {
        const next = new Date(n.getTime() + 60000);
        return next;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [tweaks.liveClock]);

  let body;
  if (route === 'subjects' && param) {
    body = <SubjectDetail id={param} now={now} />;
  } else if (route === 'subjects') {
    body = <SubjectsPage now={now} />;
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

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
