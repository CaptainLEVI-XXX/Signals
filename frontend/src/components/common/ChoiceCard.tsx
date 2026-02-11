'use client';

import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { Match } from '@/types';

interface ChoiceCardProps {
  choice: Match['choiceA'];
  revealed?: boolean;
  size?: 'sm' | 'md' | 'lg';
  animate?: boolean;
  className?: string;
}

export function ChoiceCard({
  choice,
  revealed = true,
  size = 'md',
  animate = true,
  className,
}: ChoiceCardProps) {
  const sizeClasses = {
    sm: 'w-16 h-20 text-2xl',
    md: 'w-24 h-32 text-4xl',
    lg: 'w-32 h-44 text-6xl',
  };

  // Map SPLIT/STEAL to COOPERATE/DEFECT terminology
  // Handle both string ('SPLIT'/'STEAL') and numeric (1=SPLIT, 2=STEAL) values
  const isSplit = choice === 'SPLIT' || choice === 1;
  const isSteal = choice === 'STEAL' || choice === 2;
  const displayChoice = isSplit ? 'COOPERATE' : isSteal ? 'DEFECT' : '';

  if (!revealed || !choice) {
    return (
      <motion.div
        className={cn(
          'rounded-xl bg-gradient-to-br from-signal-slate to-signal-graphite border-2 border-signal-slate',
          'flex items-center justify-center',
          sizeClasses[size],
          className
        )}
        initial={animate ? { rotateY: 0 } : false}
        animate={animate ? { rotateY: [0, 5, -5, 0] } : false}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      >
        <span className="text-signal-text">?</span>
      </motion.div>
    );
  }

  return (
    <motion.div
      className={cn(
        'rounded-xl border-2 flex flex-col items-center justify-center',
        sizeClasses[size],
        isSplit && 'bg-gradient-to-br from-cooperate/20 to-cooperate/10 border-cooperate shadow-glow-cooperate',
        isSteal && 'bg-gradient-to-br from-defect/20 to-defect/10 border-defect shadow-glow-defect',
        className
      )}
      initial={animate ? { rotateY: 180, scale: 0.8, opacity: 0 } : false}
      animate={animate ? { rotateY: 0, scale: 1, opacity: 1 } : false}
      transition={{ duration: 0.6, type: 'spring', stiffness: 200 }}
    >
      <span className="mb-1">{isSplit ? '🤝' : '⚔️'}</span>
      <span className={cn(
        'font-mono tracking-wider',
        isSplit ? 'text-cooperate' : 'text-defect',
        size === 'sm' && 'text-[8px]',
        size === 'md' && 'text-[10px]',
        size === 'lg' && 'text-xs',
      )}>
        {displayChoice}
      </span>
    </motion.div>
  );
}
