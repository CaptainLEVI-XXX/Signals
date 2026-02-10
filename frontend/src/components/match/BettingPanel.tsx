'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import { cn, formatTokenAmount } from '@/lib/utils';
import { useWallet } from '@/contexts/WalletContext';
import { useBetting } from '@/hooks/useBetting';
import type { BettingOdds, AgentInfo } from '@/types';
import { ethers } from 'ethers';

interface BettingPanelProps {
  matchId: number;
  agentA: AgentInfo;
  agentB: AgentInfo;
  odds: BettingOdds;
  totalPool: string;
  outcomePools: Record<string, string>;
  bettingOpen: boolean;
  className?: string;
}

const outcomeLabels: Record<string, { label: string; emoji: string; color: string; value: number }> = {
  BOTH_SPLIT: { label: 'Both Cooperate', emoji: '\u{1F91D}', color: 'text-cooperate', value: 1 },
  A_STEALS: { label: 'A Steals', emoji: '\u{1F5E1}\uFE0F', color: 'text-defect', value: 2 },
  B_STEALS: { label: 'B Steals', emoji: '\u{1F5E1}\uFE0F', color: 'text-defect', value: 3 },
  BOTH_STEAL: { label: 'Both Steal', emoji: '\u2694\uFE0F', color: 'text-defect', value: 4 },
};

const POOL_STATE_LABELS: Record<number, string> = {
  0: 'NONE',
  1: 'OPEN',
  2: 'CLOSED',
  3: 'SETTLED',
};

const OUTCOME_NAMES: Record<number, string> = {
  1: 'Both Cooperate',
  2: 'A Steals',
  3: 'B Steals',
  4: 'Both Steal',
};

const QUICK_AMOUNTS = ['1', '5', '10', '50'];

export function BettingPanel({
  matchId,
  agentA,
  agentB,
  odds,
  totalPool,
  outcomePools,
  bettingOpen,
  className,
}: BettingPanelProps) {
  const { isConnected, connect } = useWallet();
  const {
    arenaBalance,
    allowance,
    existingBet,
    poolState,
    poolResult,
    txPending,
    error,
    potentialWinnings,
    approve,
    placeBet,
    claimWinnings,
    claimRefund,
    fetchPotentialWinnings,
  } = useBetting(matchId);

  const [selectedOutcome, setSelectedOutcome] = useState<number | null>(null);
  const [betAmount, setBetAmount] = useState('');

  const outcomes: string[] = ['BOTH_SPLIT', 'A_STEALS', 'B_STEALS', 'BOTH_STEAL'];

  // Use on-chain pool state if available, otherwise fall back to prop
  const effectivePoolState = poolState > 0 ? poolState : (bettingOpen ? 1 : 2);
  const isOpen = effectivePoolState === 1;
  const isSettled = effectivePoolState === 3;

  // Calculate percentages
  let total = 0n;
  try {
    const cleaned = (totalPool || '0').replace(/,/g, '');
    total = /^\d+$/.test(cleaned) ? BigInt(cleaned) : 0n;
  } catch {
    total = 0n;
  }
  const getPercentage = (amount: string) => {
    if (total === 0n) return 0;
    try {
      const cleaned = (amount || '0').replace(/,/g, '');
      const val = /^\d+$/.test(cleaned) ? BigInt(cleaned) : 0n;
      return Number((val * 100n) / total);
    } catch {
      return 0;
    }
  };

  // Fetch potential winnings when outcome or amount changes
  useEffect(() => {
    if (selectedOutcome && betAmount && parseFloat(betAmount) >= 1) {
      const timeout = setTimeout(() => {
        fetchPotentialWinnings(selectedOutcome, betAmount);
      }, 300);
      return () => clearTimeout(timeout);
    }
  }, [selectedOutcome, betAmount, fetchPotentialWinnings]);

  // Balance in human-readable form
  const balanceFormatted = formatTokenAmount(arenaBalance);
  const balanceEther = arenaBalance !== '0'
    ? parseFloat(ethers.formatEther(arenaBalance))
    : 0;

  // Check if approval is needed
  let betAmountWei = 0n;
  try {
    if (betAmount && parseFloat(betAmount) > 0) {
      betAmountWei = ethers.parseEther(betAmount);
    }
  } catch { /* invalid input */ }
  const needsApproval = betAmountWei > 0n && allowance < betAmountWei;

  const handleSetMax = useCallback(() => {
    if (balanceEther > 0) {
      setBetAmount(Math.floor(balanceEther).toString());
    }
  }, [balanceEther]);

  const handlePlaceBet = async () => {
    if (!selectedOutcome || !betAmount) return;
    await placeBet(selectedOutcome, betAmount);
  };

  // Determine which outcome label to show for existing bet
  const existingBetOutcomeName = existingBet
    ? (OUTCOME_NAMES[existingBet.outcome] || `Outcome ${existingBet.outcome}`)
    : '';

  return (
    <div className={cn('card', className)}>
      {/* Header with status badge */}
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
          isOpen
            ? 'bg-cooperate/20 text-cooperate border border-cooperate/30'
            : isSettled
              ? 'bg-signal-purple-glow/20 text-signal-purple-glow border border-signal-purple-glow/30'
              : 'bg-defect/20 text-defect border border-defect/30'
        )}>
          {POOL_STATE_LABELS[effectivePoolState] || 'CLOSED'}
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

        {/* Outcome options — clickable when betting is open */}
        <div className="space-y-3">
          {outcomes.map((outcome) => {
            const { label, emoji, color, value } = outcomeLabels[outcome];
            const odds_val = odds[outcome as keyof BettingOdds];
            const poolAmount = outcomePools[outcome] || '0';
            const percentage = getPercentage(poolAmount);
            const isSelected = selectedOutcome === value;
            const canSelect = isOpen && !existingBet && isConnected;

            let displayLabel = label;
            if (outcome === 'A_STEALS') displayLabel = `${agentA.name} Steals`;
            if (outcome === 'B_STEALS') displayLabel = `${agentB.name} Steals`;

            return (
              <motion.div
                key={outcome}
                className={cn(
                  'relative p-4 rounded-lg border overflow-hidden transition-colors',
                  isSelected
                    ? 'border-signal-mint bg-signal-mint/10'
                    : 'border-signal-slate bg-signal-graphite/50',
                  canSelect && 'cursor-pointer hover:border-signal-light'
                )}
                whileHover={canSelect ? { scale: 1.02 } : undefined}
                onClick={() => {
                  if (canSelect) {
                    setSelectedOutcome(isSelected ? null : value);
                  }
                }}
              >
                {/* Progress bar background */}
                <motion.div
                  className={cn(
                    'absolute inset-0',
                    isSelected ? 'bg-signal-mint/10' : 'bg-signal-slate/30'
                  )}
                  initial={{ width: 0 }}
                  animate={{ width: `${percentage}%` }}
                  transition={{ duration: 0.5 }}
                />

                <div className="relative flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-xl">{emoji}</span>
                    <div>
                      <p className={cn('font-medium', isSelected ? 'text-signal-mint' : color)}>
                        {displayLabel}
                      </p>
                      <p className="text-xs text-signal-text">
                        {formatTokenAmount(poolAmount)} ARENA ({percentage.toFixed(1)}%)
                      </p>
                    </div>
                  </div>

                  <div className="text-right flex items-center gap-3">
                    <p className="text-2xl font-display text-signal-white">
                      {odds_val > 0 ? odds_val.toFixed(2) : '-'}x
                    </p>
                    {isSelected && (
                      <div className="w-3 h-3 rounded-full bg-signal-mint" />
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Wallet Balance */}
        {isConnected && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-signal-slate/20 border border-signal-slate">
            <div className="flex items-center justify-between">
              <span className="text-xs text-signal-text">Your Balance</span>
              <span className="text-sm font-mono text-signal-white">
                {balanceFormatted} ARENA
              </span>
            </div>
          </div>
        )}

        {/* Existing bet display */}
        {existingBet && (
          <div className="mt-4 p-3 rounded-lg bg-signal-purple-glow/10 border border-signal-purple-glow/30">
            <p className="text-xs text-signal-text mb-1">Your Bet</p>
            <p className="text-sm font-mono text-signal-white">
              {formatTokenAmount(existingBet.amount)} ARENA on {existingBetOutcomeName}
            </p>
            {existingBet.claimed && (
              <p className="text-xs text-cooperate mt-1">Claimed</p>
            )}
          </div>
        )}

        {/* Bet amount input — only when pool is open and no existing bet */}
        {isOpen && !existingBet && isConnected && selectedOutcome && (
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs text-signal-text block mb-1">Bet Amount (ARENA)</label>
              <input
                type="number"
                min="1"
                step="1"
                max={Math.floor(balanceEther)}
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                placeholder="Min 1 ARENA"
                className="w-full px-3 py-2 rounded-lg bg-signal-graphite border border-signal-slate text-signal-white font-mono text-sm focus:border-signal-mint focus:outline-none"
              />
            </div>

            {/* Quick amount buttons */}
            <div className="flex gap-2">
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => setBetAmount(amt)}
                  disabled={parseFloat(amt) > balanceEther}
                  className={cn(
                    'flex-1 py-1.5 rounded text-xs font-mono border transition-colors',
                    betAmount === amt
                      ? 'border-signal-mint text-signal-mint bg-signal-mint/10'
                      : 'border-signal-slate text-signal-text hover:border-signal-light',
                    parseFloat(amt) > balanceEther && 'opacity-30 cursor-not-allowed'
                  )}
                >
                  {amt}
                </button>
              ))}
              <button
                onClick={handleSetMax}
                disabled={balanceEther < 1}
                className={cn(
                  'flex-1 py-1.5 rounded text-xs font-mono border transition-colors',
                  'border-signal-slate text-signal-text hover:border-signal-light',
                  balanceEther < 1 && 'opacity-30 cursor-not-allowed'
                )}
              >
                MAX
              </button>
            </div>

            {/* Potential winnings */}
            {betAmount && parseFloat(betAmount) >= 1 && potentialWinnings !== '0' && (
              <div className="px-3 py-2 rounded-lg bg-cooperate/10 border border-cooperate/20">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-signal-text">Potential Payout</span>
                  <span className="text-sm font-mono text-cooperate">
                    {formatTokenAmount(potentialWinnings)} ARENA
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="mt-3 px-3 py-2 rounded-lg bg-defect/10 border border-defect/30">
            <p className="text-xs text-defect">{error}</p>
          </div>
        )}

        {/* Action button */}
        <div className="mt-4">
          {!isConnected ? (
            <button
              onClick={connect}
              className="w-full py-3 rounded-lg font-display text-sm tracking-wider bg-signal-mint/20 text-signal-mint border border-signal-mint/30 hover:bg-signal-mint/30 transition-colors"
            >
              CONNECT WALLET
            </button>
          ) : isOpen && !existingBet ? (
            needsApproval ? (
              <button
                onClick={approve}
                disabled={txPending || !selectedOutcome || !betAmount}
                className={cn(
                  'w-full py-3 rounded-lg font-display text-sm tracking-wider transition-colors',
                  txPending
                    ? 'bg-signal-slate text-signal-text cursor-wait'
                    : 'bg-warning-bright/20 text-warning-bright border border-warning-bright/30 hover:bg-warning-bright/30'
                )}
              >
                {txPending ? 'APPROVING...' : 'APPROVE ARENA'}
              </button>
            ) : (
              <button
                onClick={handlePlaceBet}
                disabled={txPending || !selectedOutcome || !betAmount || parseFloat(betAmount) < 1}
                className={cn(
                  'w-full py-3 rounded-lg font-display text-sm tracking-wider transition-colors',
                  txPending
                    ? 'bg-signal-slate text-signal-text cursor-wait'
                    : !selectedOutcome || !betAmount || parseFloat(betAmount) < 1
                      ? 'bg-signal-slate text-signal-text cursor-not-allowed'
                      : 'bg-cooperate/20 text-cooperate border border-cooperate/30 hover:bg-cooperate/30'
                )}
              >
                {txPending ? 'PLACING BET...' : 'PLACE BET'}
              </button>
            )
          ) : isSettled && existingBet && !existingBet.claimed ? (
            existingBet.outcome === poolResult ? (
              // Winner — can claim winnings
              <button
                onClick={claimWinnings}
                disabled={txPending}
                className={cn(
                  'w-full py-3 rounded-lg font-display text-sm tracking-wider transition-colors',
                  txPending
                    ? 'bg-signal-slate text-signal-text cursor-wait'
                    : 'bg-cooperate/20 text-cooperate border border-cooperate/30 hover:bg-cooperate/30'
                )}
              >
                {txPending ? 'CLAIMING...' : 'CLAIM WINNINGS'}
              </button>
            ) : (
              // Loser — show lost message, offer refund if no one predicted correctly
              <div className="space-y-2">
                <div className="w-full py-3 rounded-lg font-display text-sm tracking-wider text-center bg-defect/10 text-defect border border-defect/30">
                  BET LOST
                </div>
                <button
                  onClick={claimRefund}
                  disabled={txPending}
                  className={cn(
                    'w-full py-2 rounded-lg text-xs font-mono transition-colors',
                    txPending
                      ? 'text-signal-text cursor-wait'
                      : 'text-signal-text hover:text-signal-light'
                  )}
                >
                  {txPending ? 'Claiming...' : 'Claim refund (if no winners predicted correctly)'}
                </button>
              </div>
            )
          ) : existingBet?.claimed ? (
            <div className="w-full py-3 rounded-lg font-display text-sm tracking-wider text-center bg-signal-slate/30 text-cooperate">
              CLAIMED
            </div>
          ) : !isOpen ? (
            <div className="w-full py-3 rounded-lg font-display text-sm tracking-wider text-center bg-signal-slate/30 text-signal-text">
              BETTING CLOSED
            </div>
          ) : null}
        </div>

        {/* Info footer */}
        <div className="mt-4 p-3 rounded-lg bg-signal-slate/30 border border-signal-slate">
          <p className="text-xs text-signal-text text-center">
            5% house fee &bull; Min bet 1 ARENA &bull; One bet per match
          </p>
        </div>
      </div>
    </div>
  );
}
