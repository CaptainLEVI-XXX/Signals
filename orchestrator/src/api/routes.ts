import express from 'express';
import cors from 'cors';
import { config } from '../config.js';
import { ChainService } from '../chain/service.js';
import { MatchEngine } from '../engine/match.js';
import { QueueManager } from '../engine/queue.js';
import { TournamentManager } from '../engine/tournament.js';
import { TournamentQueueManager } from '../engine/tournament-queue.js';
import { Broadcaster } from '../broadcast/events.js';

export interface ApiDeps {
  chainService: ChainService;
  matchEngine: MatchEngine;
  queueManager: QueueManager;
  tournamentManager: TournamentManager;
  tournamentQueueManager: TournamentQueueManager;
  broadcaster: Broadcaster;
}

export function createApi(deps: ApiDeps): express.Express {
  const { chainService, matchEngine, queueManager, tournamentManager, tournamentQueueManager, broadcaster } = deps;

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

  // ─── Active matches ─────────────────────────────────

  app.get('/matches/active', (_req, res) => {
    const matches = matchEngine.getActiveMatches();
    res.json({ matches });
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

  // ─── Pool state ────────────────────────────────────────

  app.get('/match/:id/pool', async (req, res) => {
    const matchId = parseInt(req.params.id);
    if (isNaN(matchId)) {
      res.status(400).json({ error: 'Invalid match ID' });
      return;
    }

    try {
      const pool = await chainService.getPool(matchId);
      const outcomePools = await chainService.getOutcomePools(matchId);
      res.json({
        matchId,
        state: Number(pool.state),
        totalPool: pool.totalPool.toString(),
        outcomePools: {
          BOTH_SPLIT: outcomePools[1].toString(),
          A_STEALS: outcomePools[2].toString(),
          B_STEALS: outcomePools[3].toString(),
          BOTH_STEAL: outcomePools[4].toString(),
        },
        result: Number(pool.result),
      });
    } catch {
      res.status(404).json({ error: 'Pool not found' });
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

  // ─── Leaderboard (on-chain stats) ───────────────────

  app.get('/leaderboard', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    try {
      const result = await chainService.getLeaderboard(limit, offset);
      res.json(result);
    } catch (err) {
      console.error('Failed to fetch leaderboard:', err);
      res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
  });

  // ─── Agent stats (on-chain) ─────────────────────────

  app.get('/agent/:address/stats', async (req, res) => {
    try {
      const address = req.params.address;
      const stats = await chainService.getAgentStats(address);
      const name = await chainService.getAgentName(address);

      if (stats.totalMatches === 0 && !name) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      res.json({
        agent: {
          address,
          name: name || `${address.slice(0, 6)}...${address.slice(-4)}`,
          matchesPlayed: stats.totalMatches,
          totalSplits: stats.splits,
          totalSteals: stats.steals,
          totalPoints: stats.totalPoints,
          tournamentsPlayed: stats.tournamentsPlayed,
          tournamentsWon: stats.tournamentsWon,
          totalEarnings: stats.totalPrizesEarned,
          splitRate: stats.totalMatches > 0
            ? stats.splits / stats.totalMatches
            : 0,
        },
      });
    } catch (err) {
      console.error('Failed to fetch agent stats:', err);
      res.status(500).json({ error: 'Failed to fetch agent stats' });
    }
  });

  // ─── Agent matches (placeholder — on-chain match history not tracked yet) ──

  app.get('/agent/:address/matches', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    // On-chain contract does not store per-agent match lists
    // Return empty array for now — frontend handles gracefully
    res.json({ matches: [], total: 0 });
  });

  // ─── Tournament queue ───────────────────────────────

  app.get('/tournament-queue', (_req, res) => {
    res.json({
      size: tournamentQueueManager.getQueueSize(),
      agents: tournamentQueueManager.getQueuedAddresses(),
    });
  });

  return app;
}
