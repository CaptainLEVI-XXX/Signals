import express from 'express';
import cors from 'cors';
import { config } from '../config.js';
import { ChainService } from '../chain/service.js';
import { MatchEngine } from '../engine/match.js';
import { QueueManager } from '../engine/queue.js';
import { TournamentManager } from '../engine/tournament.js';
import { Broadcaster } from '../broadcast/events.js';

export interface ApiDeps {
  chainService: ChainService;
  matchEngine: MatchEngine;
  queueManager: QueueManager;
  tournamentManager: TournamentManager;
  broadcaster: Broadcaster;
}

export function createApi(deps: ApiDeps): express.Express {
  const { chainService, matchEngine, queueManager, tournamentManager, broadcaster } = deps;

  const app = express();
  app.use(cors());
  app.use(express.json());

  // ─── Health ──────────────────────────────────────────

  app.get('/health', (_req, res) => {
    const stats = broadcaster.getStats();
    res.json({
      status: 'ok',
      connections: stats,
      queueSize: queueManager.getQueueSize(),
      activeTournaments: tournamentManager.getActiveTournaments(),
    });
  });

  // ─── Match info ──────────────────────────────────────

  app.get('/match/:id', async (req, res) => {
    const matchId = parseInt(req.params.id);
    if (isNaN(matchId)) {
      res.status(400).json({ error: 'Invalid match ID' });
      return;
    }

    // Check engine first (active match with live state)
    const engineMatch = matchEngine.getMatch(matchId);
    if (engineMatch) {
      res.json({ source: 'engine', match: engineMatch.getPublicState() });
      return;
    }

    // Fall back to on-chain data
    try {
      const onChain = await chainService.getMatch(matchId);
      res.json({ source: 'chain', match: onChain });
    } catch {
      res.status(404).json({ error: 'Match not found' });
    }
  });

  // ─── Betting odds ────────────────────────────────────

  app.get('/match/:id/odds', async (req, res) => {
    const matchId = parseInt(req.params.id);
    if (isNaN(matchId)) {
      res.status(400).json({ error: 'Invalid match ID' });
      return;
    }

    try {
      const pool = await chainService.getPool(matchId);
      const odds = await Promise.all([
        chainService.getOdds(matchId, 0), // BOTH_SPLIT
        chainService.getOdds(matchId, 1), // A_STEALS
        chainService.getOdds(matchId, 2), // B_STEALS
        chainService.getOdds(matchId, 3), // BOTH_STEAL
      ]);

      res.json({
        matchId,
        pool: pool.toString(),
        odds: {
          bothSplit: odds[0].toString(),
          aSteal: odds[1].toString(),
          bSteal: odds[2].toString(),
          bothSteal: odds[3].toString(),
        },
      });
    } catch {
      res.status(404).json({ error: 'Match not found or betting not active' });
    }
  });

  // ─── Queue status ────────────────────────────────────

  app.get('/queue', (_req, res) => {
    res.json({
      size: queueManager.getQueueSize(),
      agents: queueManager.getQueuedAddresses(),
    });
  });

  // ─── Tournament info ─────────────────────────────────

  app.get('/tournament/:id', (req, res) => {
    const tournamentId = parseInt(req.params.id);
    if (isNaN(tournamentId)) {
      res.status(400).json({ error: 'Invalid tournament ID' });
      return;
    }

    const tournament = tournamentManager.getTournament(tournamentId);
    if (!tournament) {
      res.status(404).json({ error: 'Tournament not found' });
      return;
    }

    res.json(tournament);
  });

  app.get('/tournament/:id/standings', (req, res) => {
    const tournamentId = parseInt(req.params.id);
    if (isNaN(tournamentId)) {
      res.status(400).json({ error: 'Invalid tournament ID' });
      return;
    }

    const standings = tournamentManager.getStandings(tournamentId);
    res.json({ tournamentId, standings });
  });

  app.get('/tournaments/active', (_req, res) => {
    const ids = tournamentManager.getActiveTournaments();
    const tournaments = ids.map(id => tournamentManager.getTournament(id));
    res.json({ tournaments });
  });

  // ─── Agent info ──────────────────────────────────────

  app.get('/agent/:address/status', (req, res) => {
    const address = req.params.address;

    const inQueue = queueManager.isInQueue(address);
    const activeMatch = matchEngine.getActiveMatch(address);
    const connected = broadcaster.isAgentConnected(address);

    res.json({
      address,
      connected,
      inQueue,
      activeMatch,
    });
  });

  // ─── Stats ───────────────────────────────────────────

  app.get('/stats', (_req, res) => {
    const wsStats = broadcaster.getStats();
    res.json({
      connections: wsStats,
      queueSize: queueManager.getQueueSize(),
      activeTournaments: tournamentManager.getActiveTournaments().length,
    });
  });

  return app;
}
