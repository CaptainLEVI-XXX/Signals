'use client';

import { motion } from 'framer-motion';

interface SignalsLogoProps {
  size?: 'sm' | 'md' | 'lg';
  animated?: boolean;
  className?: string;
}

export function SignalsLogo({ size = 'md', animated = true, className = '' }: SignalsLogoProps) {
  const dimensions = {
    sm: { width: 32, height: 32, stroke: 2 },
    md: { width: 40, height: 40, stroke: 2.5 },
    lg: { width: 56, height: 56, stroke: 3 },
  };

  const { width, height, stroke } = dimensions[size];

  // The logo represents two waves converging - signals meeting
  return (
    <div className={`relative ${className}`} style={{ width, height }}>
      <svg
        width={width}
        height={height}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="relative z-10"
      >
        {/* Background circle */}
        <circle
          cx="20"
          cy="20"
          r="18"
          fill="url(#logoGradient)"
          fillOpacity="0.1"
          stroke="url(#logoGradient)"
          strokeWidth="1"
        />

        {/* Left signal wave */}
        <motion.path
          d="M10 20C12 16 14 12 16 12C18 12 18 28 20 28C22 28 22 12 24 12"
          stroke="url(#logoGradient)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          initial={animated ? { pathLength: 0, opacity: 0 } : { pathLength: 1, opacity: 1 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 1, ease: 'easeOut' }}
        />

        {/* Right signal wave */}
        <motion.path
          d="M24 12C26 12 26 28 28 28C30 28 30 20 30 20"
          stroke="url(#signalCyan)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
          initial={animated ? { pathLength: 0, opacity: 0 } : { pathLength: 1, opacity: 1 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={{ duration: 1, delay: 0.3, ease: 'easeOut' }}
        />

        {/* Center pulse point */}
        <motion.circle
          cx="20"
          cy="20"
          r="3"
          fill="var(--signal-mint)"
          initial={animated ? { scale: 0, opacity: 0 } : { scale: 1, opacity: 1 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.8 }}
        />

        <defs>
          <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00FFB2" />
            <stop offset="100%" stopColor="#00D4FF" />
          </linearGradient>
          <linearGradient id="signalCyan" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#00D4FF" />
            <stop offset="100%" stopColor="#00FFB2" />
          </linearGradient>
        </defs>
      </svg>

      {/* Glow effect */}
      {animated && (
        <motion.div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(0, 255, 178, 0.3) 0%, transparent 70%)',
          }}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: [0, 0.5, 0], scale: [0.8, 1.2, 0.8] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </div>
  );
}

// Simplified icon version for favicons and small uses
export function SignalsIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <rect width="32" height="32" rx="8" fill="#0C0C0E" />
      <path
        d="M8 16C10 12 12 8 14 8C16 8 16 24 18 24C20 24 20 8 22 8C24 8 24 24 24 16"
        stroke="url(#iconGradient)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="16" cy="16" r="2" fill="#00FFB2" />
      <defs>
        <linearGradient id="iconGradient" x1="8" y1="16" x2="24" y2="16">
          <stop stopColor="#00FFB2" />
          <stop offset="1" stopColor="#00D4FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
