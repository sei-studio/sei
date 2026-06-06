// Screens — onboarding, home, add character, character page, settings.

const { useState: useStateS, useEffect: useEffectS } = React;

// ─── Step indicator (dots) ──────────────────────────────
function StepDots({ count, current }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          width: i === current ? 22 : 6,
          height: 6,
          borderRadius: 0,
          background: i === current ? 'var(--accent)' : (i < current ? 'var(--text-2)' : 'var(--border-strong)'),
          transition: 'all 240ms ease',
        }} />
      ))}
    </div>
  );
}

// ─── One-question shell ─────────────────────────────────
function QuestionShell({ stepIdx, totalSteps, eyebrow, title, hint, children, onBack, onNext, nextLabel = 'Continue', nextDisabled, canBack = true, onSkip, accent = false, centered = false }) {
  return (
    <div className="fade" style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'var(--window)',
    }}>
      {/* progress bar */}
      <div style={{
        padding: '24px 56px 0',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {canBack ? (
            <Button kind="quiet" size="sm" icon={<BackIcon />} onClick={onBack}>Back</Button>
          ) : <div style={{ width: 70 }} />}
        </div>
        <StepDots count={totalSteps} current={stepIdx} />
        <div style={{ width: 70, display: 'flex', justifyContent: 'flex-end' }}>
          {onSkip && <Button kind="quiet" size="sm" onClick={onSkip}>Skip</Button>}
        </div>
      </div>

      {/* content */}
      <div style={{
        flex: 1,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '0 56px',
      }}>
        <div className="fade-up" key={stepIdx} style={{ width: '100%', maxWidth: 520, textAlign: centered ? 'center' : 'left' }}>
          {eyebrow && (
            <div style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              letterSpacing: 1.4,
              textTransform: 'uppercase',
              color: 'var(--muted)',
              marginBottom: 14,
            }}>{eyebrow}</div>
          )}
          <h1 style={{
            fontSize: 30,
            fontWeight: 600,
            letterSpacing: -0.6,
            lineHeight: 1.15,
            margin: '0 0 12px',
            color: 'var(--text)',
          }}>{title}</h1>
          {hint && (
            <p style={{
              fontSize: 15,
              lineHeight: 1.5,
              color: 'var(--text-2)',
              margin: '0 0 28px',
            }}>{hint}</p>
          )}
          <div style={{ marginTop: 8 }}>{children}</div>
        </div>
      </div>

      {/* footer */}
      <div style={{
        padding: '0 56px 32px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
      }}>
        <Button kind={accent ? 'accent' : 'primary'} size="lg" onClick={onNext} disabled={nextDisabled}
                icon={<ArrowIcon size={14} dir="right" />}>
          <span style={{ marginRight: 4 }}>{nextLabel}</span>
        </Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// ONBOARDING
// ────────────────────────────────────────────────────────
function OnboardingScreen({ initial, onDone, onCancel, isReonboard }) {
  const [step, setStep] = useStateS(0);
  const [data, setData] = useStateS({
    mcUsername: initial?.mcUsername || '',
    preferredName: initial?.preferredName || '',
    provider: initial?.provider || 'anthropic',
    apiKey: initial?.apiKey || '',
  });

  const TOTAL = 5;

  const next = () => setStep(s => Math.min(s + 1, TOTAL));
  const back = () => {
    if (step === 0) { onCancel?.(); return; }
    setStep(s => Math.max(0, s - 1));
  };

  const providers = [
    { id: 'anthropic', label: 'Anthropic', tag: 'Claude', accent: '#C96442' },
    { id: 'openai', label: 'OpenAI', tag: 'GPT-4o, o-series', accent: '#10A37F' },
    { id: 'google', label: 'Google', tag: 'Gemini', accent: '#4285F4' },
    { id: 'local', label: 'Local', tag: 'Ollama / LM Studio', accent: '#6E6E6E' },
  ];

  // Step 0: welcome
  if (step === 0) {
    return (
      <QuestionShell
        stepIdx={0} totalSteps={TOTAL}
        canBack={!!isReonboard}
        onBack={back}
        onNext={next}
        nextLabel="Begin"
        accent
        centered
        title={
          <span style={{
            display: 'inline-flex',
            alignItems: 'baseline',
            gap: 12,
          }}>
            <span>Welcome to</span>
            {/* image baseline = its bottom edge, matching letter baseline of text.
                height tuned to cap-height of 30px h1 (~22px) for matching letter height. */}
            <window.SeiPixelMark height={22} color="var(--accent)" />
            <span>.</span>
          </span>
        }
      />
    );
  }

  // Step 1: MC username
  if (step === 1) {
    return (
      <QuestionShell
        stepIdx={1} totalSteps={TOTAL}
        title="What's your Minecraft username?"
        onBack={back} onNext={next}
        nextDisabled={!data.mcUsername.trim()}
      >
        <TextField
          autoFocus
          value={data.mcUsername}
          onChange={(v) => setData(d => ({ ...d, mcUsername: v }))}
          placeholder=""
          monospace
          onEnter={() => data.mcUsername.trim() && next()}
        />
      </QuestionShell>
    );
  }

  // Step 2: Preferred name
  if (step === 2) {
    return (
      <QuestionShell
        stepIdx={2} totalSteps={TOTAL}
        title="What should they call you?"
        onBack={back} onNext={next}
        nextDisabled={!data.preferredName.trim()}
      >
        <TextField
          autoFocus
          value={data.preferredName}
          onChange={(v) => setData(d => ({ ...d, preferredName: v }))}
          placeholder=""
          onEnter={() => data.preferredName.trim() && next()}
        />
      </QuestionShell>
    );
  }

  // Step 3: provider
  if (step === 3) {
    return (
      <QuestionShell
        stepIdx={3} totalSteps={TOTAL}
        title="Which model provider?"
        onBack={back} onNext={next}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {providers.map(p => {
            const selected = data.provider === p.id;
            return (
              <button key={p.id}
                onClick={() => setData(d => ({ ...d, provider: p.id }))}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: selected ? 'var(--accent-soft)' : 'var(--surface-2)',
                  borderRadius: 0,
                  cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 12,
                  transition: 'all 140ms ease',
                }}
              >
                <div style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: p.accent,
                  flexShrink: 0,
                }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{p.label}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>{p.tag}</div>
                </div>
              </button>
            );
          })}
        </div>
      </QuestionShell>
    );
  }

  // Step 4: API key
  if (step === 4) {
    const provLabel = providers.find(p => p.id === data.provider)?.label || '';
    return (
      <QuestionShell
        stepIdx={4} totalSteps={TOTAL}
        title={`Paste your ${provLabel} API key.`}
        onBack={back}
        onNext={() => onDone(data)}
        nextLabel="Finish"
        nextDisabled={data.provider !== 'local' && !data.apiKey.trim()}
        accent
      >
        <TextField
          autoFocus
          type={data.provider === 'local' ? 'text' : 'password'}
          value={data.apiKey}
          onChange={(v) => setData(d => ({ ...d, apiKey: v }))}
          placeholder={data.provider === 'local' ? 'http://localhost:11434' : 'sk-ant-...'}
          monospace
          onEnter={() => (data.provider === 'local' || data.apiKey.trim()) && onDone(data)}
        />
      </QuestionShell>
    );
  }

  return null;
}

// ────────────────────────────────────────────────────────
// HOME — character grid
// ────────────────────────────────────────────────────────
function CharacterCard({ character, onOpen, onSummon }) {
  const [hover, setHover] = useStateS(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(character.id)}
      style={{
        position: 'relative',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 0,
        overflow: 'hidden',
        cursor: 'pointer',
        boxShadow: hover ? 'var(--shadow-pop)' : 'var(--shadow-card)',
        transform: hover ? 'translateY(-2px)' : 'none',
        transition: 'all 200ms cubic-bezier(.2,.7,.2,1)',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ position: 'relative', aspectRatio: '1 / 1', overflow: 'hidden' }}>
        <PixelPortrait
          seed={character.id + character.name}
          palette={character.palette}
          size={260}
          style={{ width: '100%', height: '100%' }}
        />
        {/* gradient overlay for name */}
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.55) 100%)',
        }} />
        {/* status chip */}
        <div style={{
          position: 'absolute', top: 10, left: 10,
          background: 'rgba(0,0,0,0.55)',
          color: '#FFF',
          fontSize: 10,
          fontFamily: 'var(--mono)',
          textTransform: 'uppercase',
          letterSpacing: 1.2,
          padding: '4px 8px',
          borderRadius: 0,
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: character.id === 'sui' ? '#7DD66E' : '#A8A8A8' }} />
          {character.id === 'sui' ? 'Default' : 'Custom'}
        </div>
        {/* hover summon overlay */}
        <div style={{
          position: 'absolute', inset: 0,
          background: hover ? 'rgba(0,0,0,0.20)' : 'transparent',
          transition: 'background 180ms ease',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {hover && (
            <div className="fade">
              <Button
                kind="accent"
                size="md"
                icon={<SparkleIcon size={12} />}
                onClick={(e) => { e.stopPropagation(); onSummon(character.id); }}
              >
                Summon
              </Button>
            </div>
          )}
        </div>
        {/* name on portrait */}
        <div style={{
          position: 'absolute', bottom: 10, left: 12, right: 12,
          fontFamily: 'var(--pixel)', fontSize: 14,
          color: '#FFF',
          textShadow: '0 2px 8px rgba(0,0,0,0.6)',
          letterSpacing: 1,
        }}>{character.name}</div>
      </div>
      <div style={{
        padding: '12px 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{
            fontSize: 13, fontWeight: 500, color: 'var(--text)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{character.name}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>
            {character.lastLaunched ? `Last: ${character.lastLaunched}` : 'Never summoned'}
          </div>
        </div>
        <ArrowIcon size={14} dir="right" />
      </div>
    </div>
  );
}

function AddCard({ onClick }) {
  const [hover, setHover] = useStateS(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        borderRadius: 0,
        border: `2px dashed ${hover ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: hover ? 'var(--accent-soft)' : 'transparent',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer',
        transition: 'all 180ms ease',
        minHeight: 0,
        color: hover ? 'var(--accent)' : 'var(--muted)',
        padding: 20,
      }}
    >
      <div style={{
        width: 56, height: 56, borderRadius: 0,
        background: hover ? 'var(--accent)' : 'var(--surface)',
        color: hover ? 'var(--accent-text)' : 'var(--text-2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 16,
        transition: 'all 180ms ease',
      }}>
        <PlusIcon size={26} />
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: hover ? 'var(--accent)' : 'var(--text)' }}>
        New character
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
        Build a fresh persona
      </div>
    </div>
  );
}

function HomeScreen({ characters, onOpenCharacter, onAdd, onSummon, mcUsername, connected, onOpenLan }) {
  return (
    <div className="fade" style={{ padding: '32px 40px 56px' }}>
      {/* header */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        marginBottom: 28,
      }}>
        <h1 style={{
          margin: 0,
          fontSize: 32,
          fontWeight: 600,
          letterSpacing: -0.6,
        }}>Characters</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={onOpenLan}
            style={{
              fontSize: 12, color: 'var(--text-2)',
              display: 'flex', alignItems: 'center', gap: 8,
              background: 'var(--surface)',
              padding: '6px 12px',
              borderRadius: 0,
              border: '1px solid var(--border)',
              cursor: 'pointer',
              fontFamily: 'var(--mono)',
              textTransform: 'uppercase',
              letterSpacing: 1.2,
            }}
          >
            <div style={{ width: 7, height: 7, background: connected ? 'var(--green)' : 'var(--red)' }} />
            <span>{connected ? 'Connected' : 'Not connected'}</span>
          </button>
          <Button kind="ghost" size="sm" icon={<PlusIcon size={14} />} onClick={onAdd}>New</Button>
        </div>
      </div>

      {/* grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        gap: 18,
      }}>
        {characters.map(c => (
          <CharacterCard
            key={c.id}
            character={c}
            onOpen={onOpenCharacter}
            onSummon={onSummon}
          />
        ))}
        <AddCard onClick={onAdd} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// ADD CHARACTER
// ────────────────────────────────────────────────────────
function AddCharacterScreen({ onDone, onCancel }) {
  const [step, setStep] = useStateS(0);
  const [data, setData] = useStateS({ name: '', description: '', prompt: '' });
  const TOTAL = 3;

  const back = () => {
    if (step === 0) { onCancel(); return; }
    setStep(s => Math.max(0, s - 1));
  };

  if (step === 0) {
    return (
      <QuestionShell
        stepIdx={0} totalSteps={TOTAL}
        title="Name your character."
        onBack={back}
        onNext={() => setStep(1)}
        nextDisabled={!data.name.trim()}
      >
        <TextField
          autoFocus
          value={data.name}
          onChange={(v) => setData(d => ({ ...d, name: v }))}
          placeholder=""
          onEnter={() => data.name.trim() && setStep(1)}
        />
      </QuestionShell>
    );
  }

  if (step === 1) {
    return (
      <QuestionShell
        stepIdx={1} totalSteps={TOTAL}
        eyebrow="Shown to you"
        title="Describe them."
        hint="A short bio that appears on this character's page. Just for you — purely flavour."
        onBack={back}
        onNext={() => setStep(2)}
        nextDisabled={!data.description.trim()}
      >
        <TextField
          autoFocus
          multiline
          rows={5}
          value={data.description}
          onChange={(v) => setData(d => ({ ...d, description: v }))}
          placeholder=""
        />
      </QuestionShell>
    );
  }

  return (
    <QuestionShell
      stepIdx={2} totalSteps={TOTAL}
      eyebrow="Sent to the model"
      title="Write the persona prompt."
      hint="The system instruction the language model receives. Speak to the model directly."
      onBack={back}
      onNext={() => onDone(data)}
      nextDisabled={!data.prompt.trim()}
      nextLabel="Create"
      accent
    >
      <TextField
        autoFocus
        multiline
        rows={7}
        monospace
        value={data.prompt}
        onChange={(v) => setData(d => ({ ...d, prompt: v }))}
        placeholder=""
      />
    </QuestionShell>
  );
}

// ────────────────────────────────────────────────────────
// CHARACTER PAGE
// ────────────────────────────────────────────────────────
function CharacterPage({ character, onBack, onSummon, onEdit, onDelete }) {
  const [showPrompt, setShowPrompt] = useStateS(false);
  return (
    <div className="fade" style={{ padding: '24px 40px 40px' }}>
      {/* breadcrumb */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24,
      }}>
        <Button kind="quiet" size="sm" icon={<BackIcon />} onClick={onBack}>
          All characters
        </Button>
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gap: 36,
        alignItems: 'start',
      }}>
        {/* portrait + summon */}
        <div>
          <div style={{
            borderRadius: 0,
            overflow: 'hidden',
            border: '1px solid var(--border)',
            boxShadow: 'var(--shadow-card)',
          }}>
            <PixelPortrait
              seed={character.id + character.name}
              palette={character.palette}
              size={320}
              style={{ width: '100%', height: 320 }}
            />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
            <Button
              kind="accent" size="lg" fullWidth
              icon={<SparkleIcon size={14} />}
              onClick={() => onSummon(character.id)}
            >
              Summon into Minecraft
            </Button>
            <div style={{ display: 'flex', gap: 10 }}>
              <Button kind="ghost" size="md" onClick={onEdit} style={{ flex: 1 }}>
                Edit persona
              </Button>
              {character.id !== 'sui' && (
                <Button kind="ghost" size="md" onClick={onDelete} style={{ flex: 1, color: 'var(--red)' }}>
                  Delete
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* details */}
        <div>
          <div style={{
            fontFamily: 'var(--mono)', fontSize: 11,
            color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1.4,
            marginBottom: 10,
          }}>{character.id === 'sui' ? 'Default' : 'Custom'}</div>
          <h1 style={{
            margin: '0 0 6px',
            fontFamily: 'var(--pixel)',
            fontSize: 30,
            color: 'var(--text)',
            letterSpacing: 1,
            lineHeight: 1.2,
          }}>{character.name}</h1>
          <div style={{ height: 24 }} />

          {/* description card */}
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 0,
            padding: '20px 22px',
            marginBottom: 14,
          }}>
            <div style={{
              fontSize: 11, fontFamily: 'var(--mono)',
              color: 'var(--muted)', letterSpacing: 1.4, textTransform: 'uppercase',
              marginBottom: 10,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <span>Description</span>
              <span style={{ color: 'var(--muted)', textTransform: 'none', letterSpacing: 0.4, fontSize: 10 }}>For you</span>
            </div>
            <p style={{
              margin: 0,
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--text)',
              whiteSpace: 'pre-wrap',
            }}>{character.description}</p>
          </div>

          {/* persona prompt card — model-facing, hidden by default */}
          {character.prompt && (
            <div style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderLeft: showPrompt ? '2px solid var(--accent)' : '1px solid var(--border)',
              borderRadius: 0,
              padding: '14px 18px 16px',
              marginBottom: 18,
            }}>
              <div style={{
                fontSize: 11, fontFamily: 'var(--mono)',
                color: 'var(--muted)', letterSpacing: 1.4, textTransform: 'uppercase',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12,
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span>Persona prompt</span>
                  <span style={{ color: 'var(--muted)', textTransform: 'none', letterSpacing: 0.4, fontSize: 10 }}>
                    {showPrompt ? `Sent to ${character.model}` : 'Hidden'}
                  </span>
                </span>
                <button
                  onClick={() => setShowPrompt(s => !s)}
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    fontFamily: 'var(--mono)', fontSize: 11, letterSpacing: 1.2,
                    color: 'var(--accent)', textTransform: 'uppercase',
                    padding: 0,
                  }}
                >{showPrompt ? 'Hide' : 'Show'}</button>
              </div>
              {showPrompt && (
                <p className="fade" style={{
                  margin: '12px 0 0',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  lineHeight: 1.55,
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-wrap',
                }}>{character.prompt}</p>
              )}
            </div>
          )}

          {/* play info grid */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12,
            marginBottom: 18,
          }}>
            {[
              ['Last launched', character.lastLaunched || '—'],
              ['Total playtime', character.playtime || '—'],
              ['Created', character.created],
            ].map(([k, v]) => (
              <div key={k} style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 0,
                padding: '14px 16px',
              }}>
                <div style={{
                  fontSize: 11, color: 'var(--muted)',
                  fontFamily: 'var(--mono)',
                  textTransform: 'uppercase', letterSpacing: 1.3,
                  marginBottom: 6,
                }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 500, color: 'var(--text)' }}>{v}</div>
              </div>
            ))}
          </div>

          {/* model row */}
          <div style={{
            display: 'flex', alignItems: 'center',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 0,
            padding: '12px 16px',
            gap: 12,
            fontSize: 13,
            color: 'var(--text-2)',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--green)',
            }} />
            <span style={{ color: 'var(--text)', fontWeight: 500 }}>Ready</span>
            <span style={{ color: 'var(--muted)' }}>·</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>{character.model}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// SETTINGS / RE-ONBOARD modal-screen
// ────────────────────────────────────────────────────────
function SettingsScreen({ user, onReonboard, onClose, onToggleTheme, theme }) {
  return (
    <div className="fade" style={{ padding: '32px 40px 40px', maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Button kind="quiet" size="sm" icon={<BackIcon />} onClick={onClose}>Back</Button>
      </div>
      <h1 style={{ margin: '0 0 28px', fontSize: 30, fontWeight: 600, letterSpacing: -0.4 }}>Settings</h1>

      <Section title="Account">
        <Row label="Minecraft username" value={user.mcUsername} mono />
        <Row label="Preferred name" value={user.preferredName} />
        <Row label="Provider" value={user.provider} />
        <Row label="API key" value={user.apiKey ? '•'.repeat(Math.min(user.apiKey.length, 24)) : '—'} mono />
      </Section>

      <Section title="Appearance">
        <div style={{
          padding: '14px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Theme</div>
          <Button kind="ghost" size="sm" onClick={onToggleTheme}
                  icon={theme === 'light' ? <MoonIcon size={14} /> : <SunIcon size={14} />}>
            {theme === 'light' ? 'Dark' : 'Light'}
          </Button>
        </div>
      </Section>

      <Section title="Setup">
        <div style={{
          padding: '14px 16px',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Re-run onboarding</div>
          <Button kind="primary" size="sm" onClick={onReonboard}>Start over</Button>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11,
        color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1.4,
        marginBottom: 10,
      }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {children}
      </div>
    </div>
  );
}
function Row({ label, value, mono }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '14px 16px',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 0,
    }}>
      <span style={{ fontSize: 14, color: 'var(--text-2)' }}>{label}</span>
      <span style={{
        fontSize: 14, color: 'var(--text)',
        fontFamily: mono ? 'var(--mono)' : 'inherit',
      }}>{value || '—'}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// "Other games" stub modal
// ────────────────────────────────────────────────────────
function ComingSoonScreen({ onClose }) {
  return (
    <div className="fade" style={{
      width: '100%', height: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div className="fade-up" style={{
        textAlign: 'center', maxWidth: 440,
        padding: 40,
      }}>
        <div style={{
          fontFamily: 'var(--pixel)', fontSize: 22,
          color: 'var(--accent)',
          letterSpacing: 1.5,
          marginBottom: 16,
        }}>Other games</div>
        <h1 style={{ margin: '0 0 12px', fontSize: 28, fontWeight: 600, letterSpacing: -0.4 }}>
          Coming soon.
        </h1>
        <Button kind="primary" size="md" onClick={onClose} style={{ marginTop: 24 }}>Back to Minecraft</Button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────
// Summon toast
// ────────────────────────────────────────────────────────
function SummonToast({ character, onClose }) {
  useEffectS(() => {
    const t = setTimeout(onClose, 4200);
    return () => clearTimeout(t);
  }, []);
  if (!character) return null;
  return (
    <div className="fade-up" style={{
      position: 'absolute', bottom: 20, right: 20,
      background: 'var(--text)',
      color: 'var(--window)',
      borderRadius: 0,
      padding: '14px 18px',
      display: 'flex', alignItems: 'center', gap: 14,
      boxShadow: 'var(--shadow-pop)',
      maxWidth: 360,
      zIndex: 50,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 0,
          overflow: 'hidden', flexShrink: 0,
        }}>
          <PixelPortrait
            seed={character.id + character.name}
            palette={character.palette}
            size={36}
            style={{ width: 36, height: 36 }}
          />
        </div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Summoning {character.name}…</div>
      </div>
    </div>
  );
}

Object.assign(window, {
  OnboardingScreen, HomeScreen, AddCharacterScreen,
  CharacterPage, SettingsScreen, ComingSoonScreen, SummonToast,
  LanModal,
  QuestionShell,
});

// ────────────────────────────────────────────────────────
// LAN INSTRUCTIONS MODAL
// ────────────────────────────────────────────────────────
function LanModal({ onClose, connected, onMarkConnected }) {
  const steps = [
    'Launch Minecraft and open your singleplayer world.',
    'Press ESC, then choose Open to LAN.',
    'Set Allow Cheats to On, then click Start LAN World.',
    'Return to Sei and press Summon.',
  ];
  return (
    <div className="fade" style={{
      position: 'absolute', inset: 0,
      background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 60,
      padding: 24,
    }} onClick={onClose}>
      <div className="fade-up" onClick={(e) => e.stopPropagation()} style={{
        width: 520,
        background: 'var(--window)',
        border: '1px solid var(--border-strong)',
        boxShadow: 'var(--shadow-pop)',
        padding: '28px 32px 24px',
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 11,
          color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 1.4,
          marginBottom: 8,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ width: 8, height: 8, background: connected ? 'var(--green)' : 'var(--red)' }} />
          <span>{connected ? 'Connected' : 'Not connected'}</span>
        </div>
        <h2 style={{
          margin: '0 0 18px',
          fontSize: 22, fontWeight: 600, letterSpacing: -0.3,
        }}>To summon a character into your world</h2>
        <ol style={{
          margin: 0, padding: 0, listStyle: 'none',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          {steps.map((t, i) => (
            <li key={i} style={{
              display: 'flex', gap: 14, alignItems: 'flex-start',
              padding: '12px 14px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              fontSize: 14, color: 'var(--text)',
            }}>
              <div style={{
                fontFamily: 'var(--pixel)', fontSize: 11,
                color: 'var(--accent)',
                width: 22, flexShrink: 0,
                marginTop: 1,
              }}>{String(i + 1).padStart(2, '0')}</div>
              <div>{t}</div>
            </li>
          ))}
        </ol>
        <div style={{
          marginTop: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <Button kind="quiet" size="sm" onClick={onMarkConnected}>
            {connected ? 'Mark as not connected' : 'I\'ve opened to LAN'}
          </Button>
          <Button kind="primary" size="md" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
