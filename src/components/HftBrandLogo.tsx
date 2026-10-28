import React, { useId } from 'react';
import { motion } from 'framer-motion';

interface HftBrandLogoProps {
  isRunning?: boolean;
  variant?: 'header' | 'footer';
}

export const HftBrandLogo: React.FC<HftBrandLogoProps> = ({
  isRunning = false,
  variant = 'header',
}) => {
  const uid = useId().replace(/:/g, '');
  const silverGradId = `hft-silver-${uid}`;
  const candleGradId = `hft-candle-${uid}`;
  const glowFilterId = `hft-glow-${uid}`;

  if (variant === 'footer') {
    return (
      <svg
        viewBox="0 0 324 140"
        className="h-6 w-auto shrink-0 select-none"
        aria-label="HFT Automation Trading Bot Logo"
      >
        <defs>
          <linearGradient id={silverGradId} x1="0" y1="30" x2="0" y2="124" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="48%" stopColor="#E2E8F0" />
            <stop offset="100%" stopColor="#8E9BAE" />
          </linearGradient>
          <linearGradient id={candleGradId} x1="0" y1="4" x2="0" y2="134" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#84FF57" />
            <stop offset="48%" stopColor="#2EE06D" />
            <stop offset="100%" stopColor="#0C8C53" />
          </linearGradient>
        </defs>
        <path
          d="M38 36 H59 L51.5 64 H79.5 L87 36 H108 L87 114 H66 L73.5 84 H45.5 L38 114 L14 124 L38 36 Z"
          fill={`url(#${silverGradId})`}
        />
        <path
          d="M122 36 H186 L172 54 H138 L133.5 70 H166 L152 87 H129 L121.5 114 H100.5 L122 36 Z"
          fill={`url(#${silverGradId})`}
        />
        <rect x="225" y="4" width="5" height="20" rx="2" fill="#84FF57" />
        <path d="M180 42 L196 22 H276 L260 42 H180 Z" fill={`url(#${candleGradId})`} />
        <rect x="215" y="18" width="25" height="96" rx="2.5" fill={`url(#${candleGradId})`} />
        <rect x="225" y="114" width="5" height="20" rx="2" fill="#10985B" />
        <path
          d="M248 64 L286 28 L277 20 L314 10 L302 45 L294 37 L263 64 H248 Z"
          fill={`url(#${candleGradId})`}
        />
      </svg>
    );
  }

  return (
    <div className="flex items-center gap-3.5 select-none">
      {/* Recessed Sapphire-Glass Skeuomorphic Bezel housing the HFT Candlestick Logo */}
      <motion.div
        animate={
          isRunning
            ? {
                boxShadow: [
                  'inset 0 3px 10px rgba(0,0,0,0.92), 0 0 10px rgba(173,235,179,0.18)',
                  'inset 0 3px 10px rgba(0,0,0,0.92), 0 0 22px rgba(76,232,112,0.42)',
                  'inset 0 3px 10px rgba(0,0,0,0.92), 0 0 10px rgba(173,235,179,0.18)',
                ],
              }
            : undefined
        }
        transition={{ duration: 2.4, repeat: Infinity }}
        className="skeuo-oled flex h-[54px] w-[124px] shrink-0 items-center justify-center rounded-xl border border-[#ADEBB3]/35 px-2.5 py-1.5 sm:h-[58px] sm:w-[134px]"
      >
        <svg
          viewBox="0 0 324 138"
          className="h-full w-full overflow-visible"
          aria-label="HFT Futuristic Candlestick Trading Logo"
        >
          <defs>
            <linearGradient
              id={silverGradId}
              x1="0"
              y1="32"
              x2="0"
              y2="124"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="46%" stopColor="#E3E9F2" />
              <stop offset="100%" stopColor="#8996AA" />
            </linearGradient>
            <linearGradient
              id={candleGradId}
              x1="0"
              y1="4"
              x2="0"
              y2="134"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0%" stopColor="#85FF57" />
              <stop offset="48%" stopColor="#2DE06C" />
              <stop offset="100%" stopColor="#0C8C53" />
            </linearGradient>
            <filter id={glowFilterId} x="-25%" y="-25%" width="150%" height="150%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* Slanted Metallic 'H' with sharp blade foot */}
          <path
            d="M38 36 H59 L51.5 64 H79.5 L87 36 H108 L87 114 H66 L73.5 84 H45.5 L38 114 L14 124 L38 36 Z"
            fill={`url(#${silverGradId})`}
            stroke="#FFFFFF"
            strokeOpacity="0.35"
            strokeWidth="1.2"
          />

          {/* Slanted Metallic 'F' */}
          <path
            d="M122 36 H186 L172 54 H138 L133.5 70 H166 L152 87 H129 L121.5 114 H100.5 L122 36 Z"
            fill={`url(#${silverGradId})`}
            stroke="#FFFFFF"
            strokeOpacity="0.35"
            strokeWidth="1.2"
          />

          {/* Bullish Candlestick 'T' + Upward Breakout Arrow */}
          <g filter={`url(#${glowFilterId})`}>
            <rect x="225" y="4" width="5.5" height="20" rx="2" fill="#85FF57" />
            <path d="M180 42 L196 22 H276 L260 42 H180 Z" fill={`url(#${candleGradId})`} />
            <rect x="215" y="18" width="25" height="96" rx="2.5" fill={`url(#${candleGradId})`} />
            <rect x="225" y="114" width="5.5" height="20" rx="2" fill="#10985B" />
            <path
              d="M248 64 L286 28 L277 20 L314 10 L302 45 L294 37 L263 64 H248 Z"
              fill={`url(#${candleGradId})`}
            />
          </g>
        </svg>
      </motion.div>

      {/* Brand Wordmark & Tagline Lockup matching the Reference Logo */}
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="text-xs font-extrabold uppercase tracking-[0.2em] sm:text-sm">
            <span className="text-white">AUTOMATION </span>
            <span className="text-[#ADEBB3]">TRADING BOT</span>
          </div>
          <span className="rounded-md border border-[#EBAEE6]/40 bg-[#EBAEE6]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#EBAEE6]">
            USDⓈ-M Real
          </span>
          <span className="hidden rounded-md border border-[#ADEBB3]/30 bg-[#ADEBB3]/10 px-2 py-0.5 font-mono-num text-[10px] font-medium text-[#ADEBB3] sm:inline-block">
            15s • 1s
          </span>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#d5b8b5]">
          <span>
            TRADE SMARTER <span className="text-[#ADEBB3]">•</span> GROW FASTER
          </span>
          <span className="hidden text-[#EBAEE6]/30 md:inline">|</span>
          <span className="tracking-normal normal-case text-[11px] font-normal text-[#dec4c1]">
            by <strong className="font-semibold text-[#FF857A]">Trading Lifestyle Quant.</strong>
          </span>
        </div>
      </div>
    </div>
  );
};
