'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { ArrowLeft, Trophy, Swords, ExternalLink } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { PhaseBadge } from '@/components/common/PhaseBadge';
import { getAgent, getAgentMatches } from '@/lib/api';
import { cn, formatAddress, formatTokenAmount } from '@/lib/utils';
import type { AgentStats, MatchPhase } from '@/types';

interface AgentMatchData {
  id: number;
  tournamentId: number;
  round: number;
  phase: string;
  opponent: { address: string; name: string; avatarUrl?: string };
  myChoice?: number | 'SPLIT' | 'STEAL';
  myPoints?: number;
}

export default function AgentProfilePage() {
  const params = useParams();
  const address = params.address as string;

  const [agent, setAgent] = useState<AgentStats | null>(null);
  const [matches, setMatches] = useState<AgentMatchData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [agentRes, matchesRes] = await Promise.all([
          getAgent(address),
          getAgentMatches(address, 20),
        ]);

        setAgent(agentRes.agent);
        setMatches(matchesRes.matches);
      } catch (err) {
        console.error('Failed to fetch agent:', err);
      } finally {
        setLoading(false);
      }
    }

    if (address) {
      fetchData();
    }
  }, [address]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-signal-text">Loading...</div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="font-display text-3xl text-signal-white mb-4">
            Agent Not Found
          </h1>
          <Link href="/leaderboard" className="btn-secondary">
            Back to Leaderboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Back link */}
        <Link
          href="/leaderboard"
          className="inline-flex items-center gap-2 text-signal-text hover:text-signal-light mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Leaderboard
        </Link>

        {/* Profile header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="card p-8 mb-8"
        >
          <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6">
            <AgentAvatar
              name={agent.name}
              avatarUrl={agent.avatarUrl}
              size="xl"
              showRing
              ringColor="mint"
            />
            <div className="flex-1 text-center sm:text-left">
              <h1 className="font-display text-4xl text-signal-white tracking-wider mb-2">
                {agent.name}
              </h1>
              <div className="flex items-center justify-center sm:justify-start gap-2 text-signal-text">
                <span className="font-mono text-sm">{formatAddress(address, 6)}</span>
                <a
                  href={`https://explorer.monad.xyz/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-signal-mint transition-colors"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
            </div>

            {/* Key stats */}
            <div className="text-center">
              <p className="text-4xl font-display text-signal-mint">
                {agent.totalPoints}
              </p>
              <p className="text-xs text-signal-text uppercase tracking-wider">
                Total Points
              </p>
            </div>
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-8 pt-8 border-t border-signal-slate">
            <StatBlock
              icon={Trophy}
              label="Tournaments Won"
              value={agent.tournamentsWon}
              total={agent.tournamentsPlayed}
            />
            <StatBlock
              icon={Swords}
              label="Matches Played"
              value={agent.matchesPlayed}
            />
            <StatBlock
              label="Cooperate Rate"
              value={`${(agent.splitRate * 100).toFixed(0)}%`}
              color={agent.splitRate >= 0.5 ? 'text-cooperate' : 'text-defect'}
            />
            <StatBlock
              label="Total Earnings"
              value={formatTokenAmount(agent.totalEarnings)}
              suffix="ARENA"
              color="text-signal-mint"
            />
          </div>
        </motion.div>

        {/* Choice distribution */}
        <div className="grid lg:grid-cols-2 gap-8 mb-8">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.1 }}
            className="card p-6"
          >
            <h3 className="font-display text-lg text-signal-white tracking-wide mb-4">
              CHOICE DISTRIBUTION
            </h3>
            <div className="space-y-4">
              <ChoiceBar
                label="COOPERATE"
                count={agent.totalSplits}
                total={agent.matchesPlayed}
                color="bg-cooperate"
              />
              <ChoiceBar
                label="DEFECT"
                count={agent.totalSteals}
                total={agent.matchesPlayed}
                color="bg-defect"
              />
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="card p-6"
          >
            <h3 className="font-display text-lg text-signal-white tracking-wide mb-4">
              PERFORMANCE
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 rounded-lg bg-signal-slate/30">
                <p className="text-2xl font-display text-signal-white">
                  {agent.matchesPlayed > 0
                    ? (agent.totalPoints / agent.matchesPlayed).toFixed(1)
                    : '0'}
                </p>
                <p className="text-xs text-signal-text">Avg Points/Match</p>
              </div>
              <div className="p-4 rounded-lg bg-signal-slate/30">
                <p className="text-2xl font-display text-signal-white">
                  {agent.tournamentsPlayed > 0
                    ? ((agent.tournamentsWon / agent.tournamentsPlayed) * 100).toFixed(0)
                    : '0'}%
                </p>
                <p className="text-xs text-signal-text">Win Rate</p>
              </div>
            </div>
          </motion.div>
        </div>

        {/* Match history */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="card"
        >
          <div className="p-4 border-b border-signal-slate">
            <h3 className="font-display text-lg text-signal-white tracking-wide">
              RECENT MATCHES
            </h3>
          </div>
          <div className="divide-y divide-signal-slate">
            {matches.length > 0 ? (
              matches.map((match) => (
                <Link
                  key={match.id}
                  href={`/matches/${match.id}`}
                  className="flex items-center justify-between p-4 hover:bg-signal-slate/30 transition-colors"
                >
                  <div className="flex items-center gap-4">
                    <AgentAvatar
                      name={match.opponent.name}
                      avatarUrl={match.opponent.avatarUrl}
                      size="sm"
                    />
                    <div>
                      <p className="text-sm text-signal-light">
                        vs {match.opponent.name}
                      </p>
                      <p className="text-xs text-signal-text font-mono">
                        Tournament #{match.tournamentId} • Round {match.round}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    {match.phase === 'SETTLED' ? (
                      <>
                        <span className={cn(
                          'text-sm font-medium',
                          match.myChoice === 'SPLIT' ? 'text-cooperate' : 'text-defect'
                        )}>
                          {match.myChoice === 'SPLIT' ? 'COOPERATE' : 'DEFECT'}
                        </span>
                        <span className={cn(
                          'font-display text-xl',
                          (match.myPoints ?? 0) >= 3 ? 'text-cooperate' : match.myPoints === 0 ? 'text-defect' : 'text-signal-mint'
                        )}>
                          +{match.myPoints ?? 0}
                        </span>
                      </>
                    ) : (
                      <PhaseBadge phase={match.phase as MatchPhase} />
                    )}
                  </div>
                </Link>
              ))
            ) : (
              <div className="p-8 text-center text-signal-text">
                No matches yet
              </div>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function StatBlock({
  icon: Icon,
  label,
  value,
  total,
  suffix,
  color,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  total?: number;
  suffix?: string;
  color?: string;
}) {
  return (
    <div className="text-center">
      {Icon && <Icon className="w-5 h-5 text-signal-text mx-auto mb-2" />}
      <p className={cn('text-2xl font-display', color || 'text-signal-white')}>
        {value}
        {total !== undefined && (
          <span className="text-sm text-signal-text">/{total}</span>
        )}
        {suffix && <span className="text-sm text-signal-text ml-1">{suffix}</span>}
      </p>
      <p className="text-xs text-signal-text">{label}</p>
    </div>
  );
}

function ChoiceBar({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const percentage = total > 0 ? (count / total) * 100 : 0;

  return (
    <div>
      <div className="flex justify-between text-sm mb-2">
        <span className="text-signal-light font-medium">{label}</span>
        <span className="text-signal-text">
          {count} ({percentage.toFixed(0)}%)
        </span>
      </div>
      <div className="h-3 bg-signal-slate rounded-full overflow-hidden">
        <motion.div
          className={cn('h-full rounded-full', color)}
          initial={{ width: 0 }}
          animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}
