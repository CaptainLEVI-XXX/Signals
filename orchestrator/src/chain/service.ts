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

export class ChainService {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private contract: ethers.Contract;
  private registry: ethers.Contract;

  // Settlement batch buffer
  private settlementBuffer: SettlementData[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private onSettled: ((matchId: number, txHash: string) => void) | null = null;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.operatorPrivateKey, this.provider);
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

  async getMatch(matchId: number) {
    return this.contract.getMatch(matchId);
  }

  async getPool(matchId: number) {
    return this.contract.getPool(matchId);
  }

  async getOdds(matchId: number, outcome: number): Promise<bigint> {
    return this.contract.getOdds(matchId, outcome);
  }

  async getDomainSeparator(): Promise<string> {
    return this.contract.domainSeparator();
  }

  getContractAddress(): string {
    return config.splitOrStealAddress;
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

  // ─── UTILITY ─────────────────────────────────────

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
}
