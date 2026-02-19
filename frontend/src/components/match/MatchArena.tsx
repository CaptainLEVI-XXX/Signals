'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { ChoiceCard } from '@/components/common/ChoiceCard';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { PhaseBadge } from '@/components/common/PhaseBadge';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Match } from '@/types';

const EXPLORER_URL = 'https://testnet.bscscan.com';

interface MatchArenaProps {
  match: Match;
}

export function MatchArena({ match }: MatchArenaProps) {
  const { agentA, agentB, phase, phaseDeadline, choiceA, choiceB, pointsA, pointsB, commitA, commitB } = match;

  const isSettled = phase === 'SETTLED';
  const isRevealing = phase === 'REVEALING';
  const showChoices = isSettled || isRevealing;

  // Phase duration for progress bar
  const phaseDurations: Record<string, number> = {
    NEGOTIATING: 90000,
    COMMITTING: 15000,
    REVEALING: 15000,
  };

  return (
    <div className="relative">
      {/* Dramatic glow effect */}
      <div className="absolute -inset-4 bg-gradient-to-r from-signal-mint/5 via-transparent to-signal-cyan/5 rounded-3xl blur-xl pointer-events-none" />

      {/* Arena container */}
      <div className="relative rounded-2xl border border-signal-slate bg-signal-charcoal/80 backdrop-blur-xl overflow-hidden">
        {/* Header with phase and timer */}
        <div className="flex items-center justify-between p-4 border-b border-signal-slate bg-signal-graphite/50">
          <div className="flex items-center gap-3">
            <PhaseBadge phase={phase} />
            <span className="text-sm text-signal-text font-mono">
              Match #{match.id}
            </span>
          </div>

          {!isSettled && (
            <CountdownTimer
              deadline={phaseDeadline}
              totalDuration={phaseDurations[phase]}
              size="md"
              showProgress
            />
          )}

          {isSettled && (
            <span className="text-sm font-mono text-cooperate">COMPLETE</span>
          )}
        </div>

        {/* Main arena */}
        <div className="p-8">
          <div className="flex items-center justify-center gap-8 lg:gap-16">
            {/* Agent A */}
            <motion.div
              className="flex flex-col items-center gap-4"
              initial={{ x: -50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.1 }}
            >
              <AgentAvatar
                name={agentA.name}
                avatarUrl={agentA.avatarUrl}
                size="xl"
                showRing={isSettled}
                ringColor={isSplit(choiceA) ? 'cooperate' : (choiceA === 'STEAL' || choiceA === 2) ? 'defect' : 'mint'}
              />
              <div className="text-center">
                <h3 className="font-display text-2xl text-signal-white tracking-wide">
                  {agentA.name}
                </h3>
                {isSettled && pointsA !== null && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className={cn(
                      'mt-2 text-3xl font-display',
                      (pointsA ?? 0) >= 3 ? 'text-cooperate' : pointsA === 0 ? 'text-defect' : 'text-signal-mint'
                    )}
                  >
                    +{pointsA}
                  </motion.div>
                )}
                {phase === 'COMMITTING' && (
                  <div className={cn(
                    'mt-2 text-xs font-mono',
                    commitA ? 'text-cooperate' : 'text-signal-text'
                  )}>
                    {commitA ? '✓ LOCKED' : 'DECIDING...'}
                  </div>
                )}
              </div>
            </motion.div>

            {/* VS / Choice cards */}
            <div className="flex flex-col items-center gap-6">
              {showChoices ? (
                <div className="flex items-center gap-4">
                  <ChoiceCard
                    choice={choiceA}
                    revealed={isSettled}
                    size="lg"
                    animate={isSettled}
                  />
                  <div className="px-4">
                    <span className="text-signal-muted font-display text-4xl">VS</span>
                  </div>
                  <ChoiceCard
                    choice={choiceB}
                    revealed={isSettled}
                    size="lg"
                    animate={isSettled}
                  />
                </div>
              ) : (
                <div className="flex flex-col items-center">
                  <motion.div
                    className="text-6xl font-display text-gradient-mint"
                    animate={{ scale: [1, 1.05, 1] }}
                    transition={{ duration: 2, repeat: Infinity }}
                  >
                    VS
                  </motion.div>
                  {phase === 'NEGOTIATING' && (
                    <p className="mt-4 text-sm text-signal-text">
                      Agents are exchanging signals...
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Agent B */}
            <motion.div
              className="flex flex-col items-center gap-4"
              initial={{ x: 50, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              transition={{ delay: 0.1 }}
            >
              <AgentAvatar
                name={agentB.name}
                avatarUrl={agentB.avatarUrl}
                size="xl"
                showRing={isSettled}
                ringColor={isSplit(choiceB) ? 'cooperate' : (choiceB === 'STEAL' || choiceB === 2) ? 'defect' : 'mint'}
              />
              <div className="text-center">
                <h3 className="font-display text-2xl text-signal-white tracking-wide">
                  {agentB.name}
                </h3>
                {isSettled && pointsB !== null && (
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    className={cn(
                      'mt-2 text-3xl font-display',
                      (pointsB ?? 0) >= 3 ? 'text-cooperate' : pointsB === 0 ? 'text-defect' : 'text-signal-mint'
                    )}
                  >
                    +{pointsB}
                  </motion.div>
                )}
                {phase === 'COMMITTING' && (
                  <div className={cn(
                    'mt-2 text-xs font-mono',
                    commitB ? 'text-cooperate' : 'text-signal-text'
                  )}>
                    {commitB ? '✓ LOCKED' : 'DECIDING...'}
                  </div>
                )}
              </div>
            </motion.div>
          </div>
        </div>

        {/* Result banner for settled matches */}
        <AnimatePresence>
          {isSettled && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="border-t border-signal-slate bg-signal-graphite/30"
            >
              <div className="p-4 text-center">
                <ResultMessage choiceA={choiceA} choiceB={choiceB} agentA={agentA.name} agentB={agentB.name} />
                {match.txHash && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="mt-3"
                  >
                    <a
                      href={`${EXPLORER_URL}/tx/${match.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-signal-slate/50 border border-signal-slate hover:border-signal-gold/40 text-sm font-mono text-signal-light hover:text-signal-white transition-all"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      View Settlement on Explorer
                      <span className="text-signal-text">{match.txHash.slice(0, 8)}...{match.txHash.slice(-6)}</span>
                    </a>
                  </motion.div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function isSplit(c: Match['choiceA']): boolean {
  return c === 1 || c === 'SPLIT';
}

function ResultMessage({
  choiceA,
  choiceB,
  agentA,
  agentB,
}: {
  choiceA: Match['choiceA'];
  choiceB: Match['choiceB'];
  agentA: string;
  agentB: string;
}) {
  const aSplit = isSplit(choiceA);
  const bSplit = isSplit(choiceB);

  if (aSplit && bSplit) {
    return (
      <p className="text-cooperate font-display text-xl tracking-wide">
        MUTUAL COOPERATION — Both agents honored their signals.
      </p>
    );
  }
  if (!aSplit && !bSplit) {
    return (
      <p className="text-defect font-display text-xl tracking-wide">
        MUTUAL DESTRUCTION — Both agents defected. No one wins.
      </p>
    );
  }
  if (!aSplit) {
    return (
      <p className="text-signal-mint font-display text-xl tracking-wide">
        BETRAYAL — {agentA.toUpperCase()} defected against {agentB}.
      </p>
    );
  }
  return (
    <p className="text-signal-mint font-display text-xl tracking-wide">
      BETRAYAL — {agentB.toUpperCase()} defected against {agentA}.
    </p>
  );
}
