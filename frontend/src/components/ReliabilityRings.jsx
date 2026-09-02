import { motion } from 'motion/react';

const RING_STROKE = 14;

function Ring({ metric, size, index }) {
  const radius = (size - RING_STROKE) / 2;
  const circumference = radius * 2 * Math.PI;
  const pct = Math.min(100, (metric.value / metric.target) * 100);
  const progress = ((100 - pct) / 100) * circumference;
  const gradientId = `ring-gradient-${metric.label}`;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: 'rotate(-90deg)' }}>
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={metric.color} />
            <stop offset="100%" stopColor={metric.colorLight} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(15,27,45,0.08)" strokeWidth={RING_STROKE} />
        <motion.circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={RING_STROKE}
          strokeDasharray={circumference}
          strokeLinecap="round"
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: progress }}
          transition={{ duration: 1.4, delay: index * 0.15, ease: [0.22, 0.61, 0.36, 1] }}
          style={{ filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.12))' }}
        />
      </svg>
    </div>
  );
}

export default function ReliabilityRings({ saidi, saifi, caidi, maifi }) {
  const metrics = [
    { label: 'SAIDI', value: saidi.value, target: saidi.target, unit: 'min', color: '#0e9f8e', colorLight: '#5fd9c9', size: 168 },
    { label: 'SAIFI', value: saifi.value, target: saifi.target, unit: '', color: '#2f6fed', colorLight: '#7ea6f7', size: 128 },
    { label: 'CAIDI', value: caidi.value, target: caidi.target, unit: 'min', color: '#c8811a', colorLight: '#f0b967', size: 88 },
  ];

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
      <div style={{ position: 'relative', width: 168, height: 168, flexShrink: 0 }}>
        {metrics.map((m, i) => <Ring key={m.label} metric={m} size={m.size} index={i} />)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {metrics.map((m, i) => (
          <motion.div
            key={m.label}
            initial={{ opacity: 0, x: 14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.5, delay: 0.3 + i * 0.1 }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>
              {m.label}
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, color: m.color }}>
              {m.value}{m.unit && ` ${m.unit}`}
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--muted)', marginLeft: 4 }}>
                / {m.target}{m.unit && ` ${m.unit}`} target
              </span>
            </div>
          </motion.div>
        ))}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6 }} style={{ fontSize: 12, color: 'var(--muted)' }}>
          MAIFI <b style={{ color: 'var(--ink)' }}>{maifi.value}</b>
        </motion.div>
      </div>
    </div>
  );
}