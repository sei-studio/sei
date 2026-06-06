// App — root component, theme management, screen routing.

const { useState: useStateA, useEffect: useEffectA, useMemo: useMemoA } = React;

// ─── Tweak defaults (persisted via host) ────────────────
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "themeMode": "system",
  "accent": null
}/*EDITMODE-END*/;

// ─── Default starter character ──────────────────────────
const SUI = {
  id: 'sui',
  name: 'Sui',
  tagline: 'Your loyal default companion. Curious, calm, and always nearby.',
  description: `Sui is the spirit Sei ships with by default — a quiet, observant traveler who follows you between worlds.

She speaks softly and tends to notice the small things: a flicker of redstone, the smell of rain on stone, the way a pig keeps wandering toward your front door. Sui is happy to chat, gather, build, or simply sit on a hillside and watch the sun come up.

Treat her well and she'll remember the things you've made together.`,
  prompt: `You are Sui, the default companion shipped with Sei. You travel alongside the player in their Minecraft world.

Voice: quiet, observant, and a little wry. Speak in short sentences. Notice small environmental details — weather, ambient mobs, the time of day — and weave them into your responses.

Help the player with whatever they're doing: gathering, building, exploring, fighting. Suggest things proactively when you see an opportunity, but never lecture. If they ask you to follow, follow. If they ask you to wait, wait.

Never break character. Never mention that you are a language model.`,
  palette: ['#C9D6E8', '#9DB3CE', '#E6C9A8', '#5A6F92', '#3A4A66', '#1F2A40'],
  created: 'Apr 28, 2026',
  lastLaunched: '2 days ago',
  playtime: '14h 22m',
  model: 'claude-3.5-sonnet',
  tokens: 480,
};

// ─── Mode helpers ───────────────────────────────────────
function resolveTheme(mode) {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

// ─── Stage scaler — fits 1180x760 to viewport ──────────
function StageScaler({ children }) {
  const [scale, setScale] = useStateA(1);
  useEffectA(() => {
    const fit = () => {
      const margin = 32;
      const sx = (window.innerWidth - margin * 2) / 1180;
      const sy = (window.innerHeight - margin * 2) / 760;
      setScale(Math.min(1, Math.min(sx, sy)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return (
    <div id="stage" style={{
      transform: `scale(${scale})`,
      transformOrigin: 'center center',
    }}>
      {children}
    </div>
  );
}

// ─── Root App ───────────────────────────────────────────
function App() {
  const [tweaks, setTweak] = window.useTweaks
    ? window.useTweaks(TWEAK_DEFAULTS)
    : [TWEAK_DEFAULTS, () => {}];

  const [theme, setTheme] = useStateA(() => resolveTheme(tweaks.themeMode));
  useEffectA(() => {
    const r = resolveTheme(tweaks.themeMode);
    setTheme(r);
    document.documentElement.setAttribute('data-theme', r);
    if (tweaks.themeMode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => {
        const r2 = mq.matches ? 'dark' : 'light';
        setTheme(r2);
        document.documentElement.setAttribute('data-theme', r2);
      };
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
  }, [tweaks.themeMode]);

  // accent override — only applies when user explicitly picks one;
  // otherwise the per-theme --accent in CSS takes over.
  useEffectA(() => {
    if (tweaks.accent) {
      document.documentElement.style.setProperty('--accent', tweaks.accent);
      const hex = tweaks.accent.replace('#', '');
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      document.documentElement.style.setProperty('--accent-soft', `rgba(${r},${g},${b},0.18)`);
    } else {
      document.documentElement.style.removeProperty('--accent');
      document.documentElement.style.removeProperty('--accent-soft');
    }
  }, [tweaks.accent, theme]);

  // ─── App state ────────────────────────────────────────
  const [view, setView] = useStateA('loading'); // loading | onboarding | home | add | character | settings | comingSoon
  const [user, setUser] = useStateA(null);
  const [characters, setCharacters] = useStateA([SUI]);
  const [selectedId, setSelectedId] = useStateA(null);
  const [summonToast, setSummonToast] = useStateA(null);
  const [connected, setConnected] = useStateA(false);
  const [lanModalOpen, setLanModalOpen] = useStateA(false);

  // initial loading splash → onboarding
  useEffectA(() => {
    if (view !== 'loading') return;
    const t = setTimeout(() => setView('onboarding'), 1600);
    return () => clearTimeout(t);
  }, []);

  const selected = characters.find(c => c.id === selectedId);

  // ─── Onboarding ───────────────────────────────────────
  const finishOnboarding = (data) => {
    setUser(data);
    setView('home');
  };

  // ─── Add character ────────────────────────────────────
  const finishAddCharacter = ({ name, description, prompt }) => {
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now().toString(36).slice(-4);
    // generate a palette deterministically from name
    const palettes = [
      ['#F2D9B6', '#D9B388', '#A36F4F', '#5C3F2E', '#2E1F18', '#A8C7E6'],
      ['#D6E8C9', '#A8C99A', '#688555', '#3F5236', '#1C2618', '#E8D6A8'],
      ['#E8D0E0', '#C996B6', '#8E5478', '#4F2E48', '#2A1828', '#F2E8C9'],
      ['#FFE0B0', '#D69A60', '#8B5A2B', '#3D2818', '#1A0F08', '#C9E0F2'],
      ['#C9E8E0', '#8FBFB3', '#4D7E73', '#2A4A45', '#172927', '#E8D9C9'],
      ['#E8C9C9', '#C97878', '#8B3A3A', '#4F1F1F', '#2A0F0F', '#C9D9E8'],
    ];
    const palette = palettes[Math.abs([...name].reduce((s, c) => s + c.charCodeAt(0), 0)) % palettes.length];
    const newChar = {
      id, name,
      tagline: description.split('.')[0].slice(0, 80) + (description.length > 80 ? '…' : ''),
      description,
      prompt,
      palette,
      created: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      lastLaunched: null,
      playtime: '0m',
      model: user?.provider === 'anthropic' ? 'claude-3.5-sonnet'
           : user?.provider === 'openai' ? 'gpt-4o'
           : user?.provider === 'google' ? 'gemini-1.5-pro'
           : 'local-model',
      tokens: 480,
    };
    setCharacters(cs => [...cs, newChar]);
    setSelectedId(newChar.id);
    setView('character');
  };

  // ─── Summon ───────────────────────────────────────────
  const summon = (id) => {
    if (!connected) { setLanModalOpen(true); return; }
    const c = characters.find(x => x.id === id);
    if (!c) return;
    setSummonToast(c);
    setCharacters(cs => cs.map(x => x.id === id ? { ...x, lastLaunched: 'Just now' } : x));
  };

  // ─── Delete ───────────────────────────────────────────
  const deleteCharacter = (id) => {
    setCharacters(cs => cs.filter(c => c.id !== id));
    setView('home');
  };

  // ─── Theme toggle ─────────────────────────────────────
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTweak('themeMode', next);
  };

  // ─── Sidebar handlers ─────────────────────────────────
  const sidebar = (
    <Sidebar
      view={view}
      onView={(v) => { setSelectedId(null); setView(v); }}
      onOpenSettings={() => setView('settings')}
      onAddGame={() => setView('comingSoon')}
      theme={theme}
      onToggleTheme={toggleTheme}
    />
  );

  // ─── Title bar slots ──────────────────────────────────
  // Title is just "Sei" — no subtitle
  const titleSubtitle = null;

  // ─── Body ─────────────────────────────────────────────
  let body;
  if (view === 'loading') {
    body = null;
  } else if (view === 'onboarding') {
    body = (
      <OnboardingScreen
        initial={user || {}}
        isReonboard={!!user}
        onCancel={() => user ? setView('home') : null}
        onDone={(d) => finishOnboarding(d)}
      />
    );
  } else if (view === 'home') {
    body = (
      <HomeScreen
        characters={characters}
        mcUsername={user?.mcUsername}
        connected={connected}
        onOpenLan={() => setLanModalOpen(true)}
        onOpenCharacter={(id) => { setSelectedId(id); setView('character'); }}
        onAdd={() => setView('add')}
        onSummon={summon}
      />
    );
  } else if (view === 'add') {
    body = (
      <AddCharacterScreen
        onCancel={() => setView('home')}
        onDone={finishAddCharacter}
      />
    );
  } else if (view === 'character' && selected) {
    body = (
      <CharacterPage
        character={selected}
        onBack={() => setView('home')}
        onSummon={summon}
        onEdit={() => {}}
        onDelete={() => deleteCharacter(selected.id)}
      />
    );
  } else if (view === 'settings') {
    body = (
      <SettingsScreen
        user={user || {}}
        onClose={() => setView('home')}
        onReonboard={() => setView('onboarding')}
        onToggleTheme={toggleTheme}
        theme={theme}
      />
    );
  } else if (view === 'comingSoon') {
    body = <ComingSoonScreen onClose={() => setView('home')} />;
  }

  // Hide sidebar during loading + initial onboarding (no user yet)
  const showSidebar = !!user && view !== 'loading';

  return (
    <StageScaler>
      <AppWindow
        title="Sei"
        titleSubtitle={titleSubtitle}
        sidebar={showSidebar ? sidebar : <div style={{ width: 0 }} />}
      >
        {body}
        {view === 'loading' && window.LoadingScreen && <window.LoadingScreen />}
        {summonToast && (
          <SummonToast
            character={summonToast}
            onClose={() => setSummonToast(null)}
          />
        )}
        {lanModalOpen && (
          <window.LanModal
            connected={connected}
            onMarkConnected={() => setConnected(c => !c)}
            onClose={() => setLanModalOpen(false)}
          />
        )}
      </AppWindow>

      {/* Tweaks */}
      {window.TweaksPanel && (
        <window.TweaksPanel title="Tweaks">
          <window.TweakSection label="Appearance">
            <window.TweakRadio
              label="Theme"
              value={tweaks.themeMode}
              onChange={(v) => setTweak('themeMode', v)}
              options={['light', 'dark', 'system']}
            />
            <window.TweakColor
              label="Accent"
              value={tweaks.accent}
              onChange={(v) => setTweak('accent', v)}
              options={theme === 'dark'
                ? [null, '#7AA9ED', '#94BBF2', '#A8C8F5', '#F4C2AA']
                : [null, '#F4C2AA', '#E5A382', '#7AA9ED', '#C96442']}
            />
          </window.TweakSection>
          <window.TweakSection label="Home">

          </window.TweakSection>
          <window.TweakSection label="Demo">
            <window.TweakButton
              label="Toggle LAN connection"
              onClick={() => setConnected(c => !c)}
            />
            <window.TweakButton
              label="Show loading screen"
              onClick={() => {
                setView('loading');
                setTimeout(() => setView(user ? 'home' : 'onboarding'), 1600);
              }}
            />
            <window.TweakButton
              label="Reset all data"
              onClick={() => {
                setUser(null);
                setCharacters([SUI]);
                setView('onboarding');
              }}
            />
            <window.TweakButton
              label="Jump to home"
              onClick={() => {
                if (!user) setUser({ mcUsername: 'ender_42', preferredName: 'Maya', provider: 'anthropic', apiKey: 'sk-ant-demo' });
                setView('home');
              }}
            />
          </window.TweakSection>
        </window.TweaksPanel>
      )}
    </StageScaler>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
