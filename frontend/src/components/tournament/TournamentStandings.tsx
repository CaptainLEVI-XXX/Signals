'use client';

import { motion } from 'framer-motion';
import { Crown, Medal } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { cn, formatAddress } from '@/lib/utils';

interface StandingsEntry {
  address: string;
  name: string;
  points: number;
  buchholz: number;
  avatarUrl?: string;
  matchesPlayed?: number;
}

interface TournamentStandingsProps {
  standings: StandingsEntry[];
  className?: string;
}

export function TournamentStandings({ standings, className }: TournamentStandingsProps) {
  return (
    <div className={cn('card', className)}>
      <div className="p-4 border-b border-signal-slate">
        <h3 className="font-display text-lg text-signal-white tracking-wide">
          STANDINGS
        </h3>
      </div>

      <div className="divide-y divide-signal-slate">
        {standings.map((player, index) => {
          const rank = index + 1;

          return (
            <motion.div
              key={player.address}
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              className={cn(
                'flex items-center gap-4 p-4 hover:bg-signal-slate/30 transition-colors',
                rank === 1 && 'bg-signal-mint/5',
                rank === 2 && 'bg-gray-400/5',
                rank === 3 && 'bg-amber-700/5'
              )}
            >
              {/* Rank */}
              <div className="w-8 flex items-center justify-center">
                {rank === 1 && <Crown className="w-5 h-5 text-signal-mint" />}
                {rank === 2 && <Medal className="w-5 h-5 text-gray-400" />}
                {rank === 3 && <Medal className="w-5 h-5 text-amber-600" />}
                {rank > 3 && (
                  <span className="text-lg font-display text-signal-text">{rank}</span>
                )}
              </div>

              {/* Avatar + Name */}
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <AgentAvatar
                  name={player.name}
                  avatarUrl={player.avatarUrl}
                  size="sm"
                />
                <div className="min-w-0">
                  <p className="font-medium text-signal-light truncate">
                    {player.name}
                  </p>
                  <p className="text-xs text-signal-text font-mono">
                    {formatAddress(player.address)}
                  </p>
                </div>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-6 text-right">
                {player.matchesPlayed !== undefined && (
                  <div>
                    <p className="text-xs text-signal-text uppercase">Matches</p>
                    <p className="font-display text-lg text-signal-light">
                      {player.matchesPlayed}
                    </p>
                  </div>
                )}
                <div>
                  <p className="text-xs text-signal-text uppercase">Points</p>
                  <p className={cn(
                    'font-display text-2xl',
                    rank === 1 ? 'text-signal-mint' : 'text-signal-light'
                  )}>
                    {player.points}
                  </p>
                </div>
              </div>
            </motion.div>
          );
        })}

        {standings.length === 0 && (
          <div className="p-8 text-center text-signal-text">
            No players yet
          </div>
        )}
      </div>
    </div>
  );
}
