import { config } from './config.js';
import { ChainService } from './chain/service.js';
import { Broadcaster } from './broadcast/events.js';
import { AuthManager } from './ws/auth.js';
import { createMessageHandler } from './ws/handlers.js';
import { WsServer } from './ws/server.js';
import { MatchEngine } from './engine/match.js';
import { QueueManager } from './engine/queue.js';
import { TournamentManager } from './engine/tournament.js';
import { createApi } from './api/routes.js';

async function main() {
  console.log('=== Signals Orchestrator ===');
  console.log(`Chain: ${config.rpcUrl} (chainId ${config.chainId})`);
  console.log(`Contract: ${config.splitOrStealAddress}`);
  console.log('');

  // ─── Validate config ───────────────────────────────

  if (!config.operatorPrivateKey) {
    console.error('OPERATOR_PRIVATE_KEY is required');
    process.exit(1);
  }

  if (!config.splitOrStealAddress) {
    console.error('SPLIT_OR_STEAL_ADDRESS is required');
    process.exit(1);
  }

  // ─── Initialize services ───────────────────────────

  const chainService = new ChainService();
  const broadcaster = new Broadcaster();
  const authManager = new AuthManager();
  const matchEngine = new MatchEngine(broadcaster, chainService);
  const queueManager = new QueueManager(broadcaster, chainService, matchEngine);
  const tournamentManager = new TournamentManager(broadcaster, chainService, matchEngine);

  // ─── Wire callbacks ────────────────────────────────

  // When a match completes, re-queue connected agents for quick matches
  matchEngine.setOnMatchComplete((matchId, agentA, agentB) => {
    // Check if this is a tournament match
    const match = matchEngine.getMatch(matchId);
    if (match) {
      // Tournament match -> let tournament manager handle it
      tournamentManager.onMatchComplete(matchId, agentA, agentB);
      return;
    }

    // Quick match -> re-queue agents if still connected
    const wsA = broadcaster.getAgentWs(agentA);
    const wsB = broadcaster.getAgentWs(agentB);

    if (wsA) {
      queueManager.addToQueue({ address: agentA, ws: wsA });
    }
    if (wsB) {
      queueManager.addToQueue({ address: agentB, ws: wsB });
    }
  });

  // ─── Create message handler ─────────────────────────

  const messageHandler = createMessageHandler({
    authManager,
    broadcaster,
    chainService,
    queueManager,
    matchEngine,
  });

  // ─── Start WebSocket server ─────────────────────────

  const _wsServer = new WsServer(broadcaster, authManager, messageHandler);

  // ─── Start REST API ─────────────────────────────────

  const api = createApi({
    chainService,
    matchEngine,
    queueManager,
    tournamentManager,
    broadcaster,
  });

  api.listen(config.port, () => {
    console.log(`REST API listening on port ${config.port}`);
    console.log('');
    console.log('Ready. Waiting for agents...');
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
