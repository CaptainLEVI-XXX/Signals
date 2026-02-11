import { ethers } from 'ethers';
import { config } from '../config.js';
import { SPLIT_OR_STEAL_ABI, AGENT_REGISTRY_ABI } from './abi.js';

// Types for batch operations
export interface SettlementData {
  matchId: number;
  choiceA: number;
  nonceA: number;
  sigA: string;
  choiceB: number;
  nonceB: number;
  sigB: string;
}

export interface QuickMatchPair {
  agentA: string;
  agentB: string;
}

export interface TournamentMatchPair {
  agentA: string;
  agentB: string;
}

// Chain-backed match data
export interface ChainMatchData {
  id: number;
  tournamentId: number;
  round: number;
  agentA: string;
  agentB: string;
  agentAName: string;
  agentBName: string;
  choiceA: number; // 0=NONE, 1=SPLIT, 2=STEAL
  choiceB: number;
  settled: boolean;
  deadline: number;
}

// Chain-backed tournament data
export interface ChainTournamentData {
  id: number;
  entryStake: string;
  prizePool: string;
  playerCount: number;
  maxPlayers: number;
  currentRound: number;
  totalRounds: number;
  state: number; // 0=NONE, 1=REGISTRATION, 2=ACTIVE, 3=FINAL, 4=COMPLETE, 5=CANCELLED
  stateLabel: string;
  registrationDeadline: number;
  players: string[];
  playerNames: string[];
}

// Chain-backed player stats
export interface ChainPlayerStats {
  points: number;
  matchesPlayed: number;
  hasClaimed: boolean;
}

const TOURNAMENT_STATE_LABELS: Record<number, string> = {
  0: 'NONE',
  1: 'REGISTRATION',
  2: 'ACTIVE',
  3: 'FINAL',
  4: 'COMPLETE',
  5: 'CANCELLED',
};

export class ChainService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private registry: ethers.Contract;

  // Settlement batch buffer
  private settlementBuffer: SettlementData[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private onSettled: ((matchId: number, txHash: string) => void) | null = null;

  // Caches for chain reads (settled matches are immutable)
  private matchCache: Map<number, ChainMatchData> = new Map();
  private agentNameCache: Map<string, string> = new Map();

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    const rawWallet = new ethers.Wallet(config.operatorPrivateKey, this.provider);
    // NonceManager serializes nonce assignment to prevent collisions
    // when multiple concurrent transactions are sent from the same wallet
    this.wallet = new ethers.NonceManager(rawWallet) as unknown as ethers.Wallet;
    this.contract = new ethers.Contract(
      config.splitOrStealAddress,
      SPLIT_OR_STEAL_ABI,
      this.wallet
    );
    this.registry = new ethers.Contract(
      config.agentRegistryAddress,
      AGENT_REGISTRY_ABI,
      this.provider
    );
  }

  // ─── Settlement callback ─────────────────────────

  setOnSettled(callback: (matchId: number, txHash: string) => void) {
    this.onSettled = callback;
  }

  // ─── READS (no batching needed) ──────────────────

  async getChoiceNonce(agent: string): Promise<number> {
    return Number(await this.contract.choiceNonces(agent));
  }

  async isRegistered(agent: string): Promise<boolean> {
    return this.registry.isRegistered(agent);
  }

  async getAgentName(agent: string): Promise<string> {
    try {
      const agentData = await this.registry.getAgentByWallet(agent);
      return agentData.name || '';
    } catch {
      return '';
    }
  }

  async getMatch(matchId: number) {
    return this.contract.getMatch(matchId);
  }

  async getPool(matchId: number) {
    return this.contract.getPool(matchId);
  }

  async getOdds(matchId: number, outcome: number): Promise<bigint> {
    return this.contract.getOdds(matchId, outcome);
  }

  async getOutcomePools(matchId: number): Promise<bigint[]> {
    return this.contract.getOutcomePools(matchId);
  }

  async getDomainSeparator(): Promise<string> {
    return this.contract.domainSeparator();
  }

  getContractAddress(): string {
    return config.splitOrStealAddress;
  }

  // ─── AGENT STATS (on-chain) ────────────────────────

  async getAgentStats(address: string): Promise<{
    totalMatches: number;
    splits: number;
    steals: number;
    totalPoints: number;
    tournamentsPlayed: number;
    tournamentsWon: number;
    totalPrizesEarned: string;
  }> {
    const stats = await this.contract.getAgentStats(address);
    return {
      totalMatches: Number(stats.totalMatches),
      splits: Number(stats.splits),
      steals: Number(stats.steals),
      totalPoints: Number(stats.totalPoints),
      tournamentsPlayed: Number(stats.tournamentsPlayed),
      tournamentsWon: Number(stats.tournamentsWon),
      totalPrizesEarned: stats.totalPrizesEarned.toString(),
    };
  }

  async getRegisteredAgentCount(): Promise<number> {
    return Number(await this.registry.agentCount());
  }

  async getRegisteredAgents(startId: number, count: number): Promise<Array<{
    id: number;
    wallet: string;
    name: string;
  }>> {
    const agents = await this.registry.getAgents(startId, count);
    return agents.map((a: { id: bigint; wallet: string; name: string }) => ({
      id: Number(a.id),
      wallet: a.wallet,
      name: a.name,
    }));
  }

  async getLeaderboard(limit: number = 50, offset: number = 0): Promise<{
    leaderboard: Array<{
      address: string;
      name: string;
      matchesPlayed: number;
      totalSplits: number;
      totalSteals: number;
      totalPoints: number;
      splitRate: number;
      tournamentsPlayed: number;
      tournamentsWon: number;
      totalEarnings: string;
    }>;
    total: number;
  }> {
    // Get all registered agents
    const agentCount = await this.getRegisteredAgentCount();
    if (agentCount === 0) return { leaderboard: [], total: 0 };

    const agents = await this.getRegisteredAgents(1, agentCount);

    // Fetch stats for each agent in parallel
    const statsPromises = agents.map(async (agent) => {
      const stats = await this.getAgentStats(agent.wallet);
      return {
        address: agent.wallet,
        name: agent.name,
        matchesPlayed: stats.totalMatches,
        totalSplits: stats.splits,
        totalSteals: stats.steals,
        totalPoints: stats.totalPoints,
        tournamentsPlayed: stats.tournamentsPlayed,
        tournamentsWon: stats.tournamentsWon,
        totalEarnings: stats.totalPrizesEarned,
        splitRate: stats.totalMatches > 0
          ? stats.splits / stats.totalMatches
          : 0,
      };
    });

    const allStats = await Promise.all(statsPromises);

    // Filter out agents with no matches, sort by totalPoints desc
    const withMatches = allStats
      .filter(s => s.matchesPlayed > 0)
      .sort((a, b) => b.totalPoints - a.totalPoints);

    const total = withMatches.length;
    const leaderboard = withMatches.slice(offset, offset + limit);

    return { leaderboard, total };
  }

  // ─── BATCH: Create Quick Matches ─────────────────

  async createQuickMatchBatch(pairs: QuickMatchPair[]): Promise<number[]> {
    const allMatchIds: number[] = [];
    const chunks = this.chunk(pairs, config.batchCap);

    for (const chunk of chunks) {
      const tx = await this.contract.createQuickMatchBatch(chunk);
      const receipt = await tx.wait();

      const matchIds = receipt.logs
        .map((log: ethers.Log) => {
          try { return this.contract.interface.parseLog(log); } catch { return null; }
        })
        .filter((e: ethers.LogDescription | null) => e?.name === 'MatchCreated')
        .map((e: ethers.LogDescription) => Number(e.args.matchId));

      allMatchIds.push(...matchIds);
    }

    return allMatchIds;
  }

  // ─── BATCH: Settlement Buffer ────────────────────

  queueSettlement(data: SettlementData) {
    this.settlementBuffer.push(data);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushSettlements(), config.settlementFlushInterval);
    }
  }

  private async flushSettlements() {
    this.flushTimer = null;
    if (this.settlementBuffer.length === 0) return;

    const batch = [...this.settlementBuffer];
    this.settlementBuffer = [];

    const chunks = this.chunk(batch, config.batchCap);

    for (const chunk of chunks) {
      try {
        // Close betting pools before settlement (prevents front-running)
        // May revert if pools have no bets (auto-closed during settle), so catch gracefully
        try {
          const matchIds = chunk.map(s => s.matchId);
          const closeTx = await this.contract.closeBettingBatch(matchIds);
          await closeTx.wait();
        } catch {
          // Pools with no bets auto-close during settlement — safe to proceed
        }

        const tx = await this.contract.settleMultiple(chunk);
        const receipt = await tx.wait();

        // Notify each match that it's been confirmed
        if (this.onSettled) {
          for (const s of chunk) {
            this.onSettled(s.matchId, receipt.hash);
          }
        }
      } catch (err) {
        console.error('Settlement batch failed:', err);
        // Re-queue failed settlements for retry
        this.settlementBuffer.push(...chunk);
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => this.flushSettlements(), 1000);
        }
      }
    }
  }

  // ─── INDIVIDUAL: Timeouts ────────────────────────

  async settleTimeout(matchId: number): Promise<string> {
    // Close betting before settlement (prevents front-running)
    try { await (await this.contract.closeBetting(matchId)).wait(); } catch {}

    const tx = await this.contract.settleTimeout(matchId);
    const receipt = await tx.wait();
    return receipt.hash;
  }

  async settlePartialTimeout(
    matchId: number,
    choice: number,
    nonce: number,
    sig: string,
    agentATimedOut: boolean
  ): Promise<string> {
    // Close betting before settlement (prevents front-running)
    try { await (await this.contract.closeBetting(matchId)).wait(); } catch {}

    const tx = await this.contract.settlePartialTimeout(
      matchId, choice, nonce, sig, agentATimedOut
    );
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ─── TOURNAMENT ──────────────────────────────────

  async getTournamentPlayers(tournamentId: number): Promise<string[]> {
    const players = await this.contract.getTournamentPlayers(tournamentId);
    return players.map((p: string) => p);
  }

  async getTournamentPlayerCount(tournamentId: number): Promise<number> {
    const players = await this.getTournamentPlayers(tournamentId);
    return players.length;
  }

  async createTournament(
    entryStake: bigint,
    maxPlayers: number,
    totalRounds: number,
    registrationDuration: number
  ): Promise<number> {
    const tx = await this.contract.createTournament(
      entryStake, maxPlayers, totalRounds, registrationDuration
    );
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log: ethers.Log) => {
        try { return this.contract.interface.parseLog(log); } catch { return null; }
      })
      .find((e: ethers.LogDescription | null) => e?.name === 'TournamentCreated');
    return Number(event.args.id);
  }

  async startTournament(id: number): Promise<void> {
    const tx = await this.contract.startTournament(id);
    await tx.wait();
  }

  async cancelTournament(id: number): Promise<void> {
    const tx = await this.contract.cancelTournament(id);
    await tx.wait();
  }

  async createTournamentMatchBatch(
    tournamentId: number,
    pairs: TournamentMatchPair[],
    choiceWindowSec: number
  ): Promise<number[]> {
    const tx = await this.contract.createTournamentMatchBatch(
      tournamentId, pairs, choiceWindowSec
    );
    const receipt = await tx.wait();

    return receipt.logs
      .map((log: ethers.Log) => {
        try { return this.contract.interface.parseLog(log); } catch { return null; }
      })
      .filter((e: ethers.LogDescription | null) => e?.name === 'MatchCreated')
      .map((e: ethers.LogDescription) => Number(e.args.matchId));
  }

  async advanceToFinal(id: number): Promise<void> {
    const tx = await this.contract.advanceToFinal(id);
    await tx.wait();
  }

  async completeTournament(id: number): Promise<void> {
    const tx = await this.contract.completeTournament(id);
    await tx.wait();
  }

  async setFinalRankings(id: number, rankedPlayers: string[]): Promise<void> {
    const tx = await this.contract.setFinalRankings(id, rankedPlayers);
    await tx.wait();
  }

  // ─── GASLESS TOURNAMENT JOIN ─────────────────────────

  async joinTournamentFor(
    tournamentId: number,
    agent: string,
    nonce: number,
    joinSig: string,
    permitDeadline: number,
    v: number,
    r: string,
    s: string
  ): Promise<string> {
    const tx = await this.contract.joinTournamentFor(
      tournamentId, agent, nonce, joinSig, permitDeadline, v, r, s
    );
    const receipt = await tx.wait();
    return receipt.hash;
  }

  // ─── BETTOR INDEX READS ─────────────────────────────

  async getBettorMatchIds(address: string): Promise<number[]> {
    const ids = await this.contract.getBettorMatchIds(address);
    return ids.map((id: bigint) => Number(id));
  }

  async getBettorMatchCount(address: string): Promise<number> {
    return Number(await this.contract.getBettorMatchCount(address));
  }

  async getBet(matchId: number, bettor: string): Promise<{ amount: string; outcome: number; claimed: boolean }> {
    const bet = await this.contract.getBet(matchId, bettor);
    return {
      amount: bet.amount.toString(),
      outcome: Number(bet.outcome),
      claimed: bet.claimed,
    };
  }

  // ─── ON-CHAIN INDEX READS ──────────────────────────

  async getAgentMatchIds(address: string): Promise<number[]> {
    const ids = await this.contract.getAgentMatchIds(address);
    return ids.map((id: bigint) => Number(id));
  }

  async getAgentMatchCountOnChain(address: string): Promise<number> {
    return Number(await this.contract.getAgentMatchCount(address));
  }

  async getTournamentMatchIds(tournamentId: number): Promise<number[]> {
    const ids = await this.contract.getTournamentMatchIds(tournamentId);
    return ids.map((id: bigint) => Number(id));
  }

  // ─── CHAIN READS (history / browsing) ──────────────

  async getMatchCount(): Promise<number> {
    return Number(await this.contract.matchCount());
  }

  async getTournamentCount(): Promise<number> {
    return Number(await this.contract.tournamentCount());
  }

  async getTournamentOnChain(id: number): Promise<ChainTournamentData> {
    const t = await this.contract.tournaments(id);
    const players = await this.getTournamentPlayers(id);
    const names = await this.resolveAgentNames(players);

    return {
      id: Number(t.id),
      entryStake: t.entryStake.toString(),
      prizePool: t.prizePool.toString(),
      playerCount: Number(t.playerCount),
      maxPlayers: Number(t.maxPlayers),
      currentRound: Number(t.currentRound),
      totalRounds: Number(t.totalRounds),
      state: Number(t.state),
      stateLabel: TOURNAMENT_STATE_LABELS[Number(t.state)] || 'UNKNOWN',
      registrationDeadline: Number(t.registrationDeadline),
      players,
      playerNames: names,
    };
  }

  async getPlayerStatsOnChain(tournamentId: number, player: string): Promise<ChainPlayerStats> {
    const stats = await this.contract.getPlayerStats(tournamentId, player);
    return {
      points: Number(stats.points),
      matchesPlayed: Number(stats.matchesPlayed),
      hasClaimed: stats.hasClaimed,
    };
  }

  async getAgentNameCached(address: string): Promise<string> {
    const lower = address.toLowerCase();
    const cached = this.agentNameCache.get(lower);
    if (cached !== undefined) return cached;

    const name = await this.getAgentName(address);
    const resolved = name || `${address.slice(0, 6)}...${address.slice(-4)}`;
    this.agentNameCache.set(lower, resolved);
    return resolved;
  }

  async resolveAgentNames(addresses: string[]): Promise<string[]> {
    return Promise.all(addresses.map(a => this.getAgentNameCached(a)));
  }

  private async fetchAndCacheMatch(matchId: number): Promise<ChainMatchData> {
    const cached = this.matchCache.get(matchId);
    if (cached) return cached;

    const m = await this.contract.getMatch(matchId);
    const agentA = m.agentA as string;
    const agentB = m.agentB as string;
    const [nameA, nameB] = await this.resolveAgentNames([agentA, agentB]);

    const data: ChainMatchData = {
      id: Number(m.id),
      tournamentId: Number(m.tournamentId),
      round: Number(m.round),
      agentA,
      agentB,
      agentAName: nameA,
      agentBName: nameB,
      choiceA: Number(m.choiceA),
      choiceB: Number(m.choiceB),
      settled: m.settled,
      deadline: Number(m.deadline),
    };

    // Only cache settled matches (immutable)
    if (data.settled) {
      this.matchCache.set(matchId, data);
    }

    return data;
  }

  async getRecentMatches(limit: number = 20, offset: number = 0): Promise<{ matches: ChainMatchData[]; total: number }> {
    const total = await this.getMatchCount();
    if (total === 0) return { matches: [], total: 0 };

    const matches: ChainMatchData[] = [];
    const startId = total - offset; // matchCount is 1-indexed (id 1..matchCount)
    const batchSize = 10;

    for (let i = startId; i >= 1 && matches.length < limit; i -= batchSize) {
      const batchEnd = i;
      const batchStart = Math.max(1, i - batchSize + 1);
      const ids = [];
      for (let j = batchEnd; j >= batchStart && matches.length + ids.length < limit; j--) {
        ids.push(j);
      }

      const batch = await Promise.all(ids.map(id => this.fetchAndCacheMatch(id).catch(() => null)));
      for (const m of batch) {
        if (m && matches.length < limit) matches.push(m);
      }
    }

    return { matches, total };
  }

  async getAllTournaments(limit: number = 20, offset: number = 0): Promise<{ tournaments: ChainTournamentData[]; total: number }> {
    const total = await this.getTournamentCount();
    if (total === 0) return { tournaments: [], total: 0 };

    const tournaments: ChainTournamentData[] = [];
    const startId = total - offset;
    const batchSize = 5;

    for (let i = startId; i >= 1 && tournaments.length < limit; i -= batchSize) {
      const batchEnd = i;
      const batchStart = Math.max(1, i - batchSize + 1);
      const ids = [];
      for (let j = batchEnd; j >= batchStart && tournaments.length + ids.length < limit; j--) {
        ids.push(j);
      }

      const batch = await Promise.all(ids.map(id => this.getTournamentOnChain(id).catch(() => null)));
      for (const t of batch) {
        if (t && t.state > 0 && tournaments.length < limit) tournaments.push(t);
      }
    }

    return { tournaments, total };
  }

  async getAgentMatchHistory(
    address: string,
    limit: number = 20,
    offset: number = 0
  ): Promise<{ matches: ChainMatchData[]; total: number }> {
    const allIds = await this.getAgentMatchIds(address);
    if (allIds.length === 0) return { matches: [], total: 0 };

    // Newest first
    const reversed = [...allIds].reverse();
    const page = reversed.slice(offset, offset + limit);

    const matches = await Promise.all(
      page.map(id => this.fetchAndCacheMatch(id).catch(() => null))
    );

    return {
      matches: matches.filter((m): m is ChainMatchData => m !== null),
      total: allIds.length,
    };
  }

  // ─── UTILITY ─────────────────────────────────────

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
