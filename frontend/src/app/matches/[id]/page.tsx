'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { MatchArena } from '@/components/match/MatchArena';
import { NegotiationFeed } from '@/components/match/NegotiationFeed';
import { BettingPanel } from '@/components/match/BettingPanel';
import { getMatch, getBettingPool } from '@/lib/api';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { Match, BettingOdds } from '@/types';

export default function MatchDetailPage() {
  const params = useParams();
  const id = Number(params.id);

  const [match, setMatch] = useState<Match | null>(null);
  const [bettingData, setBettingData] = useState<{
    odds: BettingOdds;
    totalPool: string;
    outcomePools: Record<string, string>;
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const { subscribe } = useWebSocket();

  useEffect(() => {
    async function fetchData() {
      try {
        const [matchRes, bettingRes] = await Promise.allSettled([
          getMatch(id),
          getBettingPool(id),
        ]);

        if (matchRes.status === 'fulfilled') {
          setMatch(matchRes.value.match);
        }

        if (bettingRes.status === 'fulfilled') {
          setBettingData({
            odds: bettingRes.value.odds,
            totalPool: bettingRes.value.pool.totalPool,
            outcomePools: bettingRes.value.pool.outcomePools,
          });
        }
      } catch (err) {
        console.error('Failed to fetch match:', err);
      } finally {
        setLoading(false);
      }
    }

    if (id) {
      fetchData();
    }
  }, [id]);

  // Subscribe to real-time updates
  useEffect(() => {
    const unsubPhase = subscribe('PHASE_CHANGED', (event) => {
      if (event.matchId === id) {
        setMatch((prev) =>
          prev ? { ...prev, phase: event.phase as Match['phase'], phaseDeadline: event.phaseDeadline as number } : null
        );
      }
    });

    const unsubMessage = subscribe('MESSAGE', (event) => {
      if (event.matchId === id) {
        setMatch((prev) => {
          if (!prev) return null;
          return {
            ...prev,
            messages: [...prev.messages, event as unknown as Match['messages'][0]],
          };
        });
      }
    });

    const unsubCommit = subscribe('CHOICE_COMMITTED', (event) => {
      if (event.matchId === id) {
        setMatch((prev) => {
          if (!prev) return null;
          const agent = event.agent as string;
          return {
            ...prev,
            commitA: agent.toLowerCase() === prev.agentA.address.toLowerCase() ? true : prev.commitA,
            commitB: agent.toLowerCase() === prev.agentB.address.toLowerCase() ? true : prev.commitB,
          };
        });
      }
    });

    const unsubSettled = subscribe('MATCH_SETTLED', (event) => {
      if (event.matchId === id) {
        setMatch((prev) =>
          prev
            ? {
                ...prev,
                phase: 'SETTLED',
                choiceA: event.choiceA as Match['choiceA'],
                choiceB: event.choiceB as Match['choiceB'],
                pointsA: event.pointsA as number,
                pointsB: event.pointsB as number,
              }
            : null
        );
      }
    });

    return () => {
      unsubPhase();
      unsubMessage();
      unsubCommit();
      unsubSettled();
    };
  }, [id, subscribe]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-signal-text">Loading...</div>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="font-display text-3xl text-signal-white mb-4">
            Match Not Found
          </h1>
          <Link href="/" className="btn-secondary">
            Back to Arena
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Back link */}
        <Link
          href={`/tournaments/${match.tournamentId}`}
          className="inline-flex items-center gap-2 text-signal-text hover:text-signal-light mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Tournament
        </Link>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <MatchArena match={match} />
            <NegotiationFeed
              messages={match.messages}
              agentA={match.agentA}
              agentB={match.agentB}
            />
          </div>

          <div>
            {bettingData && (
              <BettingPanel
                agentA={match.agentA}
                agentB={match.agentB}
                odds={bettingData.odds}
                totalPool={bettingData.totalPool}
                outcomePools={bettingData.outcomePools}
                bettingOpen={match.bettingOpen}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
