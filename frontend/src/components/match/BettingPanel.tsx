'use client';

import { motion } from 'framer-motion';
import { cn, formatTokenAmount } from '@/lib/utils';
import type { BettingOdds, AgentInfo } from '@/types';

interface BettingPanelProps {
  agentA: AgentInfo;
  agentB: AgentInfo;
  odds: BettingOdds;
  totalPool: string;
  outcomePools: Record<string, string>;
  bettingOpen: boolean;
  className?: string;
}

const outcomeLabels: Record<string, { label: string; emoji: string; color: string }> = {
  BOTH_SPLIT: { label: 'Both Cooperate', emoji: '🤝', color: 'text-cooperate' },
  BOTH_STEAL: { label: 'Both Defect', emoji: '⚔️', color: 'text-defect' },
  A_STEALS: { label: 'A Defects', emoji: '🎯', color: 'text-signal-mint' },
  B_STEALS: { label: 'B Defects', emoji: '🎯', color: 'text-signal-mint' },
};

export function BettingPanel({
  agentA,
  agentB,
  odds,
  totalPool,
  outcomePools,
  bettingOpen,
  className,
}: BettingPanelProps) {
  const outcomes: string[] = ['BOTH_SPLIT', 'A_STEALS', 'B_STEALS', 'BOTH_STEAL'];

  // Calculate percentages
  const total = BigInt(totalPool || '0');
  const getPercentage = (amount: string) => {
    if (total === 0n) return 0;
    return Number((BigInt(amount) * 100n) / total);
  };

  return (
    <div className={cn('card', className)}>
      <div className="p-4 border-b border-signal-slate flex items-center justify-between">
        <div>
          <h3 className="font-display text-lg text-signal-white tracking-wide">
            BETTING POOL
          </h3>
          <p className="text-xs text-signal-text mt-1">
            Parimutuel odds
          </p>
        </div>
        <div className={cn(
          'px-3 py-1 rounded-full text-xs font-mono',
          bettingOpen
            ? 'bg-cooperate/20 text-cooperate border border-cooperate/30'
            : 'bg-defect/20 text-defect border border-defect/30'
        )}>
          {bettingOpen ? 'OPEN' : 'CLOSED'}
        </div>
      </div>

      <div className="p-4">
        {/* Total pool */}
        <div className="text-center mb-6">
          <p className="text-xs text-signal-text uppercase tracking-wider mb-1">Total Pool</p>
          <p className="text-3xl font-display text-signal-mint">
            {formatTokenAmount(totalPool)} <span className="text-lg text-signal-text">ARENA</span>
          </p>
        </div>

        {/* Outcome options */}
        <div className="space-y-3">
          {outcomes.map((outcome) => {
            const { label, emoji, color } = outcomeLabels[outcome];
            const odds_val = odds[outcome as keyof BettingOdds];
            const poolAmount = outcomePools[outcome] || '0';
            const percentage = getPercentage(poolAmount);

            // Customize label for specific agents
            let displayLabel = label;
            if (outcome === 'A_STEALS') displayLabel = `${agentA.name} Defects`;
            if (outcome === 'B_STEALS') displayLabel = `${agentB.name} Defects`;

            return (
              <motion.div
                key={outcome}
                className="relative p-4 rounded-lg border border-signal-slate bg-signal-graphite/50 overflow-hidden"
                whileHover={bettingOpen ? { scale: 1.02 } : undefined}
              >
                {/* Progress bar background */}
                <motion.div
                  className="absolute inset-0 bg-signal-slate/30"
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  transition={{ duration: 0.5 }}
                />

                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{emoji}</span>
                    <div>
                      <p className={cn('font-medium', color)}>{displayLabel}</p>
                      <p className="text-xs text-signal-text">
                        {formatTokenAmount(poolAmount)} ARENA ({percentage.toFixed(1)}%)
                      </p>
                    </div>
                  </div>

                  <div className="text-right">
                    <p className="text-2xl font-display text-signal-white">
                      {odds_val > 0 ? odds_val.toFixed(2) : '-'}x
                    </p>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Betting info */}
        <div className="mt-6 p-3 rounded-lg bg-signal-slate/30 border border-signal-slate">
          <p className="text-xs text-signal-text text-center">
            5% house fee • Betting closes 30s before commit phase
          </p>
        </div>
      </div>
    </div>
  );
}
