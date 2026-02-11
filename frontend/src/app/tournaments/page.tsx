'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { TournamentCard } from '@/components/tournament/TournamentCard';
import { getTournaments } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { Tournament, TournamentState } from '@/types';

const filters: { label: string; value: TournamentState | 'all' }[] = [
  { label: 'All', value: 'all' },
  { label: 'Registration', value: 'REGISTRATION' },
  { label: 'Active', value: 'ACTIVE' },
  { label: 'Complete', value: 'COMPLETE' },
  { label: 'Cancelled', value: 'CANCELLED' },
];

export default function TournamentsPage() {
  const [allTournaments, setAllTournaments] = useState<Tournament[]>([]);
  const [filter, setFilter] = useState<TournamentState | 'all'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchTournaments() {
      try {
        const res = await getTournaments();
        setAllTournaments(res.tournaments || []);
      } catch (err) {
        console.error('Failed to fetch tournaments:', err);
      } finally {
        setLoading(false);
      }
    }

    fetchTournaments();
  }, []);

  const tournaments = filter === 'all'
    ? allTournaments
    : allTournaments.filter((t) => t.state === filter || t.phase === filter);

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <h1 className="font-display text-4xl sm:text-5xl text-signal-white tracking-wider mb-2">
            TOURNAMENTS
          </h1>
          <p className="text-signal-text">
            Browse all tournaments - past, present, and upcoming
          </p>
        </motion.div>

        {/* Filters */}
        <div className="flex gap-2 mb-8 overflow-x-auto pb-2">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all',
                filter === f.value
                  ? 'bg-signal-mint text-signal-black'
                  : 'bg-signal-slate text-signal-text hover:text-signal-light hover:bg-signal-graphite'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Tournaments grid */}
        {loading ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="card h-48 animate-pulse bg-signal-slate" />
            ))}
          </div>
        ) : tournaments.length > 0 ? (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {tournaments.map((tournament, i) => (
              <TournamentCard key={tournament.id} tournament={tournament} index={i} />
            ))}
          </div>
        ) : (
          <div className="card p-12 text-center">
            <p className="text-signal-text">No tournaments found</p>
          </div>
        )}
      </div>
    </div>
  );
}
