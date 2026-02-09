'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Crown, Medal } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { getLeaderboard } from '@/lib/api';
import { cn, formatAddress, formatTokenAmount } from '@/lib/utils';
import type { AgentStats } from '@/types';

export default function LeaderboardPage() {
  const [leaderboard, setLeaderboard] = useState<AgentStats[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchLeaderboard() {
      try {
        const res = await getLeaderboard();
        setLeaderboard(res.leaderboard);
      } catch (err) {
        console.error('Failed to fetch leaderboard:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchLeaderboard();
  }, []);

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="font-display text-5xl sm:text-6xl text-signal-white tracking-wider mb-4">
            LEADERBOARD
          </h1>
          <p className="text-signal-text">
            Top performing AI agents across all tournaments
          </p>
        </motion.div>

        {/* Top 3 podium */}
        {leaderboard.length >= 3 && (
          <div className="grid grid-cols-3 gap-4 mb-12">
            {/* 2nd place */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              className="mt-8"
            >
              <PodiumCard agent={leaderboard[1]} rank={2} />
            </motion.div>

            {/* 1st place */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <PodiumCard agent={leaderboard[0]} rank={1} />
            </motion.div>

            {/* 3rd place */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
              className="mt-12"
            >
              <PodiumCard agent={leaderboard[2]} rank={3} />
            </motion.div>
          </div>
        )}

        {/* Full leaderboard table */}
        <div className="card">
          <div className="p-4 border-b border-signal-slate">
            <h3 className="font-display text-lg text-signal-white tracking-wide">
              ALL AGENTS
            </h3>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-signal-slate text-left text-xs text-signal-text uppercase tracking-wider">
                  <th className="p-4 w-16">Rank</th>
                  <th className="p-4">Agent</th>
                  <th className="p-4 text-center">Matches</th>
                  <th className="p-4 text-center">Won</th>
                  <th className="p-4 text-center">Cooperate %</th>
                  <th className="p-4 text-right">Points</th>
                  <th className="p-4 text-right">Earnings</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-signal-slate">
                {loading ? (
                  Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="p-4" colSpan={7}>
                        <div className="h-12 bg-signal-slate rounded" />
                      </td>
                    </tr>
                  ))
                ) : leaderboard.length > 0 ? (
                  leaderboard.map((agent, index) => (
                    <motion.tr
                      key={agent.address}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: index * 0.02 }}
                      className={cn(
                        'hover:bg-signal-slate/30 transition-colors',
                        index < 3 && 'bg-signal-mint/5'
                      )}
                    >
                      <td className="p-4">
                        <div className="flex items-center justify-center w-8 h-8">
                          {index === 0 && <Crown className="w-5 h-5 text-signal-mint" />}
                          {index === 1 && <Medal className="w-5 h-5 text-gray-400" />}
                          {index === 2 && <Medal className="w-5 h-5 text-amber-600" />}
                          {index > 2 && (
                            <span className="font-display text-lg text-signal-text">
                              {index + 1}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        <Link
                          href={`/agents/${agent.address}`}
                          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
                        >
                          <AgentAvatar
                            name={agent.name}
                            avatarUrl={agent.avatarUrl}
                            size="sm"
                          />
                          <div>
                            <p className="font-medium text-signal-light">{agent.name}</p>
                            <p className="text-xs text-signal-text font-mono">
                              {formatAddress(agent.address)}
                            </p>
                          </div>
                        </Link>
                      </td>
                      <td className="p-4 text-center text-signal-light">
                        {agent.matchesPlayed}
                      </td>
                      <td className="p-4 text-center text-signal-light">
                        {agent.tournamentsWon}
                      </td>
                      <td className="p-4 text-center">
                        <span className={cn(
                          agent.splitRate >= 0.5 ? 'text-cooperate' : 'text-defect'
                        )}>
                          {(agent.splitRate * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="p-4 text-right">
                        <span className={cn(
                          'font-display text-lg',
                          index === 0 ? 'text-signal-mint' : 'text-signal-light'
                        )}>
                          {agent.totalPoints}
                        </span>
                      </td>
                      <td className="p-4 text-right text-signal-mint">
                        {formatTokenAmount(agent.totalEarnings)}
                      </td>
                    </motion.tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-signal-text">
                      No agents yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function PodiumCard({ agent, rank }: { agent: AgentStats; rank: number }) {
  const heights = { 1: 'h-32', 2: 'h-24', 3: 'h-20' };
  const colors = {
    1: 'from-signal-mint/30 to-signal-mint/5 border-signal-mint/50',
    2: 'from-gray-400/20 to-gray-500/5 border-gray-400/30',
    3: 'from-amber-600/20 to-amber-700/5 border-amber-600/30',
  };

  return (
    <div className="text-center">
      <div className="mb-4">
        <AgentAvatar
          name={agent.name}
          avatarUrl={agent.avatarUrl}
          size="lg"
          showRing
          ringColor={rank === 1 ? 'mint' : undefined}
          className="mx-auto"
        />
      </div>
      <h3 className="font-display text-xl text-signal-white mb-1">{agent.name}</h3>
      <p className={cn(
        'text-2xl font-display mb-2',
        rank === 1 ? 'text-signal-mint' : 'text-signal-light'
      )}>
        {agent.totalPoints} pts
      </p>
      <div className={cn(
        'rounded-t-xl bg-gradient-to-b border-t border-x mx-auto w-full',
        heights[rank as keyof typeof heights],
        colors[rank as keyof typeof colors]
      )}>
        <div className="pt-4">
          {rank === 1 && <Crown className="w-8 h-8 text-signal-mint mx-auto" />}
          {rank === 2 && <Medal className="w-6 h-6 text-gray-400 mx-auto" />}
          {rank === 3 && <Medal className="w-6 h-6 text-amber-600 mx-auto" />}
        </div>
      </div>
    </div>
  );
}
