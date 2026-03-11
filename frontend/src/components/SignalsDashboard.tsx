import React, { useRef, useEffect } from 'react';

// ---------------------------------------------------------------------------
// Types (must match Signal dataclass from signal_detector.py)
// ---------------------------------------------------------------------------

export interface Signal {
  id: string;
  name: string;
  direction: 'LONG' | 'SHORT' | 'CAUTION' | 'EXIT';
  strength: 1 | 2 | 3;
  message: string;
  timestamp: number; // epoch seconds
}

interface Props {
  signals: Signal[];
}

// ---------------------------------------------------------------------------
// Direction config
// ---------------------------------------------------------------------------

const DIR_CONFIG: Record<string, { color: string; bg: string; icon: string; label: string }> = {
  LONG:    { color: '#00d084', bg: 'rgba(0,208,132,0.08)',  icon: '▲', label: 'LONG'   },
  SHORT:   { color: '#ff4757', bg: 'rgba(255,71,87,0.08)',  icon: '▼', label: 'SHORT'  },
  CAUTION: { color: '#ffa502', bg: 'rgba(255,165,2,0.08)', icon: '⚠', label: 'ATENÇÃO'},
  EXIT:    { color: '#a0a0ff', bg: 'rgba(160,160,255,0.08)',icon: '✕', label: 'SAIR'   },
};

const SIGNAL_META: Record<string, { emoji: string; desc: string }> = {
  DELTA_DIV:      { emoji: '⟳', desc: 'Divergência Delta' },
  WALL_CONSUMED:  { emoji: '◈', desc: 'Wall Consumido'    },
  WALL_RESPECTED: { emoji: '◉', desc: 'Wall Respeitado'   },
  LIQ_CLUSTER:    { emoji: '⚡', desc: 'Cluster Liquidação' },
  SPREAD_ALERT:   { emoji: '↔', desc: 'Spread Anômalo'    },
};

function stars(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(3 - n);
}

function timeAgo(epochSec: number): string {
  const diff = Math.floor(Date.now() / 1000 - epochSec);
  if (diff < 60) return `${diff}s atrás`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m atrás`;
  return `${Math.floor(diff / 3600)}h atrás`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SignalsDashboard: React.FC<Props> = ({ signals }) => {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll para o topo quando chega novo sinal
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [signals.length]);

  // Mais recente primeiro
  const sorted = [...signals].reverse();
  const now = Date.now() / 1000;

  if (sorted.length === 0) {
    return (
      <div className="signals-empty">
        <div className="signals-empty-icon">◎</div>
        <div>Monitorando mercado...</div>
        <div className="signals-empty-sub">
          Sinais aparecem quando detectadas divergências,<br />
          walls suspeitos ou clusters de liquidação.
        </div>
      </div>
    );
  }

  return (
    <div className="signals-wrap">
      {/* Summary bar */}
      <div className="signals-summary">
        {(['LONG', 'SHORT', 'CAUTION', 'EXIT'] as const).map(dir => {
          const count = signals.filter(s => s.direction === dir).length;
          const cfg = DIR_CONFIG[dir];
          return count > 0 ? (
            <div key={dir} className="sig-sum-badge" style={{ color: cfg.color, borderColor: cfg.color }}>
              {cfg.icon} {dir} <strong>{count}</strong>
            </div>
          ) : null;
        })}
        <div className="sig-sum-total">{sorted.length} total</div>
      </div>

      {/* Signal cards */}
      <div className="signals-list" ref={listRef}>
        {sorted.map((sig, i) => {
          const cfg = DIR_CONFIG[sig.direction] ?? DIR_CONFIG.CAUTION;
          const meta = SIGNAL_META[sig.id] ?? { emoji: '●', desc: sig.name };
          const isNew = now - sig.timestamp < 5;
          const isVeryNew = now - sig.timestamp < 2;

          return (
            <div
              key={`${sig.id}-${sig.timestamp}-${i}`}
              className={`signal-card ${isNew ? 'signal-new' : ''} ${isVeryNew ? 'signal-flash' : ''}`}
              style={{ borderColor: cfg.color, background: cfg.bg }}
            >
              {/* Header */}
              <div className="signal-header">
                <div className="signal-title">
                  <span className="signal-emoji">{meta.emoji}</span>
                  <span className="signal-name" style={{ color: cfg.color }}>
                    {meta.desc}
                  </span>
                  {isNew && (
                    <span className="signal-new-badge" style={{ background: cfg.color }}>
                      NOVO
                    </span>
                  )}
                </div>

                <div className="signal-right">
                  <span className="signal-dir" style={{ color: cfg.color }}>
                    {cfg.icon} {cfg.label}
                  </span>
                  <span className="signal-stars" style={{ color: cfg.color }}>
                    {stars(sig.strength)}
  </span>
                </div>
              </div>

              {/* Message */}
              <div className="signal-msg">{sig.message}</div>

              {/* Footer */}
              <div className="signal-footer">
                <span className="signal-time">{timeAgo(sig.timestamp)}</span>
                <span className="signal-strength-label">
                  Força: {sig.strength === 3 ? 'Alta' : sig.strength === 2 ? 'Média' : 'Baixa'}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SignalsDashboard;
