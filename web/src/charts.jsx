import React, { useState, useId } from 'react';
import { Icon } from './kit.jsx';

/* Chart conventions used throughout PIE
   - One axis. Never two y-scales.
   - Sequential single hue for magnitude; the validated 3-slot categorical set
     (blue / orange / aqua) only where series identity matters, capped at 3.
   - Identity is never colour-alone: every series is direct-labelled and legended.
   - Text wears ink tokens, never the series colour.
   - Recessive grid, thin marks, 4px rounded data-ends, 2px gaps between fills. */

export const f2 = n => (n == null ? '—' : Number(n).toFixed(2));
export const pc = n => (n == null ? '—' : `${Math.round(n * 100)}%`);
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];

/* --------------------------------------------------------------- tooltip */
function Floating({ x, y, children }) {
  if (x == null) return null;
  return (
    <div role="tooltip" style={{
      position: 'absolute', left: x, top: y, transform: 'translate(-50%,-118%)',
      background: 'var(--surface-inv)', color: 'var(--ink-inv)', fontSize: 11,
      padding: '7px 10px', borderRadius: 6, pointerEvents: 'none', zIndex: 40,
      boxShadow: 'var(--sh-lg)', whiteSpace: 'nowrap', lineHeight: 1.45,
    }}>{children}</div>
  );
}

/* ====================================================== SKILL RADAR (1 series) */
export function SkillRadar({ dimensions, size = 320 }) {
  const [hover, setHover] = useState(null);
  const axes = [
    ['technical', 'Technical'], ['learning', 'Learning'], ['problemSolving', 'Problem solving'],
    ['consistency', 'Consistency'], ['communication', 'Communication'],
  ];
  const cx = size / 2, cy = size / 2, R = size * 0.285;
  const pt = (i, r) => {
    const a = (Math.PI * 2 * i) / axes.length - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const vals = axes.map(([k]) => dimensions[k]);
  const poly = vals.map((d, i) => pt(i, R * Math.max(0.05, d?.value ?? 0)).join(',')).join(' ');

  return (
    <div style={{ position: 'relative' }}>
      {/* Extra horizontal room in the viewBox so long axis labels never clip. */}
      <svg width="100%" viewBox={`-58 -6 ${size + 116} ${size + 12}`}
        style={{ maxWidth: size + 116, margin: '0 auto' }}
        role="img" aria-label={`Capability radar. ${axes.map(([k, l]) => `${l} ${dimensions[k]?.value == null ? 'insufficient data' : dimensions[k].value}`).join(', ')}.`}>
        {[0.25, 0.5, 0.75, 1].map(r => (
          <polygon key={r} points={axes.map((_, i) => pt(i, R * r).join(',')).join(' ')}
            fill="none" stroke="var(--line-1)" strokeWidth="1" />
        ))}
        {axes.map((_, i) => {
          const [x, y] = pt(i, R);
          return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line-1)" strokeWidth="1" />;
        })}
        <text x={cx + 3} y={cy - R * 0.5 + 3} fontSize="9" fill="var(--ink-4)">0.50</text>
        <text x={cx + 3} y={cy - R + 3} fontSize="9" fill="var(--ink-4)">1.00</text>

        <polygon points={poly} fill="var(--series-1)" fillOpacity="0.14"
          stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" />

        {vals.map((d, i) => {
          const [x, y] = pt(i, R * Math.max(0.05, d?.value ?? 0));
          const insuf = d?.tier === 'Insufficient Data';
          return (
            <g key={i}>
              <circle cx={x} cy={y} r="9" fill="transparent" style={{ cursor: 'pointer' }}
                onMouseEnter={e => setHover({ i, x: e.currentTarget.getBoundingClientRect().left })}
                onMouseLeave={() => setHover(null)} />
              <circle cx={x} cy={y} r="4.5" fill={insuf ? 'var(--warn-solid)' : 'var(--series-1)'}
                stroke="var(--surface-chart)" strokeWidth="2" />
              {insuf && <text x={x} y={y - 9} fontSize="9" textAnchor="middle" fill="var(--warn-fg)" fontWeight="700">?</text>}
            </g>
          );
        })}

        {axes.map(([k, label], i) => {
          const [x, y] = pt(i, R + 24);
          const anchor = Math.abs(x - cx) < 8 ? 'middle' : x < cx ? 'end' : 'start';
          const d = dimensions[k];
          return (
            <g key={k}>
              <text x={x} y={y - 2} textAnchor={anchor} fontSize="10.5" fill="var(--ink-3)" fontWeight="600">{label}</text>
              <text x={x} y={y + 11} textAnchor={anchor} fontSize="11.5" fontWeight="700"
                fill={d?.value == null ? 'var(--warn-fg)' : 'var(--ink-1)'}>
                {d?.value == null ? 'Insufficient' : f2(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
      {hover != null && (
        <div style={{
          position: 'absolute', left: '50%', bottom: -4, transform: 'translateX(-50%)',
          background: 'var(--surface-inv)', color: 'var(--ink-inv)', fontSize: 11, padding: '7px 11px',
          borderRadius: 6, maxWidth: 300, lineHeight: 1.45, boxShadow: 'var(--sh-lg)', zIndex: 30,
        }}>
          <b>{axes[hover.i][1]}</b> — {vals[hover.i]?.tier}. {vals[hover.i]?.rationale}
        </div>
      )}
    </div>
  );
}

/* ================================================================== GAUGE */
export function Gauge({ value, label, sub, size = 150, tone = 'var(--series-1)', target }) {
  const r = size / 2 - 13, c = 2 * Math.PI * r;
  return (
    <figure style={{ margin: 0, textAlign: 'center' }}>
      <svg width={size} height={size} role="img"
        aria-label={`${label}: ${f2(value)} out of 1.00${target ? `, target ${target}` : ''}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth="10" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="10"
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (value ?? 0))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: 'stroke-dashoffset var(--dur-4) var(--ease)' }} />
        <text x="50%" y="49%" textAnchor="middle" fontSize={size * 0.2} fontWeight="700"
          fill="var(--ink-1)" style={{ fontVariantNumeric: 'tabular-nums' }}>{f2(value)}</text>
        <text x="50%" y="64%" textAnchor="middle" fontSize="10" fill="var(--ink-3)" fontWeight="600">{pc(value)}</text>
      </svg>
      <figcaption>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 2 }}>{sub}</div>}
      </figcaption>
    </figure>
  );
}

/* ========================================== BAR LIST (magnitude, 1 series) */
export function BarList({ items, showValue = true, max = 1, emptyLabel = 'No data' }) {
  const [hov, setHov] = useState(null);
  if (!items.length) return <div className="muted t-13">{emptyLabel}</div>;
  return (
    <div style={{ position: 'relative' }}>
      {items.map((it, i) => (
        <div key={it.key ?? i}
          style={{ display: 'grid', gridTemplateColumns: '1fr 46px', gap: 12, alignItems: 'center', padding: '7px 0' }}
          onMouseMove={e => setHov({ i, x: e.clientX, y: e.clientY })}
          onMouseLeave={() => setHov(null)}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 5 }}>
              <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--ink-1)' }}>{it.label}</span>
              {it.meta && <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{it.meta}</span>}
            </div>
            <div style={{ height: 8, background: 'var(--surface-3)', borderRadius: 99, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${Math.max(1.5, (it.value / max) * 100)}%`,
                background: it.tone || 'var(--seq-4)', borderRadius: 99,
                transition: 'width var(--dur-4) var(--ease)',
              }} />
            </div>
          </div>
          {showValue && (
            <span className="tnum" style={{ fontSize: 12.5, fontWeight: 700, textAlign: 'right', color: 'var(--ink-1)' }}>
              {it.display ?? f2(it.value)}
            </span>
          )}
        </div>
      ))}
      {hov && items[hov.i]?.tip && (
        <div style={{ position: 'fixed', left: hov.x, top: hov.y - 12, transform: 'translate(-50%,-100%)',
          background: 'var(--surface-inv)', color: 'var(--ink-inv)', fontSize: 11, padding: '7px 10px',
          borderRadius: 6, pointerEvents: 'none', zIndex: 60, maxWidth: 280, lineHeight: 1.45,
          boxShadow: 'var(--sh-lg)' }}>{items[hov.i].tip}</div>
      )}
    </div>
  );
}

/* ================ CANDIDATE COMPARISON (<= 3 series, legend + direct labels)
   The validated 3-slot palette. Light-mode aqua sits under 3:1 on the light
   surface, so every series carries a visible direct label (the relief rule). */
export function CompareBars({ rows, names, max = 1 }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }} role="list" aria-label="Legend">
        {names.map((n, i) => (
          <span key={n} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12 }}>
            <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 3, background: SERIES[i], flex: 'none' }} />
            <span style={{ color: 'var(--ink-2)', fontWeight: 500 }}>{n}</span>
          </span>
        ))}
      </div>
      <div className="cmp">
        {rows.map(r => (
          <div className="cmp__row" key={r.label}>
            <div className="cmp__label">{r.label}</div>
            <div className="cmp__bars">
              {r.values.map((v, i) => (
                <div className="cmp__bar" key={i}>
                  <span className="cmp__name">{names[i]}</span>
                  <div style={{ flex: 1, height: 7, background: 'var(--surface-3)', borderRadius: 99, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.max(1.5, (v / max) * 100)}%`,
                      background: SERIES[i], borderRadius: 99, transition: 'width var(--dur-4) var(--ease)' }} />
                  </div>
                  <span className="tnum" style={{ fontSize: 11.5, fontWeight: 700, width: 34, textAlign: 'right', color: 'var(--ink-1)' }}>
                    {f2(v)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================== TRAJECTORY (change over time, 1 series) */
export function Trajectory({ points, height = 150, label = 'Match score' }) {
  const [hov, setHov] = useState(null);
  const id = useId();
  if (points.length < 2) return null;
  const W = 520, H = height, padL = 34, padR = 16, padT = 14, padB = 26;
  const xs = i => padL + (i * (W - padL - padR)) / (points.length - 1);
  const ys = v => padT + (1 - v) * (H - padT - padB);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i)},${ys(p.value)}`).join(' ');
  const area = `${path} L${xs(points.length - 1)},${ys(0)} L${xs(0)},${ys(0)} Z`;

  return (
    <div style={{ position: 'relative' }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${label} over time: ${points.map(p => `${p.label} ${f2(p.value)}`).join(', ')}`}>
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity="0.20" />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map(g => (
          <g key={g}>
            <line x1={padL} y1={ys(g)} x2={W - padR} y2={ys(g)} stroke="var(--line-1)" strokeWidth="1" />
            <text x={padL - 6} y={ys(g) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--ink-4)">{g.toFixed(1)}</text>
          </g>
        ))}
        <path d={area} fill={`url(#g${id})`} />
        <path d={path} fill="none" stroke="var(--series-1)" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={xs(i)} cy={ys(p.value)} r="4.5" fill="var(--series-1)"
              stroke="var(--surface-chart)" strokeWidth="2" />
            <circle cx={xs(i)} cy={ys(p.value)} r="14" fill="transparent" style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)} />
            <text x={xs(i)} y={ys(p.value) - 12} textAnchor="middle" fontSize="11" fontWeight="700"
              fill="var(--ink-1)">{f2(p.value)}</text>
            <text x={xs(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--ink-3)">{p.label}</text>
          </g>
        ))}
      </svg>
      {hov != null && points[hov].note && (
        <Floating x={`${(xs(hov) / W) * 100}%`} y={ys(points[hov].value) - 4}>{points[hov].note}</Floating>
      )}
    </div>
  );
}

/* ====================================================== COVERAGE / FUNNEL */
export function Funnel({ stages }) {
  const top = stages[0]?.value || 1;
  return (
    <div>
      {stages.map((s, i) => (
        <div key={s.label} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5, fontSize: 12 }}>
            <span style={{ fontWeight: 500, color: 'var(--ink-1)' }}>{s.label}</span>
            <span className="tnum" style={{ color: 'var(--ink-2)', fontWeight: 600 }}>
              {s.value}{i > 0 && <span style={{ color: 'var(--ink-4)', fontWeight: 500 }}> · {Math.round((s.value / top) * 100)}%</span>}
            </span>
          </div>
          <div style={{ height: 22, background: 'var(--surface-3)', borderRadius: 5, overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${(s.value / top) * 100}%`,
              background: `var(--seq-${Math.max(1, 5 - i)})`, borderRadius: 5,
              transition: 'width var(--dur-4) var(--ease)',
            }} />
          </div>
          {s.note && <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 4 }}>{s.note}</div>}
        </div>
      ))}
    </div>
  );
}

/* =========================================== EVIDENCE MIX (composition) */
export function EvidenceMix({ bySource }) {
  const entries = Object.entries(bySource);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  return (
    <div>
      <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', gap: 2, marginBottom: 12 }}
        role="img" aria-label={`Evidence mix: ${entries.map(([k, v]) => `${k} ${v}`).join(', ')}`}>
        {entries.map(([k, v], i) => (
          <div key={k} style={{ width: `${(v / total) * 100}%`, background: `var(--seq-${Math.min(5, 5 - (i % 4))})` }} />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
        {entries.map(([k, v], i) => (
          <span key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5 }}>
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 2,
              background: `var(--seq-${Math.min(5, 5 - (i % 4))})` }} />
            <span style={{ color: 'var(--ink-2)', textTransform: 'capitalize' }}>{k}</span>
            <b className="tnum" style={{ color: 'var(--ink-1)' }}>{v}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ================================================= TIMER RING (assessment) */
export function TimerRing({ remaining, total, size = 46 }) {
  const r = size / 2 - 4, c = 2 * Math.PI * r;
  const frac = total ? Math.max(0, remaining / total) : 0;
  const tone = frac > 0.5 ? 'var(--ok-solid)' : frac > 0.2 ? 'var(--warn-solid)' : 'var(--crit-solid)';
  return (
    <svg width={size} height={size} className="timer__ring" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth="4" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth="4"
        strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
        style={{ transition: 'stroke-dashoffset 250ms linear, stroke 300ms' }} />
    </svg>
  );
}
