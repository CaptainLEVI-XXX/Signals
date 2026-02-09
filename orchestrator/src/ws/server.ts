import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { config } from '../config.js';
import { Broadcaster, ClientType } from '../broadcast/events.js';
import { AuthManager } from './auth.js';
import { MessageHandler } from './handlers.js';

export class WsServer {
  private wss: WebSocketServer;
  private broadcaster: Broadcaster;
  private authManager: AuthManager;
  private handleMessage: MessageHandler;

  constructor(broadcaster: Broadcaster, authManager: AuthManager, handler: MessageHandler) {
    this.broadcaster = broadcaster;
    this.authManager = authManager;
    this.handleMessage = handler;

    this.wss = new WebSocketServer({ port: config.wsPort });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    console.log(`WebSocket server listening on port ${config.wsPort}`);
  }

  private onConnection(ws: WebSocket, req: IncomingMessage) {
    const path = req.url || '/';
    let clientType: ClientType;

    if (path.startsWith('/ws/agent')) {
      clientType = 'agent';
    } else if (path.startsWith('/ws/bettor')) {
      clientType = 'bettor';
    } else {
      clientType = 'spectator';
    }

    this.broadcaster.addClient(ws, clientType);

    // If agent, send auth challenge
    if (clientType === 'agent') {
      const { challengeId, challenge, expiresAt } = this.authManager.generateChallenge();
      // Store challengeId on the websocket for later lookup
      (ws as any)._challengeId = challengeId;
      this.broadcaster.sendTo(ws, 'AUTH_CHALLENGE', { challenge, challengeId, expiresAt });
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(ws, clientType, msg);
      } catch {
        this.broadcaster.sendTo(ws, 'ERROR', { message: 'Invalid JSON' });
      }
    });

    ws.on('close', () => {
      const client = this.broadcaster.getClientByWs(ws);
      if (client?.address) {
        this.handleMessage(ws, clientType, { type: 'DISCONNECT', payload: { address: client.address } });
      }
      this.broadcaster.removeClient(ws);
    });

    ws.on('error', () => {
      this.broadcaster.removeClient(ws);
    });
  }

  getStats() {
    return this.broadcaster.getStats();
  }
}
