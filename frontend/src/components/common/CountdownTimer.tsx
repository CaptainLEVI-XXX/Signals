'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { useCountdown } from '@/hooks/useCountdown';
import { cn } from '@/lib/utils';

interface CountdownTimerProps {
  deadline: number;
  totalDuration?: number;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showProgress?: boolean;
  urgent?: boolean;
  className?: string;
}

export function CountdownTimer({
  deadline,
  totalDuration,
  size = 'md',
  showProgress = false,
  urgent = true,
  className,
}: CountdownTimerProps) {
  const { formatted, isExpired, percentage, timeRemaining } = useCountdown(deadline, totalDuration);

  const isUrgent = urgent && timeRemaining > 0 && timeRemaining < 10000;

  const sizeClasses = {
    sm: 'text-lg',
    md: 'text-2xl',
    lg: 'text-4xl',
    xl: 'text-6xl font-display',
  };

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <AnimatePresence mode="wait">
        <motion.div
          key={formatted}
          initial={{ scale: 1.2, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.8, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className={cn(
            'font-mono tabular-nums',
            sizeClasses[size],
            isExpired && 'text-signal-text',
            isUrgent && 'text-defect animate-pulse',
            !isExpired && !isUrgent && 'text-signal-light'
          )}
        >
          {formatted}
        </motion.div>
      </AnimatePresence>

      {showProgress && totalDuration && (
        <div className="w-full h-1 bg-signal-slate rounded-full overflow-hidden">
          <motion.div
            className={cn(
              'h-full rounded-full',
              isUrgent ? 'bg-defect' : 'bg-signal-mint'
            )}
            initial={{ width: '100%' }}
            animate={{ width: `${percentage}%` }}
            transition={{ duration: 0.1 }}
          />
        </div>
      )}
    </div>
  );
}
