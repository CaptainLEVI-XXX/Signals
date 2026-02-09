'use client';

import { useState, useEffect, useCallback } from 'react';

interface UseCountdownReturn {
  timeRemaining: number;
  formatted: string;
  isExpired: boolean;
  percentage: number;
}

export function useCountdown(deadline: number, totalDuration?: number): UseCountdownReturn {
  const [timeRemaining, setTimeRemaining] = useState(() => {
    return Math.max(0, deadline - Date.now());
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const remaining = Math.max(0, deadline - Date.now());
      setTimeRemaining(remaining);

      if (remaining === 0) {
        clearInterval(interval);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [deadline]);

  const formatted = useCallback(() => {
    if (timeRemaining === 0) return '0:00';

    const seconds = Math.floor(timeRemaining / 1000) % 60;
    const minutes = Math.floor(timeRemaining / 60000);

    if (minutes > 0) {
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }

    return `0:${seconds.toString().padStart(2, '0')}`;
  }, [timeRemaining]);

  const percentage = totalDuration
    ? Math.min(100, (timeRemaining / totalDuration) * 100)
    : 0;

  return {
    timeRemaining,
    formatted: formatted(),
    isExpired: timeRemaining === 0,
    percentage,
  };
}
