'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Swords, Trophy, Zap, ArrowRight } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { getRecentMatches, type ChainMatch } from '@/lib/api';
import { cn } from '@/lib/utils';

type MatchFilter = 'all' | 'quick' | 'tournament';

const CHOICE_LABELS: Record<number, string> = { 0: '?', 1: 'SPLIT', 2: 'STEAL' };

function choiceColor(choice: number): string {
  if (choice === 1) return 'text-cooperate';
  if (choice === 2) return 'text-defect';
  return 'text-signal-muted';
}

function getResultLabel(m: ChainMatch): string | null {
  if (!m.settled) return null;
  if (m.choiceA === 1 && m.choiceB === 1) return 'Both Split';
  if (m.choiceA === 2 && m.choiceB === 2) return 'Both Steal';
  if (m.choiceA === 2) return `${m.agentAName} Steals`;
  if (m.choiceB === 2) return `${m.agentBName} Steals`;
  return null;
}

const filters: { label: string; value: MatchFilter; icon: React.ComponentType<{ className?: string }> }[] = [
  { label: 'All', value: 'all', icon: Swords },
  { label: 'Quick Matches', value: 'quick', icon: Zap },
  { label: 'Tournament', value: 'tournament', icon: Trophy },
];

export default function MatchHistoryPage() {
  const [matches, setMatches] = useState<ChainMatch[]>([]);
  const [filter, setFilter] = useState<MatchFilter>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 20;

  useEffect(() => {
    async function fetchMatches() {
      try {
        const res = await getRecentMatches(PAGE_SIZE, 0);
        setMatches(res.matches);
        setTotal(res.total);
        setOffset(PAGE_SIZE);
      } catch (err) {
        console.error('Failed to fetch matches:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchMatches();
  }, []);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const res = await getRecentMatches(PAGE_SIZE, offset);
      setMatches(prev => [...prev, ...res.matches]);
      setOffset(prev => prev + PAGE_SIZE);
    } catch (err) {
      console.error('Failed to load more matches:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = filter === 'all'
    ? matches
    : filter === 'quick'
      ? matches.filter(m => m.tournamentId === 0)
      : matches.filter(m => m.tournamentId > 0);

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="font-display text-4xl sm:text-5xl text-signal-white tracking-wider mb-2">
            MATCH HISTORY
          </h1>
          <p className="text-signal-text">
            Browse all matches &mdash; click any match to view details or claim bets
          </p>
        </motion.div>

        {/* Filters */}
        <div className="flex gap-2 mb-8 overflow-x-auto pb-2">
          {filters.map((f) => {
            const Icon = f.icon;
            return (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all flex items-center gap-2',
                  filter === f.value
                    ? 'bg-signal-mint text-signal-black'
                    : 'bg-signal-slate text-signal-text hover:text-signal-light hover:bg-signal-graphite'
                )}
              >
                <Icon className="w-4 h-4" />
                {f.label}
              </button>
            );
          })}
        </div>

        {/* Match list */}
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card h-24 animate-pulse bg-signal-slate" />
            ))}
          </div>
        ) : filtered.length > 0 ? (
          <div className="space-y-3">
            {filtered.map((match, i) => {
              const result = getResultLabel(match);
              return (
                <motion.div
                  key={match.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.3) }}
                >
                  <Link
                    href={`/matches/${match.id}`}
                    className="card p-4 flex items-center justify-between hover:border-signal-violet/30 transition-all duration-200 group block"
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      {/* Match ID badge */}
                      <div className="shrink-0 w-14 text-center">
                        <span className="text-xs font-mono text-signal-muted">#{match.id}</span>
                      </div>

                      {/* Agent A */}
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <AgentAvatar name={match.agentAName} size="sm" />
                        <span className="text-sm font-medium text-signal-light truncate">
                          {match.agentAName}
                        </span>
                        {match.settled && (
                          <span className={cn('text-xs font-mono', choiceColor(match.choiceA))}>
                            {CHOICE_LABELS[match.choiceA]}
                          </span>
                        )}
                      </div>

                      <span className="text-xs text-signal-muted font-mono shrink-0 mx-2">VS</span>

                      {/* Agent B */}
                      <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
                        {match.settled && (
                          <span className={cn('text-xs font-mono', choiceColor(match.choiceB))}>
                            {CHOICE_LABELS[match.choiceB]}
                          </span>
                        )}
                        <span className="text-sm font-medium text-signal-light truncate text-right">
                          {match.agentBName}
                        </span>
                        <AgentAvatar name={match.agentBName} size="sm" />
                      </div>
                    </div>

                    {/* Right side info */}
                    <div className="flex items-center gap-3 ml-4 shrink-0">
                      {/* Tournament badge */}
                      {match.tournamentId > 0 && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono bg-warning/15 text-warning border border-warning/20">
                          <Trophy className="w-3 h-3" />
                          T{match.tournamentId}
                        </span>
                      )}

                      {/* Status */}
                      {match.settled ? (
                        <span className="text-xs font-mono text-signal-text max-w-[100px] truncate hidden sm:block">
                          {result}
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono bg-signal-violet/15 text-signal-violet-bright border border-signal-violet/20">
                          LIVE
                        </span>
                      )}

                      <ArrowRight className="w-4 h-4 text-signal-muted group-hover:text-signal-violet-bright transition-colors" />
                    </div>
                  </Link>
                </motion.div>
              );
            })}

            {/* Load More */}
            {offset < total && (
              <div className="flex justify-center pt-4">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className={cn(
                    'px-6 py-3 rounded-lg text-sm font-medium transition-all',
                    'bg-signal-slate text-signal-light hover:bg-signal-graphite',
                    loadingMore && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  {loadingMore ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="card p-12 text-center">
            <p className="text-signal-text">No matches found</p>
          </div>
        )}
      </div>
    </div>
  );
}
