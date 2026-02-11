import { WebSocket } from 'ws';
import { ethers } from 'ethers';
import { Broadcaster } from '../broadcast/events.js';
import { ChainService } from '../chain/service.js';
import { TournamentManager } from './tournament.js';
import { MatchEngine } from './match.js';
import { QueueManager } from './queue.js';
import { buildTournamentJoinPayload, validateTournamentJoinSignature } from '../chain/signing.js';

// ─── Types ───────────────────────────────────────────

interface QueuedAgent {
  address: string;
  ws: WebSocket;
  joinedAt: number;
}

interface PendingJoin {
  agent: QueuedAgent;
  nonce: number;
}

// ─── TournamentQueueManager ─────────────────────────

export class TournamentQueueManager {
  private queue: QueuedAgent[] = [];
  private triggerTimer: NodeJS.Timeout | null = null;
  private pendingTournamentId: number | null = null;

  // Gasless join tracking: agents we've invited and are waiting for signatures from
  private pendingJoins: Map<string, PendingJoin> = new Map(); // address -> PendingJoin
  private joinedCount = 0;
  private joinDeadlineTimer: NodeJS.Timeout | null = null;

  // Config
  private readonly MIN_PLAYERS = 4;
  private readonly MAX_PLAYERS = 8;
  private readonly TOTAL_ROUNDS = 3;
  private readonly ENTRY_STAKE = ethers.parseEther('1'); // 1 ARENA
  private readonly REGISTRATION_DURATION = 120; // seconds
  private readonly TRIGGER_DELAY = 3000; // 3s buffer after hitting min
  private readonly JOIN_RESPONSE_TIMEOUT = 30_000; // 30s for agents to sign and respond

  private broadcaster: Broadcaster;
  private chainService: ChainService;
  private tournamentManager: TournamentManager;
  private matchEngine: MatchEngine;
  private queueManager: QueueManager;

  constructor(
    broadcaster: Broadcaster,
    chainService: ChainService,
    tournamentManager: TournamentManager,
    matchEngine: MatchEngine,
    queueManager: QueueManager
  ) {
    this.broadcaster = broadcaster;
    this.chainService = chainService;
    this.tournamentManager = tournamentManager;
    this.matchEngine = matchEngine;
    this.queueManager = queueManager;
  }

  // ─── Add agent to tournament queue ──────────────────

  addToQueue(agent: { address: string; ws: WebSocket }): { success: boolean; error?: string } {
    const addr = agent.address.toLowerCase();

    // Check cross-queue guard: can't be in quick match queue
    if (this.queueManager.isInQueue(agent.address)) {
      return { success: false, error: 'Already in quick match queue. Leave it first.' };
    }

    // Already in tournament queue?
    if (this.queue.some(a => a.address.toLowerCase() === addr)) {
      return { success: false, error: 'Already in tournament queue' };
    }

    // Already in active match?
    if (this.matchEngine.isInMatch(addr)) {
      return { success: false, error: 'Currently in an active match' };
    }

    // Already in a pending tournament registration?
    if (this.pendingTournamentId !== null) {
      return { success: false, error: 'Tournament already being created. Please wait.' };
    }

    this.queue.push({
      address: agent.address,
      ws: agent.ws,
      joinedAt: Date.now(),
    });

    this.broadcaster.sendTo(agent.ws, 'TOURNAMENT_QUEUE_JOINED', {
      position: this.queue.length,
      queueSize: this.queue.length,
      minPlayers: this.MIN_PLAYERS,
    });

    // Broadcast queue update
    this.broadcastQueueUpdate();

    // Check if we have enough players
    if (this.queue.length >= this.MIN_PLAYERS && !this.triggerTimer) {
      this.triggerTimer = setTimeout(() => {
        this.triggerTimer = null;
        this.triggerTournament();
      }, this.TRIGGER_DELAY);
    }

    return { success: true };
  }

  // ─── Remove agent from queue ────────────────────────

  removeFromQueue(address: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      a => a.address.toLowerCase() !== address.toLowerCase()
    );

    if (this.queue.length !== before) {
      this.broadcastQueueUpdate();

      // Cancel trigger if below minimum
      if (this.queue.length < this.MIN_PLAYERS && this.triggerTimer) {
        clearTimeout(this.triggerTimer);
        this.triggerTimer = null;
      }
    }
  }

  // ─── Handle signed join response from agent ─────────

  async onJoinSigned(
    agentAddress: string,
    tournamentId: number,
    joinSignature: string,
    permitDeadline: number,
    v: number,
    r: string,
    s: string
  ): Promise<void> {
    const addr = agentAddress.toLowerCase();

    // Validate this agent was invited to this tournament
    if (this.pendingTournamentId !== tournamentId) {
      console.warn(`[TournamentQueue] Agent ${addr} sent join for wrong tournament ${tournamentId} (pending: ${this.pendingTournamentId})`);
      return;
    }

    const pending = this.pendingJoins.get(addr);
    if (!pending) {
      console.warn(`[TournamentQueue] Agent ${addr} sent join but not in pending list`);
      return;
    }

    // Validate signature locally before submitting on-chain
    const contractAddress = this.chainService.getContractAddress();
    const valid = validateTournamentJoinSignature(
      contractAddress,
      tournamentId,
      pending.nonce,
      joinSignature,
      agentAddress
    );

    if (!valid) {
      console.warn(`[TournamentQueue] Invalid join signature from ${addr}`);
      this.broadcaster.sendTo(pending.agent.ws, 'TOURNAMENT_JOIN_FAILED', {
        tournamentId,
        reason: 'Invalid signature',
      });
      return;
    }

    // Submit on-chain: joinTournamentFor
    try {
      const txHash = await this.chainService.joinTournamentFor(
        tournamentId,
        agentAddress,
        pending.nonce,
        joinSignature,
        permitDeadline,
        v,
        r,
        s
      );

      // Register in tournament manager in-memory state
      this.tournamentManager.registerPlayer(tournamentId, agentAddress);

      this.pendingJoins.delete(addr);
      this.joinedCount++;

      this.broadcaster.sendTo(pending.agent.ws, 'TOURNAMENT_JOINED', {
        tournamentId,
        txHash,
      });

      console.log(`[TournamentQueue] Agent ${addr} joined tournament ${tournamentId} on-chain (tx: ${txHash}). ${this.joinedCount} joined so far.`);

      // Check if we have enough to start
      if (this.joinedCount >= this.MIN_PLAYERS) {
        this.clearJoinDeadline();
        await this.tryStartTournament(tournamentId);
      }
    } catch (err) {
      console.error(`[TournamentQueue] Failed to join agent ${addr} on-chain:`, err);
      this.broadcaster.sendTo(pending.agent.ws, 'TOURNAMENT_JOIN_FAILED', {
        tournamentId,
        reason: 'On-chain transaction failed',
      });
    }
  }

  // ─── Trigger tournament creation ────────────────────

  private async triggerTournament() {
    if (this.queue.length < this.MIN_PLAYERS) return;

    // Take up to MAX_PLAYERS from queue
    const participants = this.queue.splice(0, this.MAX_PLAYERS);
    this.broadcastQueueUpdate();

    try {
      // Create tournament on-chain
      const tournamentId = await this.tournamentManager.createTournament(
        this.ENTRY_STAKE,
        this.MAX_PLAYERS,
        this.TOTAL_ROUNDS,
        this.REGISTRATION_DURATION,
      );

      this.pendingTournamentId = tournamentId;
      this.joinedCount = 0;
      this.pendingJoins.clear();

      // Fetch nonces and send TOURNAMENT_JOIN_REQUEST to each participant
      const contractAddress = this.chainService.getContractAddress();

      for (const agent of participants) {
        try {
          const nonce = await this.chainService.getChoiceNonce(agent.address);

          this.pendingJoins.set(agent.address.toLowerCase(), {
            agent,
            nonce,
          });

          // Build EIP-712 typed data for the agent to sign
          const joinPayload = buildTournamentJoinPayload(contractAddress, tournamentId, nonce);

          this.broadcaster.sendTo(agent.ws, 'TOURNAMENT_JOIN_REQUEST', {
            tournamentId,
            entryStake: this.ENTRY_STAKE.toString(),
            nonce,
            signingPayload: joinPayload,
            permitData: {
              spender: contractAddress,
              value: this.ENTRY_STAKE.toString(),
            },
            registrationDuration: this.REGISTRATION_DURATION,
            minPlayers: this.MIN_PLAYERS,
            maxPlayers: this.MAX_PLAYERS,
            totalRounds: this.TOTAL_ROUNDS,
          });
        } catch (err) {
          console.error(`[TournamentQueue] Failed to prepare join request for ${agent.address}:`, err);
        }
      }

      console.log(`[TournamentQueue] Created tournament ${tournamentId}, sent join requests to ${participants.length} agents.`);

      // Set a deadline for agents to respond
      this.joinDeadlineTimer = setTimeout(() => {
        this.onJoinDeadlineReached(tournamentId, participants);
      }, this.JOIN_RESPONSE_TIMEOUT);

    } catch (err) {
      console.error('[TournamentQueue] Failed to create tournament:', err);
      // Re-queue agents
      this.queue.unshift(...participants);
      this.broadcastQueueUpdate();
      this.pendingTournamentId = null;
    }
  }

  // ─── Join deadline reached ────────────────────────

  private async onJoinDeadlineReached(tournamentId: number, invitedAgents: QueuedAgent[]) {
    this.joinDeadlineTimer = null;

    console.log(`[TournamentQueue] Join deadline reached for tournament ${tournamentId}. ${this.joinedCount} agents joined.`);

    if (this.joinedCount >= this.MIN_PLAYERS) {
      await this.tryStartTournament(tournamentId);
    } else {
      // Not enough — cancel
      try {
        await this.chainService.cancelTournament(tournamentId);
        console.log(`[TournamentQueue] Tournament ${tournamentId} cancelled — only ${this.joinedCount} joined.`);

        // Re-queue invited agents that are still connected and didn't join
        for (const agent of invitedAgents) {
          if (agent.ws.readyState === WebSocket.OPEN) {
            this.queue.push(agent);
          }
        }
        this.broadcastQueueUpdate();
      } catch (err) {
        console.error(`[TournamentQueue] Failed to cancel tournament ${tournamentId}:`, err);
      }
    }

    this.pendingTournamentId = null;
    this.pendingJoins.clear();
    this.joinedCount = 0;
  }

  // ─── Try to start tournament ────────────────────

  private async tryStartTournament(tournamentId: number) {
    try {
      await this.tournamentManager.startTournament(tournamentId);
      console.log(`[TournamentQueue] Tournament ${tournamentId} started with ${this.joinedCount} players.`);
    } catch (err) {
      console.error(`[TournamentQueue] Failed to start tournament ${tournamentId}:`, err);
    }
    this.pendingTournamentId = null;
    this.pendingJoins.clear();
    this.joinedCount = 0;
  }

  private clearJoinDeadline() {
    if (this.joinDeadlineTimer) {
      clearTimeout(this.joinDeadlineTimer);
      this.joinDeadlineTimer = null;
    }
  }

  // ─── Broadcast ─────────────────────────────────────

  private broadcastQueueUpdate() {
    this.broadcaster.broadcast('TOURNAMENT_QUEUE_UPDATE', {
      size: this.queue.length,
      minPlayers: this.MIN_PLAYERS,
      agents: this.queue.map(a => a.address),
    });
  }

  // ─── Query helpers ────────────────────────────────

  getQueueSize(): number {
    return this.queue.length;
  }

  getQueuedAddresses(): string[] {
    return this.queue.map(a => a.address);
  }

  isInQueue(address: string): boolean {
    return this.queue.some(
      a => a.address.toLowerCase() === address.toLowerCase()
    );
  }
}
