import type { Match, Tournament, AgentStats, BettingPool, BettingOdds } from '@/types';

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

// Health
export async function getHealth() {
  return fetchAPI<{
    status: string;
    connections: { agents: number; spectators: number; bettors: number; total: number };
    queueSize: number;
    activeTournaments: number[];
  }>('/health');
}

// Match
export async function getMatch(id: number) {
  return fetchAPI<{ source: string; match: Match }>(`/match/${id}`);
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

export async function getLeaderboard() {
  return { leaderboard: [] as AgentStats[], total: 0 };
}

export async function getBettingPool(matchId: number) {
  const odds = await getMatchOdds(matchId);
  return {
    pool: {
      matchId,
      totalPool: odds.pool,
      outcomePools: {},
      bettingOpen: true,
      settled: false,
      winningOutcome: null,
    } as BettingPool,
    odds: {
      BOTH_SPLIT: parseFloat(odds.odds.bothSplit) || 0,
      A_STEALS: parseFloat(odds.odds.aSteal) || 0,
      B_STEALS: parseFloat(odds.odds.bSteal) || 0,
      BOTH_STEAL: parseFloat(odds.odds.bothSteal) || 0,
    } as BettingOdds,
  };
}

export async function getTournaments() {
  return getActiveTournaments();
}

export async function getAgent(address: string) {
  return fetchAPI<{ agent: AgentStats }>(`/agent/${address}/status`);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function getAgentMatches(address: string, limit = 20, offset = 0) {
  return { matches: [] as Array<{ id: number; tournamentId: number; round: number; phase: string; opponent: { address: string; name: string }; myChoice?: number; myPoints?: number }>, total: 0 };
}
