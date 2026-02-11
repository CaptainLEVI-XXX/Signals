import { WebSocket } from 'ws';
import { config } from '../config.js';
import { Broadcaster } from '../broadcast/events.js';
import { ChainService, SettlementData } from '../chain/service.js';
import {
  buildSigningPayload,
  validateSignature,
  generateCommitHash,
  generateMatchSalt,
} from '../chain/signing.js';

// ─── Types ───────────────────────────────────────────

type MatchState = 'NEGOTIATION' | 'AWAITING_CHOICES' | 'SETTLING' | 'COMPLETE';

interface MatchMessage {
  from: string;
  fromName: string;
  message: string;
  timestamp: number;
}

// Result enum matching contract: 0 = BOTH_SPLIT, 1 = AGENT_A_STEALS, 2 = AGENT_B_STEALS, 3 = BOTH_STEAL
const enum MatchResult {
  BOTH_SPLIT = 0,
  AGENT_A_STEALS = 1,
  AGENT_B_STEALS = 2,
  BOTH_STEAL = 3,
}

// Choice enum matches contract: 1 = SPLIT, 2 = STEAL
const CHOICE_SPLIT = 1;
const CHOICE_STEAL = 2;

// ─── MatchStateMachine ───────────────────────────────

class MatchStateMachine {
  matchId: number;
  agentA: string;
  agentB: string;
  agentAName: string;
  agentBName: string;
  tournamentId: number;
  state: MatchState = 'NEGOTIATION';
  phaseDeadline: number = 0;

  private negotiationTimer: NodeJS.Timeout | null = null;
  private choiceTimer: NodeJS.Timeout | null = null;

  private choiceA: number | null = null;
  private choiceB: number | null = null;
  private sigA: string | null = null;
  private sigB: string | null = null;
  private nonceA: number = 0;
  private nonceB: number = 0;
  private matchSalt: string;
  private commitHashA: string | null = null;
  private commitHashB: string | null = null;
  messages: MatchMessage[] = [];

  private broadcaster: Broadcaster;
  private chainService: ChainService;
  private onComplete: (matchId: number) => void;

  constructor(
    matchId: number,
    agentA: string,
    agentB: string,
    tournamentId: number,
    broadcaster: Broadcaster,
    chainService: ChainService,
    onComplete: (matchId: number) => void
  ) {
    this.matchId = matchId;
    this.agentA = agentA;
    this.agentB = agentB;
    this.tournamentId = tournamentId;
    this.broadcaster = broadcaster;
    this.chainService = chainService;
    this.onComplete = onComplete;

    // Resolve display names from connected clients, fall back to truncated address
    const clientA = this.broadcaster.getAgentByAddress(agentA);
    const clientB = this.broadcaster.getAgentByAddress(agentB);
    this.agentAName = clientA?.agentName || `${agentA.slice(0, 6)}...${agentA.slice(-4)}`;
    this.agentBName = clientB?.agentName || `${agentB.slice(0, 6)}...${agentB.slice(-4)}`;

    // Generate per-match salt for commitment hashes
    this.matchSalt = generateMatchSalt();

    // Start the match
    this.startNegotiation();
  }

  // ─── State: NEGOTIATION ────────────────────────────

  private async startNegotiation() {
    this.state = 'NEGOTIATION';
    this.phaseDeadline = Date.now() + config.negotiationDuration;

    // Fetch opponent stats for strategic context
    let opponentStatsB: Record<string, unknown> | null = null;
    let opponentStatsA: Record<string, unknown> | null = null;
    try {
      const [statsA, statsB] = await Promise.all([
        this.chainService.getAgentStats(this.agentA),
        this.chainService.getAgentStats(this.agentB),
      ]);
      // Stats of B sent to A (so A knows about their opponent)
      if (statsB.totalMatches > 0) {
        opponentStatsB = {
          matchesPlayed: statsB.totalMatches,
          splitRate: statsB.splits / statsB.totalMatches,
          stealRate: statsB.steals / statsB.totalMatches,
          totalPoints: statsB.totalPoints,
          avgPointsPerMatch: statsB.totalPoints / statsB.totalMatches,
        };
      }
      // Stats of A sent to B
      if (statsA.totalMatches > 0) {
        opponentStatsA = {
          matchesPlayed: statsA.totalMatches,
          splitRate: statsA.splits / statsA.totalMatches,
          stealRate: statsA.steals / statsA.totalMatches,
          totalPoints: statsA.totalPoints,
          avgPointsPerMatch: statsA.totalPoints / statsA.totalMatches,
        };
      }
    } catch {
      // Stats unavailable — proceed without them
    }

    // Notify both agents
    const matchInfo = {
      matchId: this.matchId,
      agentA: this.agentA,
      agentB: this.agentB,
      agentAName: this.agentAName,
      agentBName: this.agentBName,
      tournamentId: this.tournamentId,
      negotiationDuration: config.negotiationDuration,
      choiceDuration: config.choiceDuration,
    };

    this.broadcaster.sendToAgent(this.agentA, 'MATCH_STARTED', {
      ...matchInfo,
      you: this.agentA,
      opponent: this.agentB,
      opponentName: this.agentBName,
      opponentStats: opponentStatsB,
    });

    this.broadcaster.sendToAgent(this.agentB, 'MATCH_STARTED', {
      ...matchInfo,
      you: this.agentB,
      opponent: this.agentA,
      opponentName: this.agentAName,
      opponentStats: opponentStatsA,
    });

    // Public broadcast for spectators
    this.broadcaster.broadcastPublic('MATCH_STARTED', matchInfo);

    // Set negotiation timer
    this.negotiationTimer = setTimeout(() => {
      this.enterChoicePhase();
    }, config.negotiationDuration);
  }

  // ─── Negotiation message relay ─────────────────────

  onMessage(from: string, message: string) {
    if (this.state !== 'NEGOTIATION') return;

    const fromLower = from.toLowerCase();
    const isA = fromLower === this.agentA.toLowerCase();
    const isB = fromLower === this.agentB.toLowerCase();
    if (!isA && !isB) return;

    const fromName = isA ? this.agentAName : this.agentBName;
    const opponent = isA ? this.agentB : this.agentA;

    const msg: MatchMessage = {
      from,
      fromName,
      message,
      timestamp: Date.now(),
    };
    this.messages.push(msg);

    // Relay to opponent
    this.broadcaster.sendToAgent(opponent, 'NEGOTIATION_MESSAGE', {
      matchId: this.matchId,
      from,
      fromName,
      message,
      timestamp: msg.timestamp,
    });

    // Broadcast to spectators (public)
    this.broadcaster.broadcastPublic('NEGOTIATION_MESSAGE', {
      matchId: this.matchId,
      from,
      fromName,
      message,
      timestamp: msg.timestamp,
    });
  }

  // ─── State: AWAITING_CHOICES ───────────────────────

  private async enterChoicePhase() {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
    }

    this.state = 'AWAITING_CHOICES';
    this.phaseDeadline = Date.now() + config.choiceDuration;

    // Fetch current nonces from chain for each agent
    try {
      this.nonceA = await this.chainService.getChoiceNonce(this.agentA);
      this.nonceB = await this.chainService.getChoiceNonce(this.agentB);
    } catch (err) {
      console.error(`[Match ${this.matchId}] Failed to fetch nonces:`, err);
      // Fallback to 0 if chain read fails - the signature validation will catch mismatches
      this.nonceA = 0;
      this.nonceB = 0;
    }

    const contractAddress = this.chainService.getContractAddress();

    // Build EIP-712 signing payloads for each agent
    const payloadA = buildSigningPayload(contractAddress, this.matchId, this.nonceA);
    const payloadB = buildSigningPayload(contractAddress, this.matchId, this.nonceB);

    // Send SIGN_CHOICE to each agent with their pre-built typed data
    this.broadcaster.sendToAgent(this.agentA, 'SIGN_CHOICE', {
      matchId: this.matchId,
      nonce: this.nonceA,
      deadline: config.choiceDuration,
      typedData: payloadA,
    });

    this.broadcaster.sendToAgent(this.agentB, 'SIGN_CHOICE', {
      matchId: this.matchId,
      nonce: this.nonceB,
      deadline: config.choiceDuration,
      typedData: payloadB,
    });

    // Notify spectators that negotiation ended, choice phase started
    this.broadcaster.broadcastPublic('CHOICE_PHASE_STARTED', {
      matchId: this.matchId,
      agentA: this.agentA,
      agentB: this.agentB,
      agentAName: this.agentAName,
      agentBName: this.agentBName,
      deadline: config.choiceDuration,
    });

    // Set choice timer
    this.choiceTimer = setTimeout(() => {
      this.handleChoiceTimeout();
    }, config.choiceDuration);
  }

  // ─── Choice submission ─────────────────────────────

  onChoice(from: string, choice: number, signature: string): { success: boolean; error?: string } {
    if (this.state !== 'AWAITING_CHOICES') {
      return { success: false, error: 'Match is not in choice phase' };
    }

    if (choice !== CHOICE_SPLIT && choice !== CHOICE_STEAL) {
      return { success: false, error: 'Invalid choice. Must be 1 (SPLIT) or 2 (STEAL)' };
    }

    const fromLower = from.toLowerCase();
    const isA = fromLower === this.agentA.toLowerCase();
    const isB = fromLower === this.agentB.toLowerCase();
    if (!isA && !isB) {
      return { success: false, error: 'Not a participant in this match' };
    }

    // Check for duplicate submission
    if (isA && this.sigA !== null) {
      return { success: false, error: 'Choice already submitted' };
    }
    if (isB && this.sigB !== null) {
      return { success: false, error: 'Choice already submitted' };
    }

    // Validate signature against expected signer
    const contractAddress = this.chainService.getContractAddress();
    const nonce = isA ? this.nonceA : this.nonceB;
    const valid = validateSignature(contractAddress, this.matchId, choice, nonce, signature, from);

    if (!valid) {
      return { success: false, error: 'Invalid signature' };
    }

    // Store choice and signature
    if (isA) {
      this.choiceA = choice;
      this.sigA = signature;
    } else {
      this.choiceB = choice;
      this.sigB = signature;
    }

    // Generate and broadcast commitment hash (hides actual choice from spectators)
    const commitHash = generateCommitHash(signature, this.matchSalt);
    if (isA) {
      this.commitHashA = commitHash;
    } else {
      this.commitHashB = commitHash;
    }

    const agentName = isA ? this.agentAName : this.agentBName;

    // Broadcast CHOICE_LOCKED to everyone (agents + spectators)
    this.broadcaster.broadcast('CHOICE_LOCKED', {
      matchId: this.matchId,
      agent: from,
      agentName,
      commitHash,
    });

    // Confirm receipt to the submitting agent
    this.broadcaster.sendToAgent(from, 'CHOICE_ACCEPTED', {
      matchId: this.matchId,
      choice,
    });

    // Check if both choices are in
    if (this.sigA !== null && this.sigB !== null) {
      this.resolveMatch();
    }

    return { success: true };
  }

  // ─── Match resolution (both choices received) ──────

  private resolveMatch() {
    // Cancel the choice timer
    if (this.choiceTimer) {
      clearTimeout(this.choiceTimer);
      this.choiceTimer = null;
    }

    this.state = 'SETTLING';
    this.phaseDeadline = 0;

    // Compute result
    const result = this.computeResult(this.choiceA!, this.choiceB!);
    const resultName = this.resultToString(result);

    // Broadcast CHOICES_REVEALED to everyone
    this.broadcaster.broadcast('CHOICES_REVEALED', {
      matchId: this.matchId,
      agentA: this.agentA,
      agentB: this.agentB,
      agentAName: this.agentAName,
      agentBName: this.agentBName,
      choiceA: this.choiceA!,
      choiceB: this.choiceB!,
      sigA: this.sigA!,
      sigB: this.sigB!,
      nonceA: this.nonceA,
      nonceB: this.nonceB,
      result,
      resultName,
      matchSalt: this.matchSalt,
    });

    // Queue settlement on chain
    const settlementData: SettlementData = {
      matchId: this.matchId,
      choiceA: this.choiceA!,
      nonceA: this.nonceA,
      sigA: this.sigA!,
      choiceB: this.choiceB!,
      nonceB: this.nonceB,
      sigB: this.sigB!,
    };

    this.chainService.queueSettlement(settlementData);

    // The chain service will call back via onSettled when tx confirms.
    // MatchEngine hooks into that callback externally.
  }

  // ─── Handle chain confirmation ─────────────────────

  onChainConfirmed(txHash: string) {
    this.state = 'COMPLETE';

    this.broadcaster.broadcast('MATCH_CONFIRMED', {
      matchId: this.matchId,
      txHash,
      agentA: this.agentA,
      agentB: this.agentB,
      agentAName: this.agentAName,
      agentBName: this.agentBName,
      choiceA: this.choiceA,
      choiceB: this.choiceB,
      result: this.choiceA !== null && this.choiceB !== null
        ? this.computeResult(this.choiceA, this.choiceB)
        : null,
    });

    this.onComplete(this.matchId);
  }

  // ─── Timeout handling ──────────────────────────────

  private async handleChoiceTimeout() {
    this.choiceTimer = null;

    if (this.state !== 'AWAITING_CHOICES') return;

    this.state = 'SETTLING';

    const aSubmitted = this.sigA !== null;
    const bSubmitted = this.sigB !== null;

    // Broadcast timeout event
    this.broadcaster.broadcast('CHOICE_TIMEOUT', {
      matchId: this.matchId,
      agentA: this.agentA,
      agentB: this.agentB,
      agentAName: this.agentAName,
      agentBName: this.agentBName,
      agentASubmitted: aSubmitted,
      agentBSubmitted: bSubmitted,
    });

    try {
      let txHash: string;

      if (aSubmitted && !bSubmitted) {
        // Agent A submitted, B timed out
        txHash = await this.chainService.settlePartialTimeout(
          this.matchId,
          this.choiceA!,
          this.nonceA,
          this.sigA!,
          false // agentATimedOut = false (B timed out)
        );
      } else if (!aSubmitted && bSubmitted) {
        // Agent B submitted, A timed out
        txHash = await this.chainService.settlePartialTimeout(
          this.matchId,
          this.choiceB!,
          this.nonceB,
          this.sigB!,
          true // agentATimedOut = true (A timed out)
        );
      } else {
        // Neither submitted
        txHash = await this.chainService.settleTimeout(this.matchId);
      }

      this.state = 'COMPLETE';

      this.broadcaster.broadcast('MATCH_CONFIRMED', {
        matchId: this.matchId,
        txHash,
        agentA: this.agentA,
        agentB: this.agentB,
        agentAName: this.agentAName,
        agentBName: this.agentBName,
        timedOut: true,
        agentASubmitted: aSubmitted,
        agentBSubmitted: bSubmitted,
      });

      this.onComplete(this.matchId);
    } catch (err) {
      console.error(`[Match ${this.matchId}] Timeout settlement failed:`, err);
      // Mark complete anyway to avoid stuck matches
      this.state = 'COMPLETE';
      this.onComplete(this.matchId);
    }
  }

  // ─── Result computation ────────────────────────────

  private computeResult(choiceA: number, choiceB: number): MatchResult {
    if (choiceA === CHOICE_SPLIT && choiceB === CHOICE_SPLIT) return MatchResult.BOTH_SPLIT;
    if (choiceA === CHOICE_STEAL && choiceB === CHOICE_SPLIT) return MatchResult.AGENT_A_STEALS;
    if (choiceA === CHOICE_SPLIT && choiceB === CHOICE_STEAL) return MatchResult.AGENT_B_STEALS;
    return MatchResult.BOTH_STEAL;
  }

  private resultToString(result: MatchResult): string {
    switch (result) {
      case MatchResult.BOTH_SPLIT: return 'BOTH_SPLIT';
      case MatchResult.AGENT_A_STEALS: return 'AGENT_A_STEALS';
      case MatchResult.AGENT_B_STEALS: return 'AGENT_B_STEALS';
      case MatchResult.BOTH_STEAL: return 'BOTH_STEAL';
    }
  }

  // ─── Cleanup ───────────────────────────────────────

  destroy() {
    if (this.negotiationTimer) {
      clearTimeout(this.negotiationTimer);
      this.negotiationTimer = null;
    }
    if (this.choiceTimer) {
      clearTimeout(this.choiceTimer);
      this.choiceTimer = null;
    }
  }

  // ─── Getters for reconnection / status ─────────────

  getState() {
    return this.state;
  }

  getPublicState() {
    return {
      matchId: this.matchId,
      agentA: this.agentA,
      agentB: this.agentB,
      agentAName: this.agentAName,
      agentBName: this.agentBName,
      tournamentId: this.tournamentId,
      state: this.state,
      phaseDeadline: this.phaseDeadline,
      messages: this.messages,
      choiceALocked: this.sigA !== null,
      choiceBLocked: this.sigB !== null,
      commitHashA: this.commitHashA,
      commitHashB: this.commitHashB,
    };
  }

  getChoices(): { choiceA: number | null; choiceB: number | null } {
    return { choiceA: this.choiceA, choiceB: this.choiceB };
  }
}

// ─── MatchEngine ─────────────────────────────────────

export class MatchEngine {
  private matches: Map<number, MatchStateMachine> = new Map();
  private agentMatches: Map<string, number> = new Map(); // lowercase address -> matchId
  private broadcaster: Broadcaster;
  private chainService: ChainService;
  private onMatchComplete: ((matchId: number, agentA: string, agentB: string) => void) | null = null;

  constructor(broadcaster: Broadcaster, chainService: ChainService) {
    this.broadcaster = broadcaster;
    this.chainService = chainService;

    // Hook into chain service settlement confirmations
    this.chainService.setOnSettled((matchId, txHash) => {
      const match = this.matches.get(matchId);
      if (match) {
        match.onChainConfirmed(txHash);
      }
    });
  }

  setOnMatchComplete(cb: (matchId: number, agentA: string, agentB: string) => void) {
    this.onMatchComplete = cb;
  }

  // ─── Create matches ────────────────────────────────

  createMatches(
    matchIds: number[],
    pairs: { agentA: string; agentB: string }[],
    tournamentId: number = 0
  ) {
    for (let i = 0; i < matchIds.length; i++) {
      const matchId = matchIds[i];
      const pair = pairs[i];

      const match = new MatchStateMachine(
        matchId,
        pair.agentA,
        pair.agentB,
        tournamentId,
        this.broadcaster,
        this.chainService,
        (id) => this.handleMatchComplete(id)
      );

      this.matches.set(matchId, match);
      this.agentMatches.set(pair.agentA.toLowerCase(), matchId);
      this.agentMatches.set(pair.agentB.toLowerCase(), matchId);
    }
  }

  // ─── Negotiation message ───────────────────────────

  onNegotiationMessage(matchId: number, from: string, message: string): boolean {
    const match = this.matches.get(matchId);
    if (!match) return false;

    match.onMessage(from, message);
    return true;
  }

  // ─── Choice submission ─────────────────────────────

  onChoiceSubmitted(
    matchId: number,
    from: string,
    choice: number,
    signature: string
  ): { success: boolean; error?: string } {
    const match = this.matches.get(matchId);
    if (!match) {
      return { success: false, error: 'Match not found' };
    }

    return match.onChoice(from, choice, signature);
  }

  // ─── Query helpers ─────────────────────────────────

  isInMatch(address: string): boolean {
    const matchId = this.agentMatches.get(address.toLowerCase());
    if (matchId === undefined) return false;

    const match = this.matches.get(matchId);
    if (!match) return false;

    // Only consider active (non-complete) matches
    return match.getState() !== 'COMPLETE';
  }

  getActiveMatch(address: string): ReturnType<MatchStateMachine['getPublicState']> | null {
    const matchId = this.agentMatches.get(address.toLowerCase());
    if (matchId === undefined) return null;

    const match = this.matches.get(matchId);
    if (!match) return null;

    if (match.getState() === 'COMPLETE') return null;

    return match.getPublicState();
  }

  getMatch(matchId: number): MatchStateMachine | undefined {
    return this.matches.get(matchId);
  }

  getActiveMatches(): ReturnType<MatchStateMachine['getPublicState']>[] {
    const active: ReturnType<MatchStateMachine['getPublicState']>[] = [];
    for (const match of this.matches.values()) {
      if (match.getState() !== 'COMPLETE') {
        active.push(match.getPublicState());
      }
    }
    return active;
  }

  // ─── Match completion ──────────────────────────────

  private handleMatchComplete(matchId: number) {
    const match = this.matches.get(matchId);
    if (!match) return;

    const agentA = match.agentA;
    const agentB = match.agentB;

    // Clean up agent -> match index
    const currentA = this.agentMatches.get(agentA.toLowerCase());
    if (currentA === matchId) {
      this.agentMatches.delete(agentA.toLowerCase());
    }

    const currentB = this.agentMatches.get(agentB.toLowerCase());
    if (currentB === matchId) {
      this.agentMatches.delete(agentB.toLowerCase());
    }

    // Destroy timers
    match.destroy();

    console.log(`[Match ${matchId}] Complete. ${agentA} vs ${agentB}`);

    // Keep match in the map for 5 minutes so it can still be fetched via API,
    // then clean up to avoid unbounded memory growth.
    setTimeout(() => {
      this.matches.delete(matchId);
    }, 5 * 60 * 1000);

    // Notify callback (e.g., QueueManager to re-queue agents)
    if (this.onMatchComplete) {
      this.onMatchComplete(matchId, agentA, agentB);
    }
  }
}
