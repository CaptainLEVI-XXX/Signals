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
  tournamentQueueManager: import('../engine/tournament-queue.js').TournamentQueueManager;
}

export function createMessageHandler(deps: HandlerDeps): MessageHandler {
  const { authManager, broadcaster, chainService, queueManager, matchEngine, tournamentQueueManager } = deps;

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
        chainService.isRegistered(address).then(async (registered) => {
          if (!registered) {
            broadcaster.sendTo(ws, 'AUTH_FAILED', { reason: 'Agent not registered on-chain' });
            ws.close();
            return;
          }

          // Fetch on-chain name from AgentRegistry
          const agentName = await chainService.getAgentName(address) || `${address.slice(0, 6)}...${address.slice(-4)}`;
          broadcaster.authenticateAgent(ws, address, agentName);
          broadcaster.sendTo(ws, 'AUTH_SUCCESS', { address, name: agentName });
          console.log(`Agent authenticated: ${address} (${agentName})`);
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

      // ─── TOURNAMENT QUEUE ────────────────────
      case 'JOIN_TOURNAMENT_QUEUE': {
        const client = broadcaster.getClientByWs(ws);
        if (!client?.address) {
          broadcaster.sendTo(ws, 'ERROR', { message: 'Not authenticated' });
          return;
        }
        const result = tournamentQueueManager.addToQueue({ address: client.address, ws });
        if (!result.success) {
          broadcaster.sendTo(ws, 'ERROR', { message: result.error || 'Failed to join tournament queue' });
        }
        break;
      }

      case 'LEAVE_TOURNAMENT_QUEUE': {
        const client = broadcaster.getClientByWs(ws);
        if (client?.address) {
          tournamentQueueManager.removeFromQueue(client.address);
        }
        break;
      }

      case 'TOURNAMENT_JOIN_SIGNED': {
        const client = broadcaster.getClientByWs(ws);
        if (!client?.address) {
          broadcaster.sendTo(ws, 'ERROR', { message: 'Not authenticated' });
          return;
        }
        const joinPayload = payload as {
          tournamentId: number;
          joinSignature: string;
          permitDeadline: number;
          v: number;
          r: string;
          s: string;
        };
        tournamentQueueManager.onJoinSigned(
          client.address,
          joinPayload.tournamentId,
          joinPayload.joinSignature,
          joinPayload.permitDeadline,
          joinPayload.v,
          joinPayload.r,
          joinPayload.s
        );
        break;
      }

      // ─── DISCONNECT ─────────────────────────
      case 'DISCONNECT': {
        const { address } = payload as { address: string };
        queueManager.removeFromQueue(address);
        tournamentQueueManager.removeFromQueue(address);
        // Match engine handles disconnect internally via isAgentConnected checks
        break;
      }

      default:
        broadcaster.sendTo(ws, 'ERROR', { message: `Unknown message type: ${type}` });
    }
  };
}
