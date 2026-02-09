'use client';

import { cn } from '@/lib/utils';
import type { MatchPhase, TournamentState } from '@/types';

interface PhaseBadgeProps {
  phase?: MatchPhase;
  state?: TournamentState;
  className?: string;
}

export function PhaseBadge({ phase, state, className }: PhaseBadgeProps) {
  const value = phase || state;
  if (!value) return null;

  const classes: Record<string, string> = {
    // Match phases
    NEGOTIATING: 'phase-signaling',
    COMMITTING: 'phase-committing',
    REVEALING: 'phase-revealing',
    SETTLED: 'phase-settled',
    // Tournament states
    REGISTRATION: 'phase-signaling',
    ACTIVE: 'phase-committing',
    FINAL: 'phase-revealing',
    COMPLETE: 'phase-settled',
    CANCELLED: 'bg-defect/15 text-defect border-defect/30',
  };

  // Display names for phases (more thematic)
  const displayNames: Record<string, string> = {
    NEGOTIATING: 'SIGNALING',
    COMMITTING: 'COMMITTING',
    REVEALING: 'REVEALING',
    SETTLED: 'SETTLED',
    REGISTRATION: 'OPEN',
    ACTIVE: 'LIVE',
    FINAL: 'FINAL',
    COMPLETE: 'COMPLETE',
    CANCELLED: 'CANCELLED',
  };

  return (
    <span
      className={cn(
        'badge',
        classes[value] || 'bg-signal-muted/15 text-signal-text border-signal-muted/30',
        className
      )}
    >
      {displayNames[value] || value}
    </span>
  );
}
