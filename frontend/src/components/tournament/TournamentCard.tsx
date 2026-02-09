'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Users, Clock, Trophy } from 'lucide-react';
import { PhaseBadge } from '@/components/common/PhaseBadge';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { formatTokenAmount } from '@/lib/utils';
import type { Tournament } from '@/types';

interface TournamentCardProps {
  tournament: Tournament;
  index?: number;
}

export function TournamentCard({ tournament, index = 0 }: TournamentCardProps) {
  const { id, state = 'REGISTRATION', players = [], entryStake, registrationDeadline = 0, currentRound, totalRounds } = tournament;

  const isRegistration = state === 'REGISTRATION';
  const isActive = state === 'ACTIVE' || state === 'FINAL';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: index * 0.1 }}
    >
      <Link href={`/tournaments/${id}`}>
        <div className="card-interactive p-5">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-display text-2xl text-signal-white">
                  TOURNAMENT #{id}
                </h3>
                <PhaseBadge state={state} />
              </div>
              <p className="text-sm text-signal-text">
                Entry: <span className="text-signal-mint">{formatTokenAmount(entryStake)} ARENA</span>
              </p>
            </div>

            {isRegistration && (
              <CountdownTimer
                deadline={registrationDeadline}
                size="sm"
              />
            )}
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="flex items-center gap-2 text-sm">
              <Users className="w-4 h-4 text-signal-text" />
              <span className="text-signal-light">{players.length}</span>
              <span className="text-signal-text">/8 Players</span>
            </div>

            {isActive && (
              <div className="flex items-center gap-2 text-sm">
                <Clock className="w-4 h-4 text-signal-text" />
                <span className="text-signal-light">Round {currentRound}</span>
                <span className="text-signal-text">/{totalRounds}</span>
              </div>
            )}

            <div className="flex items-center gap-2 text-sm">
              <Trophy className="w-4 h-4 text-signal-mint" />
              <span className="text-signal-mint">
                {formatTokenAmount(BigInt(entryStake) * BigInt(players.length))} ARENA
              </span>
            </div>
          </div>

          {/* Player avatars */}
          {players.length > 0 && (
            <div className="flex items-center gap-1">
              {players.slice(0, 6).map((player, i) => (
                <div
                  key={player.address}
                  className="w-8 h-8 rounded-lg bg-gradient-to-br from-signal-slate to-signal-graphite flex items-center justify-center text-xs font-display text-signal-light border border-signal-slate"
                  style={{ marginLeft: i > 0 ? '-8px' : 0, zIndex: 6 - i }}
                >
                  {player.name.slice(0, 2).toUpperCase()}
                </div>
              ))}
              {players.length > 6 && (
                <div
                  className="w-8 h-8 rounded-lg bg-signal-slate flex items-center justify-center text-xs font-mono text-signal-text border border-signal-slate"
                  style={{ marginLeft: '-8px' }}
                >
                  +{players.length - 6}
                </div>
              )}
            </div>
          )}
        </div>
      </Link>
    </motion.div>
  );
}
