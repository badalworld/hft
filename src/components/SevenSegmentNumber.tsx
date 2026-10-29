import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';

/**
 * Console LED readout set in DSEG7 Classic (SIL OFL, self-hosted under public/fonts).
 * A real seven-segment face draws the skeleton, joints and stroke weight, so the panel
 * no longer depends on hand-placed polygons — and the odometer roll moves real glyphs.
 *
 * DSEG7's digit ink is exactly 1 em tall (typographic ascent 1000, descent 0, and the
 * face declares USE_TYPO_METRICS), so one em of type fills one odometer row and the
 * roll step is the same number as the glyph height.
 */

const DIGIT_FONT = "'DSEG7 Classic', ui-monospace, monospace";
/** Advance is 0.816 em and the ink 0.618 em; a 0.72 em column keeps LED-tight spacing. */
const COLUMN_EM = 0.72;
const DOT_EM = 0.26;
/** A hair of air above and below, so browser metric rounding cannot clip the ink. */
const INK_EM = 0.94;

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** The odometer strip repeats the decade so a roll can take the short way round. */
const STRIP = [...DIGITS, ...DIGITS, ...DIGITS];
const STRIP_BAND = 10;

const ROLL_TRANSITION = { type: 'spring', stiffness: 220, damping: 30, mass: 0.6 } as const;

const glyphRow = (px: number): React.CSSProperties => ({
  height: px,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: DIGIT_FONT,
  fontWeight: 700,
  fontSize: px * INK_EM,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
});

interface DigitStripProps {
  digit: string;
  px: number;
  reduceMotion: boolean;
}

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

  const row = glyphRow(px);

  return (
    <span
      aria-hidden="true"
      style={{
        position: 'relative',
        display: 'inline-block',
        width: px * COLUMN_EM,
        height: px,
        overflow: 'hidden',
      }}
    >
      <span style={{ ...row, position: 'absolute', top: 0, left: 0, right: 0, opacity: 0.075 }}>8</span>
      {reduceMotion ? (
        <span style={{ ...row, position: 'absolute', top: 0, left: 0, right: 0 }}>
          {DIGITS[((pos % 10) + 10) % 10]}
        </span>
      ) : (
        <motion.span
          initial={false}
          animate={{ y: -pos * px }}
          transition={settleJump ? { duration: 0 } : ROLL_TRANSITION}
          onAnimationComplete={onSettled}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'block' }}
        >
          {STRIP.map((ch, i) => (
            <span key={`${ch}-${i}`} style={row}>
              {ch}
            </span>
          ))}
        </motion.span>
      )}
    </span>
  );
};

/** A minus never rolls: it is either in the column or it is not. */
const MinusGlyph: React.FC<{ px: number }> = ({ px }) => (
  <span
    aria-hidden="true"
    style={{ position: 'relative', display: 'inline-block', width: px * COLUMN_EM, height: px }}
  >
    <span style={{ ...glyphRow(px), position: 'absolute', top: 0, left: 0, right: 0, opacity: 0.075 }}>
      8
    </span>
    <span
      style={{
        position: 'absolute',
        left: px * 0.16,
        right: px * 0.16,
        top: px * 0.46,
        height: px * 0.1,
        borderRadius: px * 0.012,
        background: 'currentColor',
      }}
    />
  </span>
);

/** Half a column wide, sitting on the LED baseline, so the point does not punch a hole. */
const DotGlyph: React.FC<{ px: number }> = ({ px }) => (
  <span
    aria-hidden="true"
    style={{ position: 'relative', display: 'inline-block', width: px * DOT_EM, height: px }}
  >
    <span
      style={{
        position: 'absolute',
        left: px * 0.045,
        right: px * 0.045,
        bottom: px * 0.07,
        height: px * 0.12,
        borderRadius: px * 0.02,
        background: 'currentColor',
      }}
    />
  </span>
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
  /** Glyph height in px; the whole readout is scaled from this. */
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

  // fmtUsd2 emits `-$` for an outflow, so the sign belongs ahead of the currency glyph.
  const hasCurrency = value.includes('$');
  const isNegative = value.trimStart().startsWith('-');
  const chars = value.split('$').join('').replace(/^-/, '').split('');

  return (
    <div
      className={`flex items-end ${className}`}
      style={{
        gap: heightPx * 0.02,
        color,
        filter: `drop-shadow(0 0 ${(heightPx * 0.04).toFixed(1)}px ${color}) drop-shadow(0 0 ${(
          heightPx * 0.22
        ).toFixed(1)}px ${color}55)`,
      }}
      role="img"
      aria-label={label}
    >
      {isNegative && <MinusGlyph px={heightPx} />}
      {hasCurrency && (
        <span
          className="font-mono-num font-bold leading-none"
          style={{ fontSize: heightPx * 0.58, marginBottom: heightPx * 0.06 }}
          aria-hidden="true"
        >
          $
        </span>
      )}
      {chars.map((ch, i) =>
        ch === '.' ? (
          <DotGlyph key={`${i}-${ch}`} px={heightPx} />
        ) : ch >= '0' && ch <= '9' ? (
          <DigitStrip key={i} digit={ch} px={heightPx} reduceMotion={!!reduceMotion} />
        ) : (
          <MinusGlyph key={`${i}-${ch}`} px={heightPx} />
        )
      )}
    </div>
  );
};

export default SevenSegmentNumber;
