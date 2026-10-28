import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Hardware-console LED readout. Segments are drawn rather than typeset because a
 * real seven-segment display cannot render a decimal comma, a dollar sign, or a
 * digit that is mid-roll — and this one rolls.
 */

const GW = 56;
const GH = 112;
const TH = 12;
const H = TH / 2;
const X0 = 8;
const X1 = 48;

const horiz = (yc: number) =>
  `${X0},${yc} ${X0 + H},${yc - H} ${X1 - H},${yc - H} ${X1},${yc} ${X1 - H},${yc + H} ${X0 + H},${yc + H}`;
const vert = (xc: number, ya: number, yb: number) =>
  `${xc},${ya} ${xc + H},${ya + H} ${xc + H},${yb - H} ${xc},${yb} ${xc - H},${yb - H} ${xc - H},${ya + H}`;

/**
 * Segment letters a–g in draw order. The stroke is deliberately thin against the
 * digit height: with a fat stroke the two right-hand segments shrink and '1' reads
 * as a colon, which is exactly how a real display with the wrong proportions lies.
 */
const SEGMENTS: Record<string, string> = {
  a: horiz(6),
  b: vert(X1, 14, 50),
  c: vert(X1, 62, 98),
  d: horiz(106),
  e: vert(X0, 62, 98),
  f: vert(X0, 14, 50),
  g: horiz(56),
};

const DIGIT_SEGMENTS: Record<string, string[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '3': ['a', 'b', 'g', 'c', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '5': ['a', 'f', 'g', 'c', 'd'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
  '-': ['g'],
};

const GLYPHS = Object.keys(DIGIT_SEGMENTS);

const TONES = {
  mint: '#ADEBB3',
  coral: '#FF857A',
  orchid: '#EBAEE6',
  cream: '#fdf6f5',
} as const;

/** Rendered once per screen; every readout references these glyphs by id. */
export const SegmentDefs: React.FC = () => (
  <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
    <defs>
      {GLYPHS.map((ch) => (
        <g key={ch} id={`hft-seg-${ch}`}>
          {DIGIT_SEGMENTS[ch].map((s) => (
            <polygon key={s} points={SEGMENTS[s]} fill="currentColor" />
          ))}
        </g>
      ))}
    </defs>
  </svg>
);

interface DigitStripProps {
  digit: string;
  px: number;
  delay: number;
  reduceMotion: boolean;
}

/** One column of the odometer: the digit strip rolls, the viewport clips it. */
const DigitStrip: React.FC<DigitStripProps> = ({ digit, px, delay, reduceMotion }) => {
  const slot = GLYPHS.indexOf(digit);
  const target = -(slot < 0 ? GLYPHS.indexOf('8') : slot) * GH;
  const strip = (
    <>
      {GLYPHS.map((ch, i) => (
        <use key={ch} href={`#hft-seg-${ch}`} y={i * GH} />
      ))}
    </>
  );

  return (
    <svg
      viewBox={`0 0 ${GW} ${GH}`}
      width={(px * GW) / GH}
      height={px}
      style={{ display: 'block', overflow: 'hidden' }}
      aria-hidden="true"
    >
      {reduceMotion ? (
        <g transform={`translate(0 ${target})`}>{strip}</g>
      ) : (
        <motion.g
          initial={false}
          animate={{ y: target }}
          transition={{ type: 'spring', stiffness: 190, damping: 26, mass: 0.7, delay }}
        >
          {strip}
        </motion.g>
      )}
    </svg>
  );
};

/** Half a column wide, so the point does not punch a hole in the readout. */
const DotGlyph: React.FC<{ px: number }> = ({ px }) => (
  <svg
    viewBox={`0 0 ${GW / 2} ${GH}`}
    width={(px * GW) / GH / 2}
    height={px}
    style={{ display: 'block', overflow: 'hidden' }}
    aria-hidden="true"
  >
    <rect x={GW / 4 - 6} y={GH - 12} width={12} height={9} rx={2} fill="currentColor" />
  </svg>
);

/**
 * Sized to sit in the line box the plain text used, so neither card reflows:
 * a seven-segment glyph reads at roughly the cap height of the type it replaced.
 */
export function useConsoleGlyphHeight(): number {
  const query = '(min-width: 640px)';
  const read = () =>
    typeof window !== 'undefined' && window.matchMedia(query).matches ? 26 : 22;
  const [px, setPx] = React.useState(read);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setPx(mq.matches ? 26 : 22);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return px;
}

interface SevenSegmentNumberProps {
  /** Already-formatted value, e.g. `$13.972454`. `$` renders as a label, not a glyph. */
  value: string;
  tone?: keyof typeof TONES;
  /** Cap height in px; the whole readout is scaled from this. */
  heightPx?: number;
  className?: string;
  /** Announced to screen readers in place of the glyphs. */
  label: string;
}

export const SevenSegmentNumber: React.FC<SevenSegmentNumberProps> = ({
  value,
  tone = 'cream',
  heightPx = 26,
  className = '',
  label,
}) => {
  const reduceMotion = useReducedMotion() ?? false;
  const color = TONES[tone];

  // fmtUsd6 emits `-$` for an outflow, so the sign can precede the currency glyph.
  const hasCurrency = value.includes('$');
  const chars = value.split('$').join('').split('');

  // Least-significant positions flicker fastest, so the roll staggers from the right.
  const last = chars.length - 1;

  return (
    <div
      className={`flex items-end gap-[3px] ${className}`}
      style={{ color, filter: `drop-shadow(0 0 ${(heightPx * 0.09).toFixed(1)}px ${color})` }}
      role="text"
      aria-label={label}
    >
      {hasCurrency && (
        <span
          className="font-mono-num font-bold leading-none"
          style={{ fontSize: heightPx * 0.62, marginBottom: heightPx * 0.06 }}
          aria-hidden="true"
        >
          $
        </span>
      )}
      {chars.map((ch, i) =>
        ch === '.' ? (
          <DotGlyph key={`${i}-${ch}`} px={heightPx} />
        ) : (
          <DigitStrip
            key={i}
            digit={ch}
            px={heightPx}
            delay={reduceMotion ? 0 : (last - i) * 0.018}
            reduceMotion={!!reduceMotion}
          />
        )
      )}
    </div>
  );
};

export default SevenSegmentNumber;
