import { WebSocket } from 'ws';
import { config } from '../config.js';
import { Broadcaster } from '../broadcast/events.js';
import { ChainService, QuickMatchPair } from '../chain/service.js';
import { MatchEngine } from './match.js';

// ─── Types ───────────────────────────────────────────

interface QueuedAgent {
  address: string;
  ws: WebSocket;
  joinedAt: number;
}

// ─── QueueManager ────────────────────────────────────

export class QueueManager {
  private queue: QueuedAgent[] = [];
  private recentOpponents: Map<string, string> = new Map(); // address -> last opponent address
  private pairingTimer: NodeJS.Timeout | null = null;

  private broadcaster: Broadcaster;
  private chainService: ChainService;
  private matchEngine: MatchEngine;

  constructor(broadcaster: Broadcaster, chainService: ChainService, matchEngine: MatchEngine) {
    this.broadcaster = broadcaster;
    this.chainService = chainService;
    this.matchEngine = matchEngine;
  }

  // ─── Add agent to queue ────────────────────────────

  addToQueue(agent: { address: string; ws: WebSocket }) {
    const addr = agent.address.toLowerCase();

    // Already in queue?
    if (this.queue.find(a => a.address.toLowerCase() === addr)) return;

    // Already in active match?
    if (this.matchEngine.isInMatch(addr)) return;

    this.queue.push({
      address: agent.address,
      ws: agent.ws,
      joinedAt: Date.now(),
    });

    this.broadcaster.sendTo(agent.ws, 'QUEUE_JOINED', {
      position: this.queue.length,
      queueSize: this.queue.length,
    });

    // Broadcast updated queue size to spectators
    this.broadcaster.broadcastPublic('QUEUE_UPDATE', {
      queueSize: this.queue.length,
    });

    this.schedulePairing();
  }

  // ─── Remove agent from queue ───────────────────────

  removeFromQueue(address: string) {
    const before = this.queue.length;
    this.queue = this.queue.filter(
      a => a.address.toLowerCase() !== address.toLowerCase()
    );

    if (this.queue.length !== before) {
      this.broadcaster.broadcastPublic('QUEUE_UPDATE', {
        queueSize: this.queue.length,
      });
    }
  }

  // ─── Schedule pairing with buffer ──────────────────

  private schedulePairing() {
    if (this.pairingTimer) return;

    // Buffer for 200ms to batch multiple queue joins into one batch tx
    this.pairingTimer = setTimeout(() => {
      this.pairingTimer = null;
      this.tryPair();
    }, 200);
  }

  // ─── Greedy FIFO pairing with anti-rematch ─────────

  private async tryPair() {
    if (this.queue.length < 2) return;

    const pairs: QuickMatchPair[] = [];
    const pairedAddresses = new Set<string>();

    // Greedy pairing: iterate and pair non-recent opponents
    for (let i = 0; i < this.queue.length; i++) {
      const agentA = this.queue[i];
      if (pairedAddresses.has(agentA.address.toLowerCase())) continue;

      for (let j = i + 1; j < this.queue.length; j++) {
        const agentB = this.queue[j];
        if (pairedAddresses.has(agentB.address.toLowerCase())) continue;

        // Anti-rematch check: skip if they just played each other,
        // unless there are only 2 agents left in the queue
        const lastOpponent = this.recentOpponents.get(agentA.address.toLowerCase());
        if (lastOpponent === agentB.address.toLowerCase() && this.queue.length > 2) {
          continue;
        }

        pairs.push({ agentA: agentA.address, agentB: agentB.address });
        pairedAddresses.add(agentA.address.toLowerCase());
        pairedAddresses.add(agentB.address.toLowerCase());

        // Track recent opponents
        this.recentOpponents.set(agentA.address.toLowerCase(), agentB.address.toLowerCase());
        this.recentOpponents.set(agentB.address.toLowerCase(), agentA.address.toLowerCase());
        break;
      }
    }

    if (pairs.length === 0) return;

    // Remove paired agents from queue
    this.queue = this.queue.filter(
      a => !pairedAddresses.has(a.address.toLowerCase())
    );

    // Broadcast updated queue size
    this.broadcaster.broadcastPublic('QUEUE_UPDATE', {
      queueSize: this.queue.length,
    });

    try {
      // Batch create matches on-chain
      const matchIds = await this.chainService.createQuickMatchBatch(pairs);

      // Create match state machines in the engine
      this.matchEngine.createMatches(matchIds, pairs);

      console.log(`[Queue] Created ${matchIds.length} quick matches: ${matchIds.join(', ')}`);
    } catch (err) {
      console.error('[Queue] Failed to create quick match batch:', err);
      // Agents will need to re-join queue manually for safety.
      // We do NOT re-queue automatically to avoid loops on persistent chain errors.
    }

    // Check if there are still enough agents for another round
    if (this.queue.length >= 2) {
      this.schedulePairing();
    }
  }

  // ─── Query helpers ─────────────────────────────────

  getQueueSize(): number {
    return this.queue.length;
  }

  isInQueue(address: string): boolean {
    return this.queue.some(
      a => a.address.toLowerCase() === address.toLowerCase()
    );
  }

  getQueuedAddresses(): string[] {
    return this.queue.map(a => a.address);
  }
}
