import { useEffect, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';

// Shown for a few seconds right after a successful login, before the real
// dashboard mounts (see main.jsx — it's a full root.render() swap, not a
// coexisting mount, so this component manages its own entrance/exit timing
// internally rather than relying on AnimatePresence's unmount hook).
//
// Built on Motion (https://motion.dev — the successor to Framer Motion,
// already a project dependency). Two things it does noticeably better than
// the previous hand-rolled CSS version:
//   1. The logo ring/tail use Motion's `pathLength` — a built-in SVG
//      draw-on primitive, instead of manually computing stroke-dasharray
//      offsets.
//   2. Entrances are true spring physics (mass/stiffness/damping), so they
//      settle into place instead of just easing linearly.
//
// Theme unchanged from the previous version: a transmission line silhouette
// anchors the bottom of the screen, glowing current pulses travel the
// wires (kept as native SVG <animateMotion> — Motion doesn't replicate
// arbitrary path-following as directly, and the native version already
// works well), and two small crew silhouettes are actually working the
// tower rather than just standing there.
export default function Splash({ onDone, minDurationMs = 2600 }) {
  const [leaving, setLeaving] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const leaveTimer = setTimeout(() => setLeaving(true), minDurationMs);
    const doneTimer = setTimeout(() => onDone && onDone(), minDurationMs + 420);
    return () => { clearTimeout(leaveTimer); clearTimeout(doneTimer); };
  }, [minDurationMs, onDone]);

  // Every animation below is written as "final resting state" first —
  // under reduced motion we skip straight there with a near-zero-duration
  // transition instead of disabling rendering altogether, so the screen
  // still reads correctly for anyone with the OS-level preference set,
  // just without any of the motion.
  const t = (real) => (reduceMotion ? { duration: 0.01 } : real);

  return (
    <motion.div
      role="status"
      aria-live="polite"
      aria-label="Loading OMS-UPCL"
      initial={{ opacity: 1 }}
      animate={{ opacity: leaving ? 0 : 1, scale: leaving ? 1.02 : 1 }}
      transition={t({ duration: 0.4, ease: 'easeInOut' })}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14,
        background: 'radial-gradient(120% 120% at 50% 20%, #22456e 0%, #173355 55%, #0f1b2d 100%)',
        overflow: 'hidden',
      }}
    >
      {/* faint animated grid backdrop, masked to a soft vignette */}
      <motion.div
        aria-hidden="true"
        initial={{ backgroundPosition: '0px 0px, 0px 0px' }}
        animate={{ backgroundPosition: reduceMotion ? '0px 0px, 0px 0px' : ['0px 0px, 0px 0px', '40px 40px, 40px 40px'] }}
        transition={t({ duration: 12, repeat: Infinity, ease: 'linear' })}
        style={{
          position: 'absolute', inset: -1,
          backgroundImage:
            'linear-gradient(rgba(14,159,142,0.14) 1px, transparent 1px), linear-gradient(90deg, rgba(14,159,142,0.14) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
          WebkitMaskImage: 'radial-gradient(70% 70% at 50% 45%, #000 0%, transparent 75%)',
          maskImage: 'radial-gradient(70% 70% at 50% 45%, #000 0%, transparent 75%)',
        }}
      />

      {/* one brief power-surge flash — echoes a breaker closing / power coming online */}
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: reduceMotion ? 0 : [0, 0, 1, 0, 0] }}
        transition={t({ duration: minDurationMs / 1000, times: [0, 0.4, 0.46, 0.6, 1], ease: 'easeOut' })}
        style={{
          position: 'absolute', inset: 0,
          background: 'radial-gradient(60% 50% at 50% 88%, rgba(62,230,200,0.22), transparent 70%)',
        }}
      />

      {/* ---- transmission line scene ---- */}
      <svg
        aria-hidden="true"
        viewBox="0 0 900 260"
        preserveAspectRatio="xMidYMax slice"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%', height: '42%', opacity: 0.9 }}
      >
        <defs>
          <filter id="pulseGlow" x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <path id="wireA" d="M90,95 Q270,145 450,100" fill="none" stroke="#2e4562" strokeWidth="2" />
        <path id="wireB" d="M450,100 Q630,150 810,95" fill="none" stroke="#2e4562" strokeWidth="2" />
        <path id="wireA2" d="M90,110 Q270,158 450,115" fill="none" stroke="#2e4562" strokeWidth="2" />
        <path id="wireB2" d="M450,115 Q630,163 810,110" fill="none" stroke="#2e4562" strokeWidth="2" />

        <g fill="none" stroke="#41597a" strokeWidth="3" strokeLinejoin="round">
          <path d="M90,95 L60,255 M90,95 L120,255 M70,160 L110,160 M75,200 L105,200 M40,95 L140,95 M55,80 L125,80" />
          <path d="M450,60 L410,255 M450,60 L490,255 M420,140 L480,140 M425,190 L475,190 M400,60 L500,60 M415,42 L485,42" />
          <path d="M810,95 L780,255 M810,95 L840,255 M790,160 L830,160 M795,200 L825,200 M760,95 L860,95 M775,80 L845,80" />
        </g>

        {/* current pulses — native SVG path-follow, staggered so the flow reads as constant */}
        {!reduceMotion && [
          { wire: '#wireA', dur: '2.6s', delay: '0s' },
          { wire: '#wireA', dur: '2.6s', delay: '1.3s' },
          { wire: '#wireB', dur: '2.6s', delay: '0.4s' },
          { wire: '#wireB', dur: '2.6s', delay: '1.7s' },
          { wire: '#wireA2', dur: '3.1s', delay: '0.8s' },
          { wire: '#wireB2', dur: '3.1s', delay: '2.1s' },
        ].map((p, i) => (
          <circle key={i} r="3" fill="#3ee6c8" filter="url(#pulseGlow)">
            <animateMotion dur={p.dur} begin={p.delay} repeatCount="indefinite">
              <mpath href={p.wire} />
            </animateMotion>
          </circle>
        ))}

        {/* ladder for the climbing crew member */}
        <path d="M96,255 L124,178" stroke="#41597a" strokeWidth="2" strokeDasharray="1 6" strokeLinecap="round" />

        {/* lineman — standing on the tower's lower crossbar, working arm animated via Motion */}
        <g transform="translate(433,140) scale(0.42)">
          <path d="M-5,-8 Q0,-15 5,-8 L5,-5 L-5,-5 Z" fill="#050a12" />
          <circle cx="0" cy="-2" r="5.5" fill="#050a12" />
          <path d="M0,4 L-2,28" stroke="#050a12" strokeWidth="5" strokeLinecap="round" />
          <path d="M-2,28 L-13,50 M-2,28 L9,49" stroke="#050a12" strokeWidth="5" strokeLinecap="round" />
          <path d="M0,10 L-14,2" stroke="#050a12" strokeWidth="5" strokeLinecap="round" />
          <motion.g
            style={{ transformOrigin: '0px 10px' }}
            animate={{ rotate: reduceMotion ? -12 : [-12, 14, -12] }}
            transition={t({ duration: 0.9, repeat: Infinity, ease: 'easeInOut' })}
          >
            <path d="M0,10 L17,15 L21,4" stroke="#050a12" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </motion.g>
        </g>

        {/* climber — on the ladder, legs stepping via Motion, alternating phase */}
        <g transform="translate(112,214) scale(0.4)">
          <path d="M-5,-8 Q0,-15 5,-8 L5,-5 L-5,-5 Z" fill="#050a12" />
          <circle cx="0" cy="-2" r="5.5" fill="#050a12" />
          <path d="M0,4 L0,25" stroke="#050a12" strokeWidth="5" strokeLinecap="round" />
          <path d="M0,10 L-13,17 M0,10 L14,7" stroke="#050a12" strokeWidth="5" strokeLinecap="round" />
          <motion.g
            style={{ transformOrigin: '0px 25px' }}
            animate={{ rotate: reduceMotion ? -8 : [-8, 10, -8] }}
            transition={t({ duration: 0.76, repeat: Infinity, ease: 'easeInOut' })}
          >
            <path d="M0,25 L-11,36" stroke="#050a12" strokeWidth="5" strokeLinecap="round" fill="none" />
          </motion.g>
          <motion.g
            style={{ transformOrigin: '0px 25px' }}
            animate={{ rotate: reduceMotion ? 10 : [10, -8, 10] }}
            transition={t({ duration: 0.76, repeat: Infinity, ease: 'easeInOut' })}
          >
            <path d="M0,25 L10,36" stroke="#050a12" strokeWidth="5" strokeLinecap="round" fill="none" />
          </motion.g>
        </g>

        <g transform="translate(755,208)" fill="none" stroke="#41597a" strokeWidth="2.4" strokeLinejoin="round">
          <path d="M0,32 L0,12 L34,12 L44,24 L44,32 Z" />
          <line x1="20" y1="12" x2="20" y2="32" />
          <circle cx="10" cy="32" r="5" fill="#0f1b2d" />
          <circle cx="36" cy="32" r="5" fill="#0f1b2d" />
        </g>
      </svg>

      {/* ---- logo mark: ring + tail drawn on via Motion's pathLength ---- */}
      <motion.div style={{ position: 'relative', zIndex: 1, filter: 'drop-shadow(0 8px 24px rgba(14,159,142,0.35))' }}>
        <svg width="96" height="96" viewBox="0 0 256 256">
          <defs>
            <linearGradient id="splashGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#0e9f8e" />
              <stop offset="1" stopColor="#0b7d70" />
            </linearGradient>
          </defs>
          <motion.rect
            width="256" height="256" rx="52" fill="url(#splashGrad)"
            initial={{ scale: 0.7, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={reduceMotion ? { duration: 0.01 } : { type: 'spring', stiffness: 260, damping: 20 }}
            style={{ transformOrigin: '128px 128px' }}
          />
          <motion.circle
            cx="128" cy="128" r="60" fill="none" stroke="#ffffff" strokeWidth="24" strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={t({ duration: 0.7, delay: 0.15, ease: [0.4, 0, 0.2, 1] })}
          />
          <motion.path
            d="M148 158 L192 202" stroke="#ffffff" strokeWidth="24" strokeLinecap="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={t({ duration: 0.26, delay: 0.82, ease: 'easeOut' })}
          />
        </svg>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={t({ duration: 0.48, delay: 1.05, ease: 'easeOut' })}
        style={{ position: 'relative', zIndex: 1, fontFamily: "'Space Grotesk', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: '#fff', letterSpacing: 0.3 }}
      >
        GridQ
      </motion.div>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={t({ duration: 0.48, delay: 1.25, ease: 'easeOut' })}
        style={{ position: 'relative', zIndex: 1, fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13, color: '#9fb0c4' }}
      >
        Outage Management System · UPCL
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={t({ duration: 0.4, delay: 1.5 })}
        style={{ position: 'absolute', bottom: 64, zIndex: 1, display: 'flex', alignItems: 'center', gap: 8 }}
      >
        {[0, 0.16, 0.32].map((delay, i) => (
          <motion.span
            key={i}
            animate={{ opacity: reduceMotion ? 1 : [0.3, 1, 0.3], scale: reduceMotion ? 1 : [0.8, 1.15, 0.8] }}
            transition={t({ duration: 1.2, repeat: Infinity, delay, ease: 'easeInOut' })}
            style={{ width: 6, height: 6, borderRadius: '50%', background: '#0e9f8e', display: 'inline-block' }}
          />
        ))}
        <span style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 12, color: '#8296ab', marginLeft: 4 }}>
          Energizing the grid
        </span>
      </motion.div>
    </motion.div>
  );
}