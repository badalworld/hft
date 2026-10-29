import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Hardware-console LED readout. Segments are drawn rather than typeset because a
 * real seven-segment display cannot render a decimal point, a dollar sign, or a
 * digit that is mid-roll — and this one rolls.
 */

const GH = 112;
const TH = 14;
const H = TH / 2;
const X0 = 10;
const X1 = 48;
const Y_TOP = 7;
const Y_MID = 56;
const Y_BOT = 105;
/** Ink bounds, so the column carries no dead margin and the readout can sit tight. */
const VW = 54;
const VH = 114;
const VIEWBOX = `${X0 - H - 1} ${Y_TOP - H - 1} ${VW} ${VH}`;

const horiz = (yc: number) =>
  `${X0},${yc} ${X0 + H},${yc - H} ${X1 - H},${yc - H} ${X1},${yc} ${X1 - H},${yc + H} ${X0 + H},${yc + H}`;
// 1px chamfer at each joint: without the gap the segments fuse and '1' reads as a bar.
const vert = (xc: number, ya: number, yb: number) =>
  `${xc},${ya + 1} ${xc + H},${ya + H + 1} ${xc + H},${yb - H - 1} ${xc},${yb - 1} ${xc - H},${yb - H - 1} ${xc - H},${ya + H + 1}`;

const SEGMENTS: Record<string, string> = {
  a: horiz(Y_TOP),
  b: vert(X1, Y_TOP + H, Y_MID - H),
  c: vert(X1, Y_MID + H, Y_BOT - H),
  d: horiz(Y_BOT),
  e: vert(X0, Y_MID + H, Y_BOT - H),
  f: vert(X0, Y_TOP + H, Y_MID - H),
  g: horiz(Y_MID),
};

const ALL_SEGMENT_IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

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

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** The odometer strip repeats the decade so a roll can take the short way round. */
const STRIP = [...DIGITS, ...DIGITS, ...DIGITS];
const STRIP_BAND = 10;

/** Rendered once per screen; every readout references these glyphs by id. */
export const SegmentDefs: React.FC = () => (
  <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
    <defs>
      {Object.keys(DIGIT_SEGMENTS).map((ch) => (
        <g key={ch} id={`hft-seg-${ch}`}>
          {DIGIT_SEGMENTS[ch].map((s) => (
            <polygon key={s} points={SEGMENTS[s]} fill="currentColor" />
          ))}
        </g>
      ))}
      <g id="hft-seg-ghost">
        {ALL_SEGMENT_IDS.map((s) => (
          <polygon key={s} points={SEGMENTS[s]} fill="currentColor" />
        ))}
      </g>
    </defs>
  </svg>
);

interface DigitStripProps {
  digit: string;
  px: number;
  reduceMotion: boolean;
}

const ROLL_TRANSITION = { type: 'spring', stiffness: 220, damping: 30, mass: 0.6 } as const;

/**
 * One column of the odometer. The target digit is reached through whichever copy of the decade
 * is nearest, so 9→0 rolls one place instead of rewinding through eight; once it settles the
 * position is normalised into the middle copy with an instant jump that cannot be seen, because
 * all three copies are identical.
 */
const DigitStrip: React.FC<DigitStripProps> = ({ digit, px, reduceMotion }) => {
  const target = digit >= '0' && digit <= '9' ? Number(digit) : 8;
  const posRef = useRef(STRIP_BAND + target);
  const [pos, setPos] = useState(STRIP_BAND + target);
  const [settleJump, setSettleJump] = useState(false);

  useEffect(() => {
    const current = posRef.current;
    let best = current;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of [target, target + 10, target + 20]) {
      const distance = Math.abs(candidate - current);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    if (best === current) return;
    posRef.current = best;
    setSettleJump(false);
    setPos(best);
  }, [target]);

  const onSettled = () => {
    const current = posRef.current;
    if (current >= STRIP_BAND && current < STRIP_BAND * 2) return;
    const normalised = STRIP_BAND + ((current % 10) + 10) % 10;
    posRef.current = normalised;
    setSettleJump(true);
    setPos(normalised);
  };

  const offset = -(pos * GH);

  return (
    <svg
      viewBox={VIEWBOX}
      width={(px * VW) / VH}
      height={px}
      style={{ display: 'block', overflow: 'hidden' }}
      aria-hidden="true"
    >
      <use href="#hft-seg-ghost" opacity={0.075} />
      {reduceMotion ? (
        <use href={`#hft-seg-${DIGITS[((pos % 10) + 10) % 10]}`} />
      ) : (
        <motion.g
          initial={false}
          animate={{ y: offset }}
          transition={settleJump ? { duration: 0 } : ROLL_TRANSITION}
          onAnimationComplete={onSettled}
        >
          {STRIP.map((ch, i) => (
            <use key={`${ch}-${i}`} href={`#hft-seg-${ch}`} y={i * GH} />
          ))}
        </motion.g>
      )}
    </svg>
  );
};

/** A minus sign never rolls: it is either in the column or it is not. */
const StaticGlyph: React.FC<{ ch: string; px: number }> = ({ ch, px }) => (
  <svg
    viewBox={VIEWBOX}
    width={(px * VW) / VH}
    height={px}
    style={{ display: 'block', overflow: 'hidden' }}
    aria-hidden="true"
  >
    <use href="#hft-seg-ghost" opacity={0.075} />
    <use href={`#hft-seg${DIGIT_SEGMENTS[ch] ? `-${ch}` : '-8'}`} />
  </svg>
);

/** Half a column wide, so the point does not punch a hole in the readout. */
const DotGlyph: React.FC<{ px: number }> = ({ px }) => (
  <svg
    viewBox={`0 0 ${VW / 2} ${VH}`}
    width={(px * VW) / VH / 2}
    height={px}
    style={{ display: 'block', overflow: 'hidden' }}
    aria-hidden="true"
  >
    <rect x={VW / 4 - 7} y={VH - 20} width={14} height={11} rx={2.5} fill="currentColor" />
  </svg>
);

/**
 * Sized to sit in the line box the plain text used, so neither card reflows:
 * a seven-segment glyph reads at roughly the cap height of the type it replaced.
 */
export function useConsoleGlyphHeight(): number {
  const query = '(min-width: 640px)';
  const read = () => (typeof window !== 'undefined' && window.matchMedia(query).matches ? 26 : 22);
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
  /** Already-formatted value, e.g. `$13.97`. `$` renders as a label, not a glyph. */
  value: string;
  tone?: keyof typeof TONES;
  /** Cap height in px; the whole readout is scaled from this. */
  heightPx?: number;
  className?: string;
  /** Announced to screen readers in place of the glyphs. */
  label: string;
}

const TONES = {
  mint: '#ADEBB3',
  coral: '#FF857A',
  orchid: '#EBAEE6',
  cream: '#fdf6f5',
} as const;

export const SevenSegmentNumber: React.FC<SevenSegmentNumberProps> = ({
  value,
  tone = 'cream',
  heightPx = 26,
  className = '',
  label,
}) => {
  const reduceMotion = useReducedMotion() ?? false;
  const color = TONES[tone];

  // fmtUsd6 emits `-$` for an outflow, so the sign belongs ahead of the currency glyph.
  const hasCurrency = value.includes('$');
  const isNegative = value.trimStart().startsWith('-');
  const chars = value.split('$').join('').replace(/^-/, '').split('');

  return (
    <div
      className={`flex items-end gap-px ${className}`}
      style={{
        color,
        filter: `drop-shadow(0 0 ${(heightPx * 0.04).toFixed(1)}px ${color}) drop-shadow(0 0 ${(
          heightPx * 0.22
        ).toFixed(1)}px ${color}55)`,
      }}
      role="img"
      aria-label={label}
    >
      {isNegative && <StaticGlyph ch="-" px={heightPx} />}
      {hasCurrency && (
        <span
          className="font-mono-num font-bold leading-none"
          style={{ fontSize: heightPx * 0.58, marginBottom: heightPx * 0.05 }}
          aria-hidden="true"
        >
          $
        </span>
      )}
      {chars.map((ch, i) =>
        ch === '.' ? (
          <DotGlyph key={`${i}-${ch}`} px={heightPx} />
        ) : DIGIT_SEGMENTS[ch] && ch !== '-' ? (
          <DigitStrip key={i} digit={ch} px={heightPx} reduceMotion={!!reduceMotion} />
        ) : (
          <StaticGlyph key={`${i}-${ch}`} ch={ch} px={heightPx} />
        )
      )}
    </div>
  );
};

export default SevenSegmentNumber;
