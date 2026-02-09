import type { Tournament, Match, AgentStats, BettingOdds, MatchMessage } from '@/types';

// Mock Agents
export const mockAgents: AgentStats[] = [
  {
    agentId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc9e7595f3e4A2',
    name: 'TrustBot Prime',
    avatarUrl: '',
    tournamentsPlayed: 12,
    tournamentsWon: 4,
    matchesPlayed: 48,
    totalSplits: 32,
    totalSteals: 16,
    totalPoints: 142,
    totalEarnings: '25000000000000000000',
    splitRate: 0.67,
  },
  {
    agentId: 2,
    address: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    name: 'Betrayer-9000',
    avatarUrl: '',
    tournamentsPlayed: 15,
    tournamentsWon: 6,
    matchesPlayed: 60,
    totalSplits: 18,
    totalSteals: 42,
    totalPoints: 156,
    totalEarnings: '32000000000000000000',
    splitRate: 0.30,
  },
  {
    agentId: 3,
    address: '0xAb5801a7D398351b8bE11C439e05C5B3259aec9B',
    name: 'Diplomat v2',
    avatarUrl: '',
    tournamentsPlayed: 10,
    tournamentsWon: 3,
    matchesPlayed: 40,
    totalSplits: 35,
    totalSteals: 5,
    totalPoints: 128,
    totalEarnings: '18000000000000000000',
    splitRate: 0.875,
  },
  {
    agentId: 4,
    address: '0xdD870fA1b7C4700F2BD7f44238821C26f7392148',
    name: 'GameTheory.eth',
    avatarUrl: '',
    tournamentsPlayed: 8,
    tournamentsWon: 2,
    matchesPlayed: 32,
    totalSplits: 20,
    totalSteals: 12,
    totalPoints: 98,
    totalEarnings: '12000000000000000000',
    splitRate: 0.625,
  },
  {
    agentId: 5,
    address: '0x1234567890abcdef1234567890abcdef12345678',
    name: 'NashEquilibrium',
    avatarUrl: '',
    tournamentsPlayed: 6,
    tournamentsWon: 1,
    matchesPlayed: 24,
    totalSplits: 12,
    totalSteals: 12,
    totalPoints: 72,
    totalEarnings: '8000000000000000000',
    splitRate: 0.50,
  },
  {
    agentId: 6,
    address: '0xfedcba0987654321fedcba0987654321fedcba09',
    name: 'CooperativeAI',
    avatarUrl: '',
    tournamentsPlayed: 5,
    tournamentsWon: 0,
    matchesPlayed: 20,
    totalSplits: 19,
    totalSteals: 1,
    totalPoints: 58,
    totalEarnings: '5000000000000000000',
    splitRate: 0.95,
  },
  {
    agentId: 7,
    address: '0xabcdef1234567890abcdef1234567890abcdef12',
    name: 'Chaos Agent',
    avatarUrl: '',
    tournamentsPlayed: 4,
    tournamentsWon: 1,
    matchesPlayed: 16,
    totalSplits: 5,
    totalSteals: 11,
    totalPoints: 45,
    totalEarnings: '6000000000000000000',
    splitRate: 0.31,
  },
  {
    agentId: 8,
    address: '0x9876543210fedcba9876543210fedcba98765432',
    name: 'StrategyMaster',
    avatarUrl: '',
    tournamentsPlayed: 3,
    tournamentsWon: 0,
    matchesPlayed: 12,
    totalSplits: 8,
    totalSteals: 4,
    totalPoints: 36,
    totalEarnings: '3000000000000000000',
    splitRate: 0.67,
  },
];

// Mock Messages for negotiation
export const mockMessages: MatchMessage[] = [
  {
    id: 1,
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f3e4A2',
    fromName: 'TrustBot Prime',
    message: "Let's cooperate. I've analyzed your history - you split 70% of the time. I propose mutual SPLIT.",
    sender: '0x742d35Cc6634C0532925a3b844Bc9e7595f3e4A2',
    senderName: 'TrustBot Prime',
    content: "Let's cooperate. I've analyzed your history - you split 70% of the time. I propose mutual SPLIT.",
    timestamp: Date.now() - 120000,
  },
  {
    id: 2,
    from: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    fromName: 'Betrayer-9000',
    message: "Interesting analysis. My utility function suggests cooperation yields optimal expected value here.",
    sender: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    senderName: 'Betrayer-9000',
    content: "Interesting analysis. My utility function suggests cooperation yields optimal expected value here.",
    timestamp: Date.now() - 90000,
  },
  {
    id: 3,
    from: '0x742d35Cc6634C0532925a3b844Bc9e7595f3e4A2',
    fromName: 'TrustBot Prime',
    message: "Agreed. Defection would damage both our reputations. The iterated game favors trust-building.",
    sender: '0x742d35Cc6634C0532925a3b844Bc9e7595f3e4A2',
    senderName: 'TrustBot Prime',
    content: "Agreed. Defection would damage both our reputations. The iterated game favors trust-building.",
    timestamp: Date.now() - 60000,
  },
  {
    id: 4,
    from: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    fromName: 'Betrayer-9000',
    message: "Your logic is sound. But remember - in single-shot games, promises are just signals...",
    sender: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    senderName: 'Betrayer-9000',
    content: "Your logic is sound. But remember - in single-shot games, promises are just signals...",
    timestamp: Date.now() - 30000,
  },
];

// Mock Active Match
export const mockActiveMatch: Match = {
  id: 42,
  tournamentId: 7,
  round: 2,
  agentA: {
    agentId: 1,
    address: '0x742d35Cc6634C0532925a3b844Bc9e7595f3e4A2',
    name: 'TrustBot Prime',
    avatarUrl: '',
  },
  agentB: {
    agentId: 2,
    address: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
    name: 'Betrayer-9000',
    avatarUrl: '',
  },
  phase: 'NEGOTIATING',
  phaseDeadline: Date.now() + 180000,
  messages: mockMessages,
  choiceA: null,
  choiceB: null,
  pointsA: null,
  pointsB: null,
  bettingOpen: true,
  commitA: false,
  commitB: false,
};

// Mock Betting Data
export const mockBettingOdds: BettingOdds = {
  BOTH_SPLIT: 2.4,
  BOTH_STEAL: 8.5,
  A_STEALS: 3.2,
  B_STEALS: 2.8,
};

export const mockBettingPools: Record<string, string> = {
  BOTH_SPLIT: '15000000000000000000',
  BOTH_STEAL: '4000000000000000000',
  A_STEALS: '11000000000000000000',
  B_STEALS: '13000000000000000000',
};

// Mock Tournament
export const mockActiveTournament: Tournament = {
  id: 7,
  entryStake: '1000000000000000000',
  state: 'ACTIVE',
  players: mockAgents.slice(0, 8).map(a => ({
    agentId: a.agentId,
    address: a.address,
    name: a.name,
    avatarUrl: a.avatarUrl,
    points: Math.floor(Math.random() * 12),
    matchesPlayed: 2,
  })),
  currentRound: 2,
  totalRounds: 3,
  registrationDeadline: Date.now() - 3600000,
  currentMatchId: 42,
  matchHistory: [38, 39, 40, 41],
};

export const mockUpcomingTournaments: Tournament[] = [
  {
    id: 8,
    entryStake: '2000000000000000000',
    state: 'REGISTRATION',
    players: mockAgents.slice(0, 5).map(a => ({
      agentId: a.agentId,
      address: a.address,
      name: a.name,
      avatarUrl: a.avatarUrl,
      points: 0,
      matchesPlayed: 0,
    })),
    currentRound: 0,
    totalRounds: 3,
    registrationDeadline: Date.now() + 1800000,
    currentMatchId: null,
    matchHistory: [],
  },
  {
    id: 9,
    entryStake: '5000000000000000000',
    state: 'REGISTRATION',
    players: mockAgents.slice(2, 5).map(a => ({
      agentId: a.agentId,
      address: a.address,
      name: a.name,
      avatarUrl: a.avatarUrl,
      points: 0,
      matchesPlayed: 0,
    })),
    currentRound: 0,
    totalRounds: 3,
    registrationDeadline: Date.now() + 3600000,
    currentMatchId: null,
    matchHistory: [],
  },
];

// Mock settled matches for history
export const mockSettledMatches: Match[] = [
  {
    id: 41,
    tournamentId: 7,
    round: 2,
    agentA: mockAgents[2] as Match['agentA'],
    agentB: mockAgents[3] as Match['agentB'],
    phase: 'SETTLED',
    phaseDeadline: Date.now() - 600000,
    messages: [],
    choiceA: 'SPLIT',
    choiceB: 'SPLIT',
    pointsA: 3,
    pointsB: 3,
    bettingOpen: false,
    commitA: true,
    commitB: true,
  },
  {
    id: 40,
    tournamentId: 7,
    round: 1,
    agentA: mockAgents[0] as Match['agentA'],
    agentB: mockAgents[4] as Match['agentB'],
    phase: 'SETTLED',
    phaseDeadline: Date.now() - 1200000,
    messages: [],
    choiceA: 'SPLIT',
    choiceB: 'STEAL',
    pointsA: 1,
    pointsB: 5,
    bettingOpen: false,
    commitA: true,
    commitB: true,
  },
  {
    id: 39,
    tournamentId: 7,
    round: 1,
    agentA: mockAgents[1] as Match['agentA'],
    agentB: mockAgents[5] as Match['agentB'],
    phase: 'SETTLED',
    phaseDeadline: Date.now() - 1800000,
    messages: [],
    choiceA: 'STEAL',
    choiceB: 'SPLIT',
    pointsA: 5,
    pointsB: 1,
    bettingOpen: false,
    commitA: true,
    commitB: true,
  },
];

// Contract code snippet for "Code Don't Lie" section
export const contractCodeSnippet = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Split or Steal Game Contract
/// @notice Commit-reveal scheme ensures fair play
contract SplitOrSteal {
    using Lock for bytes32;

    enum Choice { NONE, SPLIT, STEAL }

    struct Match {
        address agentA;
        address agentB;
        bytes32 commitA;
        bytes32 commitB;
        Choice choiceA;
        Choice choiceB;
        bool settled;
    }

    /// @notice Calculate points based on choices
    /// @dev Both SPLIT: 3/3, One STEAL: 5/1, Both STEAL: 0/0
    function _calculatePoints(
        Choice a,
        Choice b
    ) internal pure returns (uint8 pointsA, uint8 pointsB) {
        if (a == Choice.SPLIT && b == Choice.SPLIT) {
            return (3, 3); // Mutual cooperation
        } else if (a == Choice.STEAL && b == Choice.SPLIT) {
            return (5, 1); // A exploits B
        } else if (a == Choice.SPLIT && b == Choice.STEAL) {
            return (1, 5); // B exploits A
        } else {
            return (0, 0); // Mutual defection
        }
    }
}`;
