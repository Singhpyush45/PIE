import React, { useEffect, useRef, useState } from 'react';

/* ============================================================== ICONS
   One stroke system: 1.6px, round caps/joins, 24px grid. No dependency. */
const P = {
  dashboard: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  orchestr: 'M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8',
  discover: 'M11 4a7 7 0 100 14 7 7 0 000-14zM20 20l-4-4',
  market: 'M3 17l6-6 4 4 7-7M21 8V4h-4',
  match: 'M9 6l-5 6 5 6M15 6l5 6-5 6M13 3l-2 18',
  learn: 'M3 5.5A2.5 2.5 0 015.5 3H11v16H5.5A2.5 2.5 0 003 21zM21 5.5A2.5 2.5 0 0018.5 3H13v16h5.5A2.5 2.5 0 0121 21z',
  employer: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5M9 11h.01M12 11h.01M15 11h.01',
  shield: 'M12 3l8 3v5c0 5-3.4 8.9-8 10-4.6-1.1-8-5-8-10V6zM9 12l2 2 4-4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  users: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM22 21v-2a4 4 0 00-3-3.9M16 3.1a4 4 0 010 7.8',
  brief: 'M3 8h18v11a2 2 0 01-2 2H5a2 2 0 01-2-2zM8 8V5a2 2 0 012-2h4a2 2 0 012 2v3M3 13h18',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4',
  github: 'M9 19c-4 1.4-4-2.1-6-2.6m12 5v-3.4c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.3 4.3 0 00-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 00-6 0C6.8 3.3 5.8 3.6 5.8 3.6a4.3 4.3 0 00-.1 3.2A4.6 4.6 0 004.4 10c0 4.6 2.7 5.7 5.5 6-.4.4-.5.9-.5 1.5V21',
  award: 'M12 15a6 6 0 100-12 6 6 0 000 12zM8.2 13.9L7 22l5-3 5 3-1.2-8.1',
  trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  check: 'M4 12.5l5 5L20 6.5',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 3L2 20h20zM12 10v4M12 17.5h.01',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3.2 1.9',
  camera: 'M3 8a2 2 0 012-2h2l1.5-2h7L17 6h2a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2zM12 16.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z',
  mic: 'M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM19 11a7 7 0 01-14 0M12 18v3',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 016 0v3',
  right: 'M9 5l7 7-7 7',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  play: 'M6 4l13 8-13 8z',
  refresh: 'M21 12a9 9 0 11-2.6-6.4M21 3v5h-5',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M21 13A9 9 0 1111 3a7 7 0 0010 10z',
  menu: 'M3 6h18M3 12h18M3 18h18',
  target: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 17a5 5 0 100-10 5 5 0 000 10zM12 13a1 1 0 100-2 1 1 0 000 2z',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7zM12 15a3 3 0 100-6 3 3 0 000 6z',
  layers: 'M12 2l9 5-9 5-9-5zM3 12l9 5 9-5M3 17l9 5 9-5',
  book: 'M4 4h11a3 3 0 013 3v13H7a3 3 0 01-3-3zM8 8h7M8 12h7',
  gauge: 'M12 20a8 8 0 100-16 8 8 0 000 16zM12 12l4-4',
  scale: 'M12 3v18M7 7l-4 7h8zM17 7l-4 7h8zM6 21h12',
  history: 'M3 12a9 9 0 109-9 9 9 0 00-7.5 4M3 3v5h5M12 7v5l3 2',
  plug: 'M9 2v6M15 2v6M7 8h10v4a5 5 0 01-10 0zM12 17v5',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  spark2: 'M3 17l4-4 3 3 5-6 6 7',
};

export function Icon({ name, size = 16, className = '', style, strokeWidth = 1.6 }) {
  const d = P[name];
  if (!d) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className={className} style={style} stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round">
      {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

/* ============================================================== PRIMITIVES */
export const cx = (...a) => a.filter(Boolean).join(' ');

export function Button({ variant = 'secondary', size, icon, iconRight, children, className, ...p }) {
  return (
    <button className={cx('btn', `btn--${variant}`, size && `btn--${size}`, className)} {...p}>
      {icon && <Icon name={icon} size={15} />}
      {children}
      {iconRight && <Icon name={iconRight} size={15} />}
    </button>
  );
}

export function Card({ children, pad, flush, ai, className, ...p }) {
  return <div className={cx('card', pad && 'card--pad', flush && 'card--flush', ai && 'card--ai', className)} {...p}>{children}</div>;
}

export function CardHead({ eyebrow, title, sub, right, icon }) {
  return (
    <div className="card__head">
      {icon && <div className="agent__icon" style={{ marginBottom: 0 }}><Icon name={icon} size={16} /></div>}
      <div style={{ minWidth: 0, flex: 1 }}>
        {eyebrow && <div className="eyebrow" style={{ marginBottom: 3 }}>{eyebrow}</div>}
        <h3>{title}</h3>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

export function Badge({ tone = 'neutral', dot, icon, children }) {
  return (
    <span className={cx('badge', `badge--${tone}`, dot && 'badge--dot')}>
      {icon && <Icon name={icon} size={11} />}{children}
    </span>
  );
}

export const Pill = ({ children }) => <span className="pill">{children}</span>;

export function Stat({ label, value, detail, tone, hint, icon }) {
  const color = tone === 'ok' ? 'var(--ok-fg)' : tone === 'warn' ? 'var(--warn-fg)'
    : tone === 'crit' ? 'var(--crit-fg)' : tone === 'brand' ? 'var(--brand-600)'
    : tone === 'ai' ? 'var(--ai-fg)' : 'var(--ink-1)';
  return (
    <div className="stat">
      <div className="stat__label">
        {icon && <Icon name={icon} size={12} />}{label}
        {hint && <Tooltip text={hint}><span className="infodot" tabIndex={0} role="img" aria-label={hint}>i</span></Tooltip>}
      </div>
      <div className="stat__value" style={{ color }}>{value}</div>
      {detail && <div className="stat__detail">{detail}</div>}
    </div>
  );
}

export function Tooltip({ text, children }) {
  return <span className="tip">{children}<span className="tip__pop" role="tooltip">{text}</span></span>;
}

export function Alert({ tone = 'info', title, icon, children }) {
  const ic = icon || ({ info: 'info', ok: 'check', warn: 'alert', crit: 'alert', ai: 'sparkle', neutral: 'info' }[tone]);
  return (
    <div className={`alert alert--${tone}`} role={tone === 'crit' ? 'alert' : 'note'}>
      <span className="alert__icon"><Icon name={ic} size={16} /></span>
      <div style={{ minWidth: 0 }}>
        {title && <div className="alert__title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function Meter({ value, tone, target, label, height }) {
  const t = tone || (value >= 0.75 ? 'ok' : value >= 0.45 ? 'seq' : value >= 0.25 ? 'warn' : 'crit');
  return (
    <div className={cx('meter', height === 'lg' && 'meter--lg')} role="meter"
      aria-valuenow={Math.round((value || 0) * 100)} aria-valuemin={0} aria-valuemax={100}
      aria-label={label || 'progress'}>
      <div className={`meter__fill meter__fill--${t}`} style={{ width: `${Math.max(1.5, (value || 0) * 100)}%` }} />
      {target != null && <div className="meter__target" style={{ left: `${target * 100}%` }} title={`target ${target}`} />}
    </div>
  );
}

export function Tabs({ items, value, onChange, idPrefix = 'tab' }) {
  return (
    <div className="tabs" role="tablist">
      {items.map(it => (
        <button key={it.key} role="tab" id={`${idPrefix}-${it.key}`}
          aria-selected={value === it.key} aria-controls={`${idPrefix}panel-${it.key}`}
          onClick={() => onChange(it.key)}>
          {it.icon && <Icon name={it.icon} size={14} />}
          {it.label}
          {it.count > 0 && <span className={cx('count', it.danger && 'count--crit')}>{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon = 'layers', title, children, action }) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon name={icon} size={22} /></div>
      <h4>{title}</h4>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3, title = true }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {title && <div className="sk sk--title" />}
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="sk sk--text" style={{ width: `${92 - i * 11}%` }} />
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, labelledBy = 'modal-title' }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy}
        ref={ref} tabIndex={-1}>
        <div className="card__head">
          <h3 id={labelledBy} style={{ flex: 1 }}>{title}</h3>
          <Button variant="ghost" className="btn--icon" onClick={onClose} aria-label="Close dialog">
            <Icon name="x" size={16} />
          </Button>
        </div>
        <div className="card__body">{children}</div>
        {footer && <div className="card__foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------------------- AI insight: the fixed chain
   AI Insight → Evidence → Reasoning → Confidence → Recommendation.
   Every AI output in PIE wears this shape. Never unexplained magic. */
export function Insight({ title, insight, evidence, reasoning, confidence, recommendation,
  uncertainty, tone = 'ai', badge }) {
  return (
    <div className="insight">
      <div className="insight__head">
        <Icon name="sparkle" size={14} />
        <span className="t">{title}</span>
        <span className="spacer" style={{ flex: 1 }} />
        {badge}
      </div>
      {insight && <div className="insight__body" style={{ fontSize: 'var(--fs-13)', color: 'var(--ink-1)', lineHeight: 1.6 }}>{insight}</div>}
      <dl className="insight__chain">
        {evidence && <div className="insight__link"><dt>Evidence</dt><dd>{evidence}</dd></div>}
        {reasoning && <div className="insight__link"><dt>Reasoning</dt><dd>{reasoning}</dd></div>}
        {confidence != null && (
          <div className="insight__link"><dt>Confidence</dt>
            <dd style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Meter value={confidence} label="confidence" />
              <b className="tnum" style={{ color: 'var(--ink-1)' }}>{confidence.toFixed(2)}</b>
            </dd></div>
        )}
        {recommendation && <div className="insight__link"><dt>Recommendation</dt><dd>{recommendation}</dd></div>}
        {uncertainty && (
          <div className="insight__link"><dt>Uncertainty</dt>
            <dd style={{ color: 'var(--warn-fg)' }}>{uncertainty}</dd></div>
        )}
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------ misc hooks */
export function useNow(active, ms = 250) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set(n => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return Date.now();
}
