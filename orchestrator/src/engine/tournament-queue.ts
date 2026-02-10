import { WebSocket } from 'ws';
import { ethers } from 'ethers';
import { Broadcaster } from '../broadcast/events.js';
import { ChainService } from '../chain/service.js';
import { TournamentManager } from './tournament.js';
import { MatchEngine } from './match.js';
import { QueueManager } from './queue.js';

// ─── Types ───────────────────────────────────────────

interface QueuedAgent {
  address: string;
  ws: WebSocket;
  joinedAt: number;
}

// ─── TournamentQueueManager ─────────────────────────

export class TournamentQueueManager {
  private queue: QueuedAgent[] = [];
  private triggerTimer: NodeJS.Timeout | null = null;
  private registrationPollTimer: NodeJS.Timeout | null = null;
  private pendingTournamentId: number | null = null;

  // Config
  private readonly MIN_PLAYERS = 4;
  private readonly MAX_PLAYERS = 8;
  private readonly TOTAL_ROUNDS = 3;
  private readonly ENTRY_STAKE = ethers.parseEther('1'); // 1 ARENA
  private readonly REGISTRATION_DURATION = 120; // seconds
  private readonly TRIGGER_DELAY = 3000; // 3s buffer after hitting min

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

      // Send TOURNAMENT_INVITE to each participant
      for (const agent of participants) {
        this.broadcaster.sendTo(agent.ws, 'TOURNAMENT_INVITE', {
          tournamentId,
          entryStake: this.ENTRY_STAKE.toString(),
          registrationDuration: this.REGISTRATION_DURATION,
          minPlayers: this.MIN_PLAYERS,
          maxPlayers: this.MAX_PLAYERS,
          totalRounds: this.TOTAL_ROUNDS,
        });
      }

      console.log(`[TournamentQueue] Created tournament ${tournamentId}, invited ${participants.length} agents.`);

      // Monitor registration — poll every 2s
      this.startRegistrationMonitor(tournamentId, participants);
    } catch (err) {
      console.error('[TournamentQueue] Failed to create tournament:', err);
      // Re-queue agents
      this.queue.unshift(...participants);
      this.broadcastQueueUpdate();
      this.pendingTournamentId = null;
    }
  }

  // ─── Monitor registration ──────────────────────────

  private startRegistrationMonitor(tournamentId: number, invitedAgents: QueuedAgent[]) {
    let elapsed = 0;
    const pollInterval = 2000;

    this.registrationPollTimer = setInterval(async () => {
      elapsed += pollInterval;

      const tournament = this.tournamentManager.getTournament(tournamentId);
      if (!tournament) {
        this.clearRegistrationMonitor();
        return;
      }

      const playerCount = tournament.playerCount ?? 0;

      // If enough players joined and we haven't started yet
      if (playerCount >= this.MIN_PLAYERS && tournament.phase === 'REGISTRATION') {
        this.clearRegistrationMonitor();
        try {
          await this.tournamentManager.startTournament(tournamentId);
          console.log(`[TournamentQueue] Tournament ${tournamentId} started with ${playerCount} players.`);
        } catch (err) {
          console.error(`[TournamentQueue] Failed to start tournament ${tournamentId}:`, err);
        }
        this.pendingTournamentId = null;
        return;
      }

      // Registration deadline passed
      if (elapsed >= this.REGISTRATION_DURATION * 1000) {
        this.clearRegistrationMonitor();

        if (playerCount >= this.MIN_PLAYERS) {
          // Enough players — start
          try {
            await this.tournamentManager.startTournament(tournamentId);
            console.log(`[TournamentQueue] Tournament ${tournamentId} started at deadline with ${playerCount} players.`);
          } catch (err) {
            console.error(`[TournamentQueue] Failed to start tournament ${tournamentId} at deadline:`, err);
          }
        } else {
          // Not enough — cancel
          try {
            await this.chainService.cancelTournament(tournamentId);
            console.log(`[TournamentQueue] Tournament ${tournamentId} cancelled — only ${playerCount} joined.`);

            // Re-queue invited agents that are still connected
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
      }
    }, pollInterval);
  }

  private clearRegistrationMonitor() {
    if (this.registrationPollTimer) {
      clearInterval(this.registrationPollTimer);
      this.registrationPollTimer = null;
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
