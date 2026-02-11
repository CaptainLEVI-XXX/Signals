'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { MatchArena } from '@/components/match/MatchArena';
import { NegotiationFeed } from '@/components/match/NegotiationFeed';
import { BettingPanel } from '@/components/match/BettingPanel';
import { getMatch, getBettingPool } from '@/lib/api';
import { adaptOrchestratorMatch, adaptMatchStartedEvent, adaptNegotiationMessage, mapPhase, mapChoice } from '@/lib/adapters';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAgentNames } from '@/hooks/useAgentNames';
import type { Match, BettingOdds } from '@/types';

export default function MatchDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = Number(params.id);

  const [match, setMatch] = useState<Match | null>(null);
  const [bettingData, setBettingData] = useState<{
    odds: BettingOdds;
    totalPool: string;
    outcomePools: Record<string, string>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  const { subscribe } = useWebSocket();
  const matchSetFromRest = useRef(false);

  // ─── REST fetch on mount ────────────────────────────
  useEffect(() => {
    async function fetchData() {
      try {
        const [matchRes, bettingRes] = await Promise.allSettled([
          getMatch(id),
          getBettingPool(id),
        ]);

        if (matchRes.status === 'fulfilled') {
          const adapted = adaptOrchestratorMatch(matchRes.value.match);
          setMatch(adapted);
          matchSetFromRest.current = true;
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
        // If REST didn't find the match, wait a moment for WS events
        // before showing not-found (match might arrive via WS)
        if (!matchSetFromRest.current) {
          setTimeout(() => {
            setNotFound((prev) => {
              // Only show not-found if match still hasn't been populated
              return prev;
            });
          }, 3000);
        }
      }
    }

    if (id) {
      fetchData();
    }
  }, [id]);

  // ─── WebSocket subscriptions (always active) ────────
  // These populate/update match state from live events,
  // which also serves as a fallback when REST fails.
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    // MATCH_STARTED → create match state if we don't have it
    unsubs.push(
      subscribe('MATCH_STARTED', (event) => {
        const payload = event.payload;
        if (payload.matchId === id) {
          setMatch((prev) => {
            if (prev) return prev; // Already have data from REST
            return adaptMatchStartedEvent(payload);
          });
          setNotFound(false);
        }
      })
    );

    // NEGOTIATION_MESSAGE → append to messages
    unsubs.push(
      subscribe('NEGOTIATION_MESSAGE', (event) => {
        const payload = event.payload;
        if (payload.matchId === id) {
          const adapted = adaptNegotiationMessage(payload);
          setMatch((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              messages: [...prev.messages, adapted],
            };
          });
        }
      })
    );

    // CHOICE_PHASE_STARTED → update phase to COMMITTING
    unsubs.push(
      subscribe('CHOICE_PHASE_STARTED', (event) => {
        const payload = event.payload;
        if (payload.matchId === id) {
          setMatch((prev) =>
            prev
              ? {
                  ...prev,
                  phase: mapPhase('AWAITING_CHOICES'),
                  phaseDeadline: Date.now() + ((payload.deadline as number) || 15000),
                }
              : null
          );
        }
      })
    );

    // CHOICE_LOCKED → update commitA/commitB
    unsubs.push(
      subscribe('CHOICE_LOCKED', (event) => {
        const payload = event.payload;
        if (payload.matchId === id) {
          setMatch((prev) => {
            if (!prev) return null;
            const agent = (payload.agent as string).toLowerCase();
            return {
              ...prev,
              commitA: agent === prev.agentA.address.toLowerCase() ? true : prev.commitA,
              commitB: agent === prev.agentB.address.toLowerCase() ? true : prev.commitB,
              commitHashA: agent === prev.agentA.address.toLowerCase() ? (payload.commitHash as string) : prev.commitHashA,
              commitHashB: agent === prev.agentB.address.toLowerCase() ? (payload.commitHash as string) : prev.commitHashB,
            };
          });
        }
      })
    );

    // CHOICES_REVEALED → show choices and result
    unsubs.push(
      subscribe('CHOICES_REVEALED', (event) => {
        const payload = event.payload;
        if (payload.matchId === id) {
          setMatch((prev) =>
            prev
              ? {
                  ...prev,
                  phase: 'REVEALING' as const,
                  choiceA: mapChoice(payload.choiceA as number),
                  choiceB: mapChoice(payload.choiceB as number),
                  result: payload.result as number,
                }
              : null
          );
        }
      })
    );

    // MATCH_CONFIRMED → mark as settled
    unsubs.push(
      subscribe('MATCH_CONFIRMED', (event) => {
        const payload = event.payload;
        if (payload.matchId === id) {
          setMatch((prev) =>
            prev
              ? {
                  ...prev,
                  phase: 'SETTLED' as const,
                  txHash: payload.txHash as string,
                }
              : null
          );
        }
      })
    );

    // After 3 seconds, if we still have no match data, mark as not found
    const timeout = setTimeout(() => {
      setMatch((current) => {
        if (!current) setNotFound(true);
        return current;
      });
    }, 3000);

    return () => {
      unsubs.forEach((fn) => fn());
      clearTimeout(timeout);
    };
  }, [id, subscribe]);

  // Resolve on-chain agent names (must be called before any early returns)
  const defaultAgent = { address: '', name: '' };
  const { nameA, nameB } = useAgentNames(
    match?.agentA ?? defaultAgent,
    match?.agentB ?? defaultAgent,
  );

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-signal-text">Loading...</div>
      </div>
    );
  }

  if (!match && !notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-signal-text font-mono text-sm">
          Waiting for match data...
        </div>
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
          <p className="text-signal-text text-sm mb-6">
            This match may have ended. Check the arena for active matches.
          </p>
          <Link href="/" className="btn-secondary">
            Back to Arena
          </Link>
        </div>
      </div>
    );
  }

  const resolvedAgentA = { ...match.agentA, name: nameA };
  const resolvedAgentB = { ...match.agentB, name: nameB };
  const resolvedMatch = { ...match, agentA: resolvedAgentA, agentB: resolvedAgentB };

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Back link */}
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-2 text-signal-text hover:text-signal-light mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <MatchArena match={resolvedMatch} />
            <NegotiationFeed
              messages={match.messages}
              agentA={resolvedAgentA}
              agentB={resolvedAgentB}
            />
          </div>

          <div>
            <BettingPanel
              matchId={id}
              agentA={resolvedAgentA}
              agentB={resolvedAgentB}
              odds={bettingData?.odds ?? { BOTH_SPLIT: 0, A_STEALS: 0, B_STEALS: 0, BOTH_STEAL: 0 }}
              totalPool={bettingData?.totalPool ?? '0'}
              outcomePools={bettingData?.outcomePools ?? {}}
              bettingOpen={match.bettingOpen}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
