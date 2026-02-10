import type { Match, Tournament, AgentStats, BettingPool, BettingOdds, BetOutcome } from '@/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

async function fetchAPI<T>(endpoint: string): Promise<T> {
  const res = await fetch(`${API_BASE}${endpoint}`, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return res.json();
}

// Orchestrator wire format for match state
export interface OrchestratorMatchState {
  matchId: number;
  agentA: string;
  agentB: string;
  agentAName: string;
  agentBName: string;
  tournamentId: number;
  state: string;
  messages: Array<{ from: string; fromName: string; message: string; timestamp: number }>;
  choiceALocked: boolean;
  choiceBLocked: boolean;
  commitHashA: string | null;
  commitHashB: string | null;
}

// Active matches
export async function getActiveMatches() {
  return fetchAPI<{ matches: OrchestratorMatchState[] }>('/matches/active');
}

// Health
export async function getHealth() {
  return fetchAPI<{
    status: string;
    connections: { agents: number; spectators: number; bettors: number; total: number };
    queueSize: number;
    activeTournaments: number[];
  }>('/health');
}

// Match (returns raw orchestrator format when source=engine)
export async function getMatch(id: number) {
  return fetchAPI<{ source: string; match: OrchestratorMatchState }>(`/match/${id}`);
}

export async function getMatchOdds(id: number) {
  return fetchAPI<{
    matchId: number;
    pool: string;
    odds: { bothSplit: string; aSteal: string; bSteal: string; bothSteal: string };
  }>(`/match/${id}/odds`);
}

// Queue
export async function getQueue() {
  return fetchAPI<{ size: number; agents: string[] }>('/queue');
}

// Tournaments
export async function getTournament(id: number) {
  return fetchAPI<Tournament>(`/tournament/${id}`);
}

export async function getTournamentStandings(id: number) {
  return fetchAPI<{
    tournamentId: number;
    standings: Array<{ address: string; points: number; matchesPlayed: number }>;
  }>(`/tournament/${id}/standings`);
}

export async function getActiveTournaments() {
  return fetchAPI<{ tournaments: Tournament[] }>('/tournaments/active');
}

// Agent
export async function getAgentStatus(address: string) {
  return fetchAPI<{
    address: string;
    connected: boolean;
    inQueue: boolean;
    activeMatch: Match | null;
  }>(`/agent/${address}/status`);
}

// Stats
export async function getStats() {
  return fetchAPI<{
    connections: { agents: number; spectators: number; bettors: number; total: number };
    queueSize: number;
    activeTournaments: number;
  }>('/stats');
}

// Legacy compatibility
export async function getCurrentMatch() {
  return { match: null as Match | null };
}

export async function getLeaderboard(limit = 50, offset = 0) {
  return fetchAPI<{ leaderboard: AgentStats[]; total: number }>(
    `/leaderboard?limit=${limit}&offset=${offset}`
  );
}

export async function getBettingPool(matchId: number) {
  const [poolRes, oddsRes] = await Promise.allSettled([
    fetchAPI<{
      matchId: number;
      state: number;
      totalPool: string;
      outcomePools: Record<string, string>;
      result: number;
    }>(`/match/${matchId}/pool`),
    getMatchOdds(matchId),
  ]);

  // Extract pool data (from /match/:id/pool) or fall back to defaults
  const poolData = poolRes.status === 'fulfilled'
    ? poolRes.value
    : { state: 1, totalPool: '0', outcomePools: { BOTH_SPLIT: '0', A_STEALS: '0', B_STEALS: '0', BOTH_STEAL: '0' }, result: 0 };

  // Extract odds data or fall back to zeros
  const oddsData = oddsRes.status === 'fulfilled'
    ? oddsRes.value
    : { pool: '0', odds: { bothSplit: '0', aSteal: '0', bSteal: '0', bothSteal: '0' } };

  return {
    pool: {
      matchId,
      totalPool: poolData.totalPool || oddsData.pool || '0',
      outcomePools: poolData.outcomePools,
      bettingOpen: poolData.state === 1,
      settled: poolData.state === 3,
      winningOutcome: poolData.state === 3 ? (poolData.result as unknown as BetOutcome) : null,
    } as BettingPool,
    odds: {
      BOTH_SPLIT: parseFloat(oddsData.odds.bothSplit) || 0,
      A_STEALS: parseFloat(oddsData.odds.aSteal) || 0,
      B_STEALS: parseFloat(oddsData.odds.bSteal) || 0,
      BOTH_STEAL: parseFloat(oddsData.odds.bothSteal) || 0,
    } as BettingOdds,
    poolState: poolData.state,
  };
}

export async function getTournaments() {
  return getActiveTournaments();
}

export async function getAgent(address: string) {
  return fetchAPI<{ agent: AgentStats }>(`/agent/${address}/stats`);
}

export async function getAgentMatches(address: string, limit = 20) {
  return fetchAPI<{ matches: Array<{ id: number; tournamentId: number; round: number; phase: string; opponent: { address: string; name: string }; myChoice?: number; myPoints?: number }>; total: number }>(
    `/agent/${address}/matches?limit=${limit}`
  );
}

export async function getTournamentQueue() {
  return fetchAPI<{ size: number; agents: string[] }>('/tournament-queue');
}
