import { Broadcaster } from '../broadcast/events.js';
import { QueueManager } from '../engine/queue.js';

// ─── HttpAgentBridge (virtual WebSocket) ────────────────
//
// The Broadcaster's sendTo() checks ws.readyState === WebSocket.OPEN (which is 1)
// and calls ws.send(data). This class satisfies that interface, buffering events
// for HTTP long-polling instead of pushing over a real WebSocket.

export class HttpAgentBridge {
  readyState = 1; // WebSocket.OPEN
  private eventBuffer: any[] = [];
  private waitingResolve: ((events: any[]) => void) | null = null;

  send(data: string) {
    const event = JSON.parse(data);
    if (this.waitingResolve) {
      this.waitingResolve([event]);
      this.waitingResolve = null;
    } else {
      this.eventBuffer.push(event);
      if (this.eventBuffer.length > 100) this.eventBuffer.shift();
    }
  }

  async pollEvents(timeoutMs = 30000): Promise<any[]> {
    if (this.eventBuffer.length > 0) {
      const events = [...this.eventBuffer];
      this.eventBuffer = [];
      return events;
    }
    return new Promise(resolve => {
      this.waitingResolve = resolve;
      setTimeout(() => {
        this.waitingResolve = null;
        resolve([]);
      }, timeoutMs);
    });
  }

  close() {
    this.readyState = 3; // WebSocket.CLOSED
    if (this.waitingResolve) {
      this.waitingResolve([]);
      this.waitingResolve = null;
    }
  }
}

// ─── HttpSessionManager ─────────────────────────────────

interface HttpSession {
  token: string;
  address: string;
  name: string;
  bridge: HttpAgentBridge;
  lastActivity: number;
}

const SESSION_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 60 * 1000;    // check every 60s

export class HttpSessionManager {
  private sessions: Map<string, HttpSession> = new Map();       // token → session
  private addressToToken: Map<string, string> = new Map();       // address → token
  private cleanupTimer: NodeJS.Timeout | null = null;

  createSession(address: string, name: string, bridge: HttpAgentBridge, broadcaster?: Broadcaster, queueManager?: QueueManager): string {
    // Invalidate old session from same address (pass broadcaster to remove old bridge)
    const oldToken = this.addressToToken.get(address.toLowerCase());
    if (oldToken) {
      this.destroySession(oldToken, broadcaster, queueManager);
    }

    const token = this.generateToken();
    const session: HttpSession = {
      token,
      address,
      name,
      bridge,
      lastActivity: Date.now(),
    };

    this.sessions.set(token, session);
    this.addressToToken.set(address.toLowerCase(), token);

    return token;
  }

  getSession(token: string): HttpSession | null {
    return this.sessions.get(token) || null;
  }

  touchSession(token: string): void {
    const session = this.sessions.get(token);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  destroySession(token: string, broadcaster?: Broadcaster, queueManager?: QueueManager): void {
    const session = this.sessions.get(token);
    if (!session) return;

    session.bridge.close();

    if (broadcaster) {
      broadcaster.removeClient(session.bridge as any);
    }
    if (queueManager) {
      queueManager.removeFromQueue(session.address);
    }

    this.addressToToken.delete(session.address.toLowerCase());
    this.sessions.delete(token);
  }

  startCleanup(broadcaster: Broadcaster, queueManager: QueueManager): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [token, session] of this.sessions) {
        if (now - session.lastActivity > SESSION_EXPIRY_MS) {
          console.log(`[HTTP] Session expired for ${session.address}`);
          this.destroySession(token, broadcaster, queueManager);
        }
      }
    }, CLEANUP_INTERVAL_MS);
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }
}
