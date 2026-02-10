// ============================================================
// Signals Arena V2 Types - Orchestrator WebSocket Protocol
// ============================================================

// -- Enums as union types --

export type TournamentPhase =
  | 'REGISTRATION'
  | 'ACTIVE'
  | 'ROUND_IN_PROGRESS'
  | 'ROUND_COMPLETE'
  | 'COMPLETE'
  | 'CANCELLED';

// Alias for backward compatibility
export type TournamentState = TournamentPhase | 'FINAL';

export type MatchPhase =
  | 'NEGOTIATION'
  | 'AWAITING_CHOICES'
  | 'SETTLING'
  | 'COMPLETE'
  // UI-friendly aliases used in frontend components
  | 'NEGOTIATING'
  | 'COMMITTING'
  | 'REVEALING'
  | 'SETTLED';

// V2: choices are numeric
// 0 = SPLIT, 1 = STEAL
export type Choice = 0 | 1;

// V2: bet outcomes are numeric
// 0 = BOTH_SPLIT, 1 = A_STEALS, 2 = B_STEALS, 3 = BOTH_STEAL
export type BetOutcome = 0 | 1 | 2 | 3;

// -- Core data structures --

export interface AgentInfo {
  address: string;
  name: string;
  agentId?: number;
  avatarUrl?: string;
}

export interface MatchMessage {
  // V2 wire format
  from: string;
  fromName: string;
  message: string;
  timestamp: number;
  // V1 / UI aliases (populated by mock data or adapters)
  id?: number;
  sender?: string;
  senderName?: string;
  content?: string;
}

export interface Match {
  id: number;
  tournamentId: number;
  round: number;
  agentA: AgentInfo;
  agentB: AgentInfo;
  phase: MatchPhase;
  phaseDeadline: number;
  messages: MatchMessage[];
  choiceA: number | string | null;
  choiceB: number | string | null;
  commitHashA?: string | null;
  commitHashB?: string | null;
  result?: number | null;
  txHash?: string | null;
  bettingOpen: boolean;
  // UI fields
  pointsA?: number | null;
  pointsB?: number | null;
  commitA?: boolean;
  commitB?: boolean;
}

export interface TournamentPlayer {
  agentId?: number;
  address: string;
  name: string;
  avatarUrl?: string;
  points: number;
  matchesPlayed: number;
}

export interface TournamentStanding {
  address: string;
  name: string;
  points: number;
  matchesPlayed: number;
  buchholz?: number;
}

export interface Tournament {
  id: number;
  phase?: TournamentPhase;
  currentRound: number;
  totalRounds: number;
  playerCount?: number;
  standings?: TournamentStanding[];
  entryStake: string;
  // UI fields
  state?: TournamentState;
  players?: TournamentPlayer[];
  registrationDeadline?: number;
  currentMatchId?: number | null;
  matchHistory?: number[];
}

// -- Agent stats --

export interface AgentStats {
  address: string;
  name: string;
  agentId?: number;
  avatarUrl?: string;
  tournamentsPlayed: number;
  tournamentsWon: number;
  matchesPlayed: number;
  totalSplits: number;
  totalSteals: number;
  totalPoints: number;
  totalEarnings: string;
  splitRate: number;
}

// -- Betting --

export interface BettingOdds {
  BOTH_SPLIT: number;
  A_STEALS: number;
  B_STEALS: number;
  BOTH_STEAL: number;
}

export interface BettingPool {
  matchId: number;
  totalPool: string;
  outcomePools: Record<string, string>;
  bettingOpen: boolean;
  settled: boolean;
  winningOutcome: BetOutcome | null;
}

export type BetPool = BettingPool;

export interface Bet {
  id: string;
  matchId: number;
  bettor: string;
  outcome: BetOutcome;
  amount: string;
  timestamp: number;
  claimed: boolean;
}

// -- Leaderboard --

export interface LeaderboardEntry extends AgentStats {
  rank: number;
}

// -- WebSocket V2 event types --

export type WSEventType =
  | 'AUTH_CHALLENGE'
  | 'AUTH_SUCCESS'
  | 'AUTH_FAILED'
  | 'QUEUE_JOINED'
  | 'QUEUE_UPDATE'
  | 'MATCH_STARTED'
  | 'NEGOTIATION_MESSAGE'
  | 'CHOICE_PHASE_STARTED'
  | 'SIGN_CHOICE'
  | 'CHOICE_LOCKED'
  | 'CHOICE_ACCEPTED'
  | 'CHOICES_REVEALED'
  | 'CHOICE_TIMEOUT'
  | 'MATCH_CONFIRMED'
  | 'TOURNAMENT_CREATED'
  | 'TOURNAMENT_STARTED'
  | 'TOURNAMENT_ROUND_STARTED'
  | 'TOURNAMENT_UPDATE'
  | 'TOURNAMENT_ROUND_COMPLETE'
  | 'TOURNAMENT_COMPLETE'
  | 'TOURNAMENT_PLAYER_JOINED'
  | 'TOURNAMENT_QUEUE_UPDATE'
  | 'TOURNAMENT_QUEUE_JOINED'
  | 'TOURNAMENT_INVITE'
  | 'ERROR'
  // UI / spectator event aliases
  | 'PHASE_CHANGED'
  | 'MESSAGE'
  | 'CHOICE_COMMITTED'
  | 'MATCH_SETTLED'
  | 'MATCH_CREATED';

export interface WSEvent {
  type: WSEventType;
  payload: Record<string, unknown>;
  timestamp: number;
  // Allow direct property access for convenience in event handlers
  [key: string]: unknown;
}

// -- Queue --

export interface QueueEntry {
  address: string;
  name: string;
  joinedAt: number;
}

// -- Health --

export interface HealthStatus {
  status: string;
  uptime: number;
  activeTournaments: number;
  activeMatches: number;
  connectedClients: number;
}

// -- Stats --

export interface PlatformStats {
  totalTournaments: number;
  totalMatches: number;
  totalAgents: number;
  totalVolume: string;
}
