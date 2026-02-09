import { WebSocket } from 'ws';

export type ClientType = 'agent' | 'spectator' | 'bettor';

export interface ConnectedClient {
  ws: WebSocket;
  type: ClientType;
  address?: string;    // only for authenticated agents
  agentName?: string;  // only for authenticated agents
}

interface WsMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

export class Broadcaster {
  private clients: Map<WebSocket, ConnectedClient> = new Map();

  addClient(ws: WebSocket, type: ClientType) {
    this.clients.set(ws, { ws, type });
  }

  removeClient(ws: WebSocket) {
    this.clients.delete(ws);
  }

  authenticateAgent(ws: WebSocket, address: string, agentName: string) {
    const client = this.clients.get(ws);
    if (client) {
      client.address = address;
      client.agentName = agentName;
    }
  }

  getClientByWs(ws: WebSocket): ConnectedClient | undefined {
    return this.clients.get(ws);
  }

  getAgentByAddress(address: string): ConnectedClient | undefined {
    for (const client of this.clients.values()) {
      if (client.type === 'agent' && client.address?.toLowerCase() === address.toLowerCase()) {
        return client;
      }
    }
    return undefined;
  }

  getAgentWs(address: string): WebSocket | undefined {
    return this.getAgentByAddress(address)?.ws;
  }

  isAgentConnected(address: string): boolean {
    return this.getAgentByAddress(address) !== undefined;
  }

  // Send to a specific WebSocket
  sendTo(ws: WebSocket, type: string, payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      const msg: WsMessage = { type, payload, timestamp: Date.now() };
      ws.send(JSON.stringify(msg));
    }
  }

  // Send to a specific agent by address
  sendToAgent(address: string, type: string, payload: Record<string, unknown>) {
    const ws = this.getAgentWs(address);
    if (ws) this.sendTo(ws, type, payload);
  }

  // Broadcast to all clients of given types
  broadcast(type: string, payload: Record<string, unknown>, to: ClientType[] = ['agent', 'spectator', 'bettor']) {
    const msg: WsMessage = { type, payload, timestamp: Date.now() };
    const data = JSON.stringify(msg);

    for (const client of this.clients.values()) {
      if (to.includes(client.type) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // Broadcast to all (spectators + bettors only, not agents)
  broadcastPublic(type: string, payload: Record<string, unknown>) {
    this.broadcast(type, payload, ['spectator', 'bettor']);
  }

  // Broadcast to bettors only (includes odds data)
  broadcastToBettors(type: string, payload: Record<string, unknown>) {
    this.broadcast(type, payload, ['bettor']);
  }

  // Get connected counts
  getStats() {
    let agents = 0, spectators = 0, bettors = 0;
    for (const client of this.clients.values()) {
      if (client.type === 'agent') agents++;
      else if (client.type === 'spectator') spectators++;
      else bettors++;
    }
    return { agents, spectators, bettors, total: this.clients.size };
  }
}
