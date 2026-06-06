// UI primitives — window chrome, sidebar, buttons, cards, sprites.

const { useState, useEffect, useRef, useMemo } = React;

// ──────────────────────────────────────────────────────────
// Traffic lights — non-functional decorative chrome
// ──────────────────────────────────────────────────────────
function TrafficLights() {
  const dot = (bg) => (
    <div style={{
      width: 12, height: 12, borderRadius: '50%', background: bg,
      border: '0.5px solid rgba(0,0,0,0.18)',
    }} />
  );
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      {dot('#FF5F57')}
      {dot('#FEBC2E')}
      {dot('#28C840')}
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Sei wordmark — 8-bit
// ──────────────────────────────────────────────────────────
function SeiLogo({ size = 18, color }) {
  return (
    <span style={{
      fontFamily: 'var(--pixel)',
      fontSize: size,
      letterSpacing: 1,
      color: color || 'var(--text)',
      lineHeight: 1,
      display: 'inline-block',
    }}>Sei</span>
  );
}

// ──────────────────────────────────────────────────────────
// Sei pixel mark — recolored via CSS mask of the PNG
// ──────────────────────────────────────────────────────────
function SeiPixelMark({ width, height, color = 'var(--accent)' }) {
  // 309 × 100 source — derive missing dimension to preserve aspect.
  const ratio = 100 / 309;
  const w = width != null ? width : (height != null ? height / ratio : 240);
  const h = height != null ? height : w * ratio;
  return (
    <div style={{
      width: w, height: h,
      display: 'block',
      background: color,
      WebkitMaskImage: 'url(assets/sei-logo.png)',
      maskImage: 'url(assets/sei-logo.png)',
      WebkitMaskSize: 'contain',
      maskSize: 'contain',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      WebkitMaskPosition: 'center',
      maskPosition: 'center',
      imageRendering: 'pixelated',
    }} />
  );
}

// ──────────────────────────────────────────────────────────
// Loading screen — full window, recolored Sei mark on bg
// ──────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'var(--window)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: 28,
      zIndex: 80,
    }}>
      <div style={{
        animation: 'seiPulse 1600ms ease-in-out infinite',
      }}>
        <SeiPixelMark width={220} color="var(--accent)" />
      </div>
      <div style={{
        display: 'flex', gap: 6,
      }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{
            width: 6, height: 6,
            background: 'var(--accent)',
            opacity: 0.4,
            animation: `seiDot 1100ms ease-in-out ${i * 160}ms infinite`,
          }} />
        ))}
      </div>
      <style>{`
        @keyframes seiPulse {
          0%, 100% { opacity: 0.85; transform: scale(1); }
          50%      { opacity: 1;    transform: scale(1.02); }
        }
        @keyframes seiDot {
          0%, 100% { opacity: 0.25; transform: translateY(0); }
          50%      { opacity: 1;    transform: translateY(-3px); }
        }
      `}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Sidebar icon button
// ──────────────────────────────────────────────────────────
function RailButton({ active, onClick, title, children, badge }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        position: 'relative',
        width: 56, height: 56,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'transparent',
        border: 'none',
        borderRadius: 0,
        cursor: 'pointer',
        color: hover && !active ? 'var(--accent)' : 'var(--text)',
        transition: 'color 160ms ease',
        padding: 0,
      }}
    >
      {active && (
        <div style={{
          position: 'absolute', left: 0, top: 8, bottom: 8,
          width: 3,
          background: 'var(--accent)',
        }} />
      )}
      {children}
      {badge && (
        <div style={{
          position: 'absolute', top: 4, right: 4,
          width: 7, height: 7, borderRadius: '50%',
          background: 'var(--accent)',
          border: '1.5px solid var(--rail)',
        }} />
      )}
    </button>
  );
}

// ──────────────────────────────────────────────────────────
// Generic block icons
// ──────────────────────────────────────────────────────────
const HomeIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 11l9-7 9 7" />
    <path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9" />
  </svg>
);

const PlusIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const SettingsIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

const ArrowIcon = ({ size = 16, dir = 'right' }) => {
  const rot = { right: 0, left: 180, up: -90, down: 90 }[dir];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: `rotate(${rot}deg)` }}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
};

const PlayIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7 5v14l12-7L7 5z" />
  </svg>
);

const SparkleIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8L12 2z" />
    <path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14z" opacity="0.7" />
  </svg>
);

const SunIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
  </svg>
);
const MoonIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
);

const BackIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

// ──────────────────────────────────────────────────────────
// Generic pixel "block" icon — abstract grass-style cube
// (Original abstraction; not the Minecraft logo/wordmark.)
// ──────────────────────────────────────────────────────────
function MCBlock({ size = 30 }) {
  // 8x8 pixel grass-like cube isometric face
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges">
      {/* dirt body */}
      <rect x="2" y="5" width="12" height="9" fill="#8B6A3D" />
      {/* grass top band */}
      <rect x="2" y="3" width="12" height="3" fill="#6FA858" />
      {/* grass speckles */}
      <rect x="3" y="2" width="2" height="1" fill="#6FA858" />
      <rect x="7" y="2" width="2" height="1" fill="#6FA858" />
      <rect x="11" y="2" width="2" height="1" fill="#6FA858" />
      <rect x="4" y="4" width="1" height="1" fill="#85C26B" />
      <rect x="9" y="4" width="1" height="1" fill="#85C26B" />
      {/* dirt speckles */}
      <rect x="4" y="7" width="1" height="1" fill="#6F542F" />
      <rect x="9" y="9" width="1" height="1" fill="#6F542F" />
      <rect x="11" y="11" width="1" height="1" fill="#6F542F" />
      <rect x="6" y="11" width="1" height="1" fill="#A37D4D" />
      {/* outline */}
      <rect x="2" y="2" width="12" height="1" fill="none" />
    </svg>
  );
}

// ──────────────────────────────────────────────────────────
// Sidebar
// ──────────────────────────────────────────────────────────
function Sidebar({ view, onView, onOpenSettings, onAddGame, theme, onToggleTheme }) {
  return (
    <div style={{
      width: 72,
      background: 'var(--rail)',
      borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center',
      padding: '14px 0 10px',
      flexShrink: 0,
    }}>
      {/* Top: home */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <RailButton
          active={view === 'home' || view === 'character' || view === 'add'}
          onClick={() => onView('home')}
          title="Home"
        >
          <HomeIcon size={30} />
        </RailButton>
      </div>

      {/* Divider */}
      <div style={{
        height: 1, width: 44, background: 'var(--border)',
        margin: '8px 0',
      }} />

      {/* Games */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <RailButton
          active={true}
          title="Minecraft"
          onClick={() => {}}
        >
          <MCBlock size={34} />
        </RailButton>
        <RailButton
          title="Add game"
          onClick={onAddGame}
        >
          <span style={{ color: 'var(--muted)' }}><PlusIcon size={26} /></span>
        </RailButton>
      </div>

      <div style={{ flex: 1 }} />

      {/* Theme + Settings */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <RailButton onClick={onToggleTheme} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}>
          {theme === 'light' ? <MoonIcon size={26} /> : <SunIcon size={26} />}
        </RailButton>
        <RailButton onClick={onOpenSettings} title="Settings">
          <SettingsIcon size={28} />
        </RailButton>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Buttons
// ──────────────────────────────────────────────────────────
function Button({ children, onClick, kind = 'primary', size = 'md', icon, disabled, style = {}, fullWidth }) {
  const [hover, setHover] = useState(false);
  const sizeMap = {
    sm: { h: 32, px: 12, fs: 13, gap: 6, r: 0 },
    md: { h: 38, px: 16, fs: 14, gap: 8, r: 0 },
    lg: { h: 46, px: 22, fs: 15, gap: 10, r: 0 },
  };
  const s = sizeMap[size];

  const variants = {
    primary: {
      bg: hover ? 'var(--text)' : 'var(--text)',
      color: 'var(--window)',
      border: 'transparent',
      shadow: hover ? '0 4px 14px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.08)',
    },
    accent: {
      bg: hover ? 'var(--accent-strong, var(--accent))' : 'var(--accent)',
      color: 'var(--accent-text)',
      border: 'transparent',
      shadow: hover ? '0 6px 20px var(--accent-soft)' : '0 1px 2px rgba(0,0,0,0.10)',
    },
    ghost: {
      bg: hover ? 'var(--surface)' : 'transparent',
      color: 'var(--text)',
      border: 'var(--border)',
      shadow: 'none',
    },
    quiet: {
      bg: hover ? 'var(--surface)' : 'transparent',
      color: 'var(--text-2)',
      border: 'transparent',
      shadow: 'none',
    },
  };
  const v = variants[kind];

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={disabled}
      style={{
        height: s.h,
        padding: `0 ${s.px}px`,
        fontSize: s.fs,
        fontWeight: 500,
        letterSpacing: -0.1,
        gap: s.gap,
        borderRadius: s.r,
        border: `1px solid ${v.border}`,
        background: v.bg,
        color: v.color,
        boxShadow: v.shadow,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'background 140ms ease, box-shadow 160ms ease, transform 80ms ease',
        transform: hover && !disabled ? 'translateY(-0.5px)' : 'none',
        width: fullWidth ? '100%' : undefined,
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// ──────────────────────────────────────────────────────────
// Text input
// ──────────────────────────────────────────────────────────
function TextField({ value, onChange, placeholder, type = 'text', autoFocus, monospace, multiline, rows = 4, onEnter }) {
  const ref = useRef(null);
  useEffect(() => {
    if (autoFocus && ref.current) {
      const t = setTimeout(() => ref.current?.focus(), 60);
      return () => clearTimeout(t);
    }
  }, [autoFocus]);

  const baseStyle = {
    width: '100%',
    background: 'transparent',
    border: 'none',
    borderBottom: '1.5px solid var(--border-strong)',
    borderRadius: 0,
    color: 'var(--text)',
    fontSize: 16,
    fontFamily: monospace ? 'var(--mono)' : 'var(--sans)',
    padding: multiline ? '12px 0' : '0',
    height: multiline ? undefined : 48,
    outline: 'none',
    transition: 'border-color 140ms ease',
    resize: multiline ? 'vertical' : 'none',
  };

  const onFocus = (e) => {
    e.target.style.borderBottomColor = 'var(--accent)';
  };
  const onBlur = (e) => {
    e.target.style.borderBottomColor = 'var(--border-strong)';
  };
  const onKey = (e) => {
    if (!multiline && e.key === 'Enter' && onEnter) onEnter();
  };

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        style={baseStyle}
        onFocus={onFocus}
        onBlur={onBlur}
      />
    );
  }
  return (
    <input
      ref={ref}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={baseStyle}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKey}
    />
  );
}

// ──────────────────────────────────────────────────────────
// Procedural pixel-portrait — generates a deterministic
// blocky avatar from a string seed. Used for placeholders.
// ──────────────────────────────────────────────────────────
function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seedRef) {
  seedRef.s = (Math.imul(seedRef.s ^ (seedRef.s >>> 15), 2246822507) ^
               Math.imul(seedRef.s ^ (seedRef.s >>> 13), 3266489909)) >>> 0;
  return (seedRef.s >>> 0) / 4294967296;
}

function PixelPortrait({ seed, palette, size = 220, style = {} }) {
  // 12x12 grid, mirrored horizontally for symmetry
  const cells = useMemo(() => {
    const ref = { s: hashSeed(seed) || 1 };
    const W = 12, H = 12;
    const cols = [];
    const half = Math.ceil(W / 2);
    const skyTop = 2, bodyStart = 7;
    const palLen = palette.length;
    for (let y = 0; y < H; y++) {
      const row = [];
      for (let x = 0; x < half; x++) {
        let v = 0;
        if (y < skyTop || x === 0 || y === H - 1) {
          v = 0; // background
        } else if (y >= bodyStart) {
          // body
          v = rng(ref) > 0.25 ? 2 + Math.floor(rng(ref) * Math.max(1, palLen - 3)) : 0;
        } else {
          // head
          v = rng(ref) > 0.18 ? 1 + Math.floor(rng(ref) * Math.max(1, palLen - 2)) : 0;
        }
        row.push(v);
      }
      // mirror
      for (let x = half - 1; x >= 0; x--) row.push(row[x]);
      cols.push(row);
    }
    // eyes
    const eyeY = 4;
    cols[eyeY][3] = -1;
    cols[eyeY][W - 4] = -1;
    return cols;
  }, [seed, palette]);

  const px = size / 12;
  return (
    <div style={{
      position: 'relative',
      width: size, height: size,
      background: palette[0],
      overflow: 'hidden',
      ...style,
    }}>
      {/* sky gradient */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `linear-gradient(180deg, ${palette[0]} 0%, ${palette[1] || palette[0]} 100%)`,
      }} />
      {/* sprite */}
      <div style={{
        position: 'absolute', left: 0, top: 0,
        width: '100%', height: '100%',
        imageRendering: 'pixelated',
      }}>
        {cells.map((row, y) => row.map((v, x) => {
          if (v === 0) return null;
          const color = v === -1 ? '#0E0E0E' : palette[Math.min(v, palette.length - 1)];
          return (
            <div key={`${x}-${y}`} style={{
              position: 'absolute',
              left: x * px, top: y * px,
              width: px + 0.5, height: px + 0.5,
              background: color,
            }} />
          );
        }))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────
// Window chrome — full app shell
// ──────────────────────────────────────────────────────────
function AppWindow({ children, title = 'Sei', titleSubtitle, leftSlot, rightSlot, sidebar }) {
  return (
    <div style={{
      width: 1180, height: 760,
      background: 'var(--window)',
      borderRadius: 0,
      overflow: 'hidden',
      boxShadow: 'var(--shadow-window)',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
    }}>
      {/* Top bar — traffic lights at far left, title centered */}
      <div style={{
        height: 38,
        flexShrink: 0,
        display: 'flex', alignItems: 'center',
        padding: '0 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--rail)',
        gap: 14,
        position: 'relative',
      }}>
        <TrafficLights />
        <div style={{
          position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 10,
          fontSize: 13, color: 'var(--text-2)',
          letterSpacing: 0.1,
          pointerEvents: 'none',
        }}>
          {leftSlot}
          <span>{title}</span>
          {titleSubtitle && (
            <>
              <span style={{ color: 'var(--muted)' }}>·</span>
              <span style={{ color: 'var(--muted)' }}>{titleSubtitle}</span>
            </>
          )}
        </div>
        <div style={{ flex: 1 }} />
        {rightSlot}
      </div>
      {/* Body row: sidebar + content */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {sidebar}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="scroll" style={{ flex: 1, overflow: 'auto' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  TrafficLights, SeiLogo, SeiPixelMark, LoadingScreen,
  Sidebar, RailButton,
  HomeIcon, PlusIcon, SettingsIcon, ArrowIcon, PlayIcon,
  SunIcon, MoonIcon, BackIcon, MCBlock,
  Button, TextField, PixelPortrait, AppWindow, SparkleIcon,
});
