'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { Match } from '@/types';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getActiveMatches, getQueue } from '@/lib/api';
import {
  adaptOrchestratorMatch,
  adaptMatchStartedEvent,
  adaptChoicesRevealedToSettledMatch,
  adaptNegotiationMessage,
  mapPhase,
} from '@/lib/adapters';

const MAX_RECENT_RESULTS = 10;
const CHOICE_DURATION = 15_000;

export interface ArenaData {
  activeMatches: Match[];
  featuredMatch: Match | null;
  queueSize: number;
  tournamentQueueSize: number;
  recentResults: Match[];
  isConnected: boolean;
  isLoading: boolean;
}

export function useArenaData(): ArenaData {
  const [activeMatches, setActiveMatches] = useState<Match[]>([]);
  const [queueSize, setQueueSize] = useState(0);
  const [tournamentQueueSize, setTournamentQueueSize] = useState(0);
  const [recentResults, setRecentResults] = useState<Match[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const initialFetchDone = useRef(false);

  const { isConnected, subscribe } = useWebSocket();

  // ─── Initial REST fetch ──────────────────────────────

  const fetchInitialData = useCallback(async () => {
    try {
      const [matchesRes, queueRes] = await Promise.all([
        getActiveMatches().catch(() => ({ matches: [] })),
        getQueue().catch(() => ({ size: 0, agents: [] })),
      ]);

      setActiveMatches(matchesRes.matches.map(adaptOrchestratorMatch));
      setQueueSize(queueRes.size);
    } catch {
      // Silently handle — data will arrive via WS
    } finally {
      setIsLoading(false);
      initialFetchDone.current = true;
    }
  }, []);

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  // ─── WebSocket subscriptions ─────────────────────────

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    // MATCH_STARTED → add to activeMatches
    unsubs.push(
      subscribe('MATCH_STARTED', (event) => {
        const match = adaptMatchStartedEvent(event.payload);
        setActiveMatches((prev) => {
          if (prev.some((m) => m.id === match.id)) return prev;
          return [...prev, match];
        });
      })
    );

    // NEGOTIATION_MESSAGE → append message to matching active match
    unsubs.push(
      subscribe('NEGOTIATION_MESSAGE', (event) => {
        const matchId = event.payload.matchId as number;
        const adapted = adaptNegotiationMessage(event.payload);
        setActiveMatches((prev) =>
          prev.map((m) =>
            m.id === matchId
              ? { ...m, messages: [...m.messages, adapted] }
              : m
          )
        );
      })
    );

    // CHOICE_PHASE_STARTED → update phase to COMMITTING
    unsubs.push(
      subscribe('CHOICE_PHASE_STARTED', (event) => {
        const { matchId, deadline } = event.payload as { matchId: number; deadline: number };
        setActiveMatches((prev) =>
          prev.map((m) =>
            m.id === matchId
              ? { ...m, phase: mapPhase('AWAITING_CHOICES'), phaseDeadline: Date.now() + (deadline || CHOICE_DURATION) }
              : m
          )
        );
      })
    );

    // CHOICE_LOCKED → update commitA/commitB
    unsubs.push(
      subscribe('CHOICE_LOCKED', (event) => {
        const { matchId, agent, commitHash } = event.payload as {
          matchId: number;
          agent: string;
          commitHash: string;
        };
        setActiveMatches((prev) =>
          prev.map((m) => {
            if (m.id !== matchId) return m;
            const isA = agent.toLowerCase() === m.agentA.address.toLowerCase();
            return {
              ...m,
              commitA: isA ? true : m.commitA,
              commitB: isA ? m.commitB : true,
              commitHashA: isA ? commitHash : m.commitHashA,
              commitHashB: isA ? m.commitHashB : commitHash,
            };
          })
        );
      })
    );

    // CHOICES_REVEALED → remove from active, add to recentResults
    unsubs.push(
      subscribe('CHOICES_REVEALED', (event) => {
        const matchId = event.payload.matchId as number;
        const settledMatch = adaptChoicesRevealedToSettledMatch(event.payload);

        setActiveMatches((prev) => prev.filter((m) => m.id !== matchId));
        setRecentResults((prev) => [settledMatch, ...prev].slice(0, MAX_RECENT_RESULTS));
      })
    );

    // CHOICE_TIMEOUT → remove from active
    unsubs.push(
      subscribe('CHOICE_TIMEOUT', (event) => {
        const matchId = event.payload.matchId as number;
        setActiveMatches((prev) => prev.filter((m) => m.id !== matchId));
      })
    );

    // MATCH_CONFIRMED → remove from active (if still there)
    unsubs.push(
      subscribe('MATCH_CONFIRMED', (event) => {
        const matchId = event.payload.matchId as number;
        setActiveMatches((prev) => prev.filter((m) => m.id !== matchId));
      })
    );

    // QUEUE_UPDATE → update queueSize
    unsubs.push(
      subscribe('QUEUE_UPDATE', (event) => {
        const size = (event.payload.size ?? event.payload.queueSize) as number | undefined;
        if (size !== undefined) {
          setQueueSize(size);
        }
      })
    );

    // TOURNAMENT_QUEUE_UPDATE → update tournamentQueueSize
    unsubs.push(
      subscribe('TOURNAMENT_QUEUE_UPDATE', (event) => {
        const size = event.payload.size as number | undefined;
        if (size !== undefined) {
          setTournamentQueueSize(size);
        }
      })
    );

    return () => {
      unsubs.forEach((fn) => fn());
    };
  }, [subscribe]);

  const featuredMatch = activeMatches[0] ?? null;

  return {
    activeMatches,
    featuredMatch,
    queueSize,
    tournamentQueueSize,
    recentResults,
    isConnected,
    isLoading,
  };
}
