import { useRef } from 'react';
import { Icon, useDialog } from '../lib/ui.jsx';
import { useT, t as tr, tOr } from '../lib/i18n.js';

// Full-screen "About" page opened from the GridQ mark in the rail. Plain
// fixed-position overlay (no router in this app) styled with the same
// design tokens as the rest of the shell — see index.css :root block.
export default function AboutOverlay({ onClose }) {
  useT();
  const dlg = useRef(null);
  useDialog(dlg, onClose);

  return (
    // Backdrop mousedown is mouse-only; keyboard users close via Escape (useDialog).
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={dlg}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={tr('app.about')}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 2200,
        background: 'rgba(9,18,32,.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 620, maxHeight: '86vh', overflowY: 'auto',
        background: 'var(--surface)', borderRadius: 18, boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--line)',
      }}>
        <div style={{
          background: 'linear-gradient(120deg,#16b7a2 0%,#0b9f8f 28%,#174b68 68%,#102f4a 100%)',
          borderRadius: '18px 18px 0 0', padding: '22px 26px', display: 'flex',
          alignItems: 'center', gap: 14, position: 'relative',
        }}>
          <span className="gq-mark" aria-hidden="true" style={{ width: 48, height: 48, color: '#fff' }} />
          <div>
            <div style={{ fontFamily: 'var(--disp)', color: '#fff', fontWeight: 700, fontSize: 19 }}>GridQ</div>
            <div style={{ color: 'rgba(255,255,255,.85)', fontSize: 12.5, letterSpacing: '.02em' }}>Predict. Prevent. Power.</div>
          </div>
          <button
            onClick={onClose}
            aria-label={tr('inc.close')}
            style={{
              position: 'absolute', top: 16, right: 16, width: 30, height: 30, borderRadius: 8,
              border: '1px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.12)',
              color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div style={{ padding: '22px 26px 26px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Section title={tr('about.software')}>
            <Row k={tr('about.name')} v={tr('about.nameV')} />
            <Row k={tr('about.version')} v="1.0.0" />
            <Row k={tr('about.build')} v="2026.07.1.0" />
            <Row k={tr('about.deployDate')} v="" />
            
          </Section>

          
          <Section title={tr('about.license')}>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              {tr('about.licenseText')}
            </p>
          </Section>

          <Section title={tr('about.company')}>
            <Row k={tr('about.oem')} v="Sharika SpinTech Pvt. Ltd." />
            <Row k={tr('about.partner')} v="Sharika Enterprises Limited" />
            
          </Section>

          <Section title={tr('about.client')}>
            <Row k={tr('about.endClient')} v={tr('about.endClientV')} />
            <Row k={tr('about.scheme')} v={tr('about.schemeV')} />
            <Row k={tr('about.nodal')} v={tr('about.nodalV')} />
            <Row k={tr('about.town')} v={tr('about.townV')} />

          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--disp)', textTransform: 'uppercase', letterSpacing: '.12em',
        fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 9,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{children}</div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 13 }}>
      <div style={{ width: 170, flex: 'none', color: 'var(--muted)' }}>{k}</div>
      <div style={{ color: 'var(--ink)', fontWeight: 500 }}>{v}</div>
    </div>
  );
}