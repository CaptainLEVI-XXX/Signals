import { WebSocket } from 'ws';
import { ClientType } from '../broadcast/events.js';

export interface WsIncomingMessage {
  type: string;
  payload: Record<string, unknown>;
}

// Handler function signature
export type MessageHandler = (ws: WebSocket, clientType: ClientType, msg: WsIncomingMessage) => void;

// Dependencies injected from index.ts
export interface HandlerDeps {
  authManager: import('./auth.js').AuthManager;
  broadcaster: import('../broadcast/events.js').Broadcaster;
  chainService: import('../chain/service.js').ChainService;
  queueManager: import('../engine/queue.js').QueueManager;
  matchEngine: import('../engine/match.js').MatchEngine;
}

export function createMessageHandler(deps: HandlerDeps): MessageHandler {
  const { authManager, broadcaster, chainService, queueManager, matchEngine } = deps;

  return (ws: WebSocket, clientType: ClientType, msg: WsIncomingMessage) => {
    const { type, payload } = msg;

    switch (type) {
      // ─── AUTH ───────────────────────────────
      case 'AUTH_RESPONSE': {
        const { address, signature, challengeId } = payload as {
          address: string;
          signature: string;
          challengeId: string;
        };

        const result = authManager.verifyChallenge(challengeId, address, signature);

        if (!result.valid) {
          broadcaster.sendTo(ws, 'AUTH_FAILED', { reason: result.reason });
          ws.close();
          return;
        }

        // Check on-chain registration
        chainService.isRegistered(address).then((registered) => {
          if (!registered) {
            broadcaster.sendTo(ws, 'AUTH_FAILED', { reason: 'Agent not registered on-chain' });
            ws.close();
            return;
          }

          broadcaster.authenticateAgent(ws, address, address); // name could be fetched from registry
          broadcaster.sendTo(ws, 'AUTH_SUCCESS', { address });
          console.log(`Agent authenticated: ${address}`);
        }).catch(() => {
          broadcaster.sendTo(ws, 'AUTH_FAILED', { reason: 'Failed to verify registration' });
          ws.close();
        });
        break;
      }

      // ─── QUEUE ──────────────────────────────
      case 'JOIN_QUEUE': {
        const client = broadcaster.getClientByWs(ws);
        if (!client?.address) {
          broadcaster.sendTo(ws, 'ERROR', { message: 'Not authenticated' });
          return;
        }
        queueManager.addToQueue({ address: client.address, ws });
        break;
      }

      case 'LEAVE_QUEUE': {
        const client = broadcaster.getClientByWs(ws);
        if (client?.address) {
          queueManager.removeFromQueue(client.address);
        }
        break;
      }

      // ─── MATCH MESSAGES ─────────────────────
      case 'MATCH_MESSAGE': {
        const client = broadcaster.getClientByWs(ws);
        if (!client?.address) return;

        const { matchId, message } = payload as { matchId: number; message: string };
        matchEngine.onNegotiationMessage(matchId, client.address, message);
        break;
      }

      // ─── CHOICE SUBMISSION ──────────────────
      case 'CHOICE_SUBMITTED': {
        const client = broadcaster.getClientByWs(ws);
        if (!client?.address) return;

        const choicePayload = payload as {
          matchId: number;
          choice: number;
          signature: string;
        };
        matchEngine.onChoiceSubmitted(choicePayload.matchId, client.address, choicePayload.choice, choicePayload.signature);
        break;
      }

      // ─── DISCONNECT ─────────────────────────
      case 'DISCONNECT': {
        const { address } = payload as { address: string };
        queueManager.removeFromQueue(address);
        // Match engine handles disconnect internally via isAgentConnected checks
        break;
      }

      default:
        broadcaster.sendTo(ws, 'ERROR', { message: `Unknown message type: ${type}` });
    }
  };
}
