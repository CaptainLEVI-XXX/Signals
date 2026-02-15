import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { config } from '../config.js';
import { ChainService } from '../chain/service.js';
import { MatchEngine } from '../engine/match.js';
import { QueueManager } from '../engine/queue.js';
import { TournamentManager } from '../engine/tournament.js';
import { TournamentQueueManager } from '../engine/tournament-queue.js';
import { Broadcaster } from '../broadcast/events.js';
import { AuthManager } from '../ws/auth.js';
import { HttpAgentBridge, HttpSessionManager } from './http-agent.js';

export interface ApiDeps {
  chainService: ChainService;
  matchEngine: MatchEngine;
  queueManager: QueueManager;
  tournamentManager: TournamentManager;
  tournamentQueueManager: TournamentQueueManager;
  broadcaster: Broadcaster;
  authManager: AuthManager;
  httpSessionManager: HttpSessionManager;
}

export function createApi(deps: ApiDeps): express.Express {
  const { chainService, matchEngine, queueManager, tournamentManager, tournamentQueueManager, broadcaster, authManager, httpSessionManager } = deps;

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

  app.get('/tournament/:id', async (req, res) => {
    const tournamentId = parseInt(req.params.id);
    if (isNaN(tournamentId)) {
      res.status(400).json({ error: 'Invalid tournament ID' });
      return;
    }

    // Check in-memory engine first (active tournament with live state)
    const tournament = tournamentManager.getTournament(tournamentId);
    if (tournament) {
      res.json(tournament);
      return;
    }

    // Chain fallback for past/completed tournaments
    try {
      const t = await chainService.getTournamentOnChain(tournamentId);
      if (t.state === 0) {
        res.status(404).json({ error: 'Tournament not found' });
        return;
      }

      // Build standings from player stats
      const standings = await Promise.all(
        t.players.map(async (player, i) => {
          const stats = await chainService.getPlayerStatsOnChain(tournamentId, player);
          return {
            address: player,
            name: t.playerNames[i] || `${player.slice(0, 6)}...${player.slice(-4)}`,
            points: stats.points,
            matchesPlayed: stats.matchesPlayed,
          };
        })
      );
      standings.sort((a, b) => b.points - a.points);

      const matchIds = await chainService.getTournamentMatchIds(tournamentId);

      res.json({
        id: t.id,
        state: t.stateLabel,
        phase: t.stateLabel,
        entryStake: t.entryStake,
        playerCount: t.playerCount,
        currentRound: t.currentRound,
        totalRounds: t.totalRounds,
        registrationDeadline: t.registrationDeadline,
        players: standings,
        standings,
        allMatchIds: matchIds,
      });
    } catch (err) {
      console.error('Failed to fetch tournament from chain:', err);
      res.status(404).json({ error: 'Tournament not found' });
    }
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

  // ─── All tournaments (chain-backed) ───────────────

  app.get('/tournaments/all', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    try {
      const result = await chainService.getAllTournaments(limit, offset);
      // Map to frontend-friendly format
      const tournaments = result.tournaments.map(t => ({
        id: t.id,
        state: t.stateLabel,
        phase: t.stateLabel,
        entryStake: t.entryStake,
        prizePool: t.prizePool,
        playerCount: t.playerCount,
        maxPlayers: t.maxPlayers,
        currentRound: t.currentRound,
        totalRounds: t.totalRounds,
        registrationDeadline: t.registrationDeadline,
        players: t.players.map((addr, i) => ({
          address: addr,
          name: t.playerNames[i] || `${addr.slice(0, 6)}...${addr.slice(-4)}`,
          points: 0,
          matchesPlayed: 0,
        })),
      }));
      res.json({ tournaments, total: result.total });
    } catch (err) {
      console.error('Failed to fetch all tournaments:', err);
      res.status(500).json({ error: 'Failed to fetch tournaments' });
    }
  });

  // ─── Recent matches (chain-backed) ────────────────

  app.get('/matches/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    try {
      const result = await chainService.getRecentMatches(limit, offset);
      res.json({ matches: result.matches, total: result.total });
    } catch (err) {
      console.error('Failed to fetch recent matches:', err);
      res.status(500).json({ error: 'Failed to fetch matches' });
    }
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

  // ─── Agent matches (chain-backed scan) ─────────────

  app.get('/agent/:address/matches', async (req, res) => {
    const address = req.params.address;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    try {
      const result = await chainService.getAgentMatchHistory(address, limit);
      const CHOICE_MAP: Record<number, string> = { 0: 'NONE', 1: 'SPLIT', 2: 'STEAL' };
      const POINTS_MAP: Record<string, number> = {
        'SPLIT_SPLIT': 3, 'SPLIT_STEAL': 0, 'STEAL_SPLIT': 5, 'STEAL_STEAL': 1,
      };

      const matches = result.matches.map(m => {
        const isAgentA = m.agentA.toLowerCase() === address.toLowerCase();
        const myChoice = isAgentA ? m.choiceA : m.choiceB;
        const oppChoice = isAgentA ? m.choiceB : m.choiceA;
        const myChoiceStr = CHOICE_MAP[myChoice] || 'NONE';
        const oppChoiceStr = CHOICE_MAP[oppChoice] || 'NONE';
        const key = `${myChoiceStr}_${oppChoiceStr}`;
        const myPoints = m.settled ? (POINTS_MAP[key] ?? 0) : undefined;

        return {
          id: m.id,
          tournamentId: m.tournamentId,
          round: m.round,
          phase: m.settled ? 'SETTLED' : 'ACTIVE',
          opponent: {
            address: isAgentA ? m.agentB : m.agentA,
            name: isAgentA ? m.agentBName : m.agentAName,
          },
          myChoice: m.settled ? myChoiceStr : undefined,
          myPoints,
        };
      });

      res.json({ matches, total: result.total });
    } catch (err) {
      console.error('Failed to fetch agent matches:', err);
      res.status(500).json({ error: 'Failed to fetch agent matches' });
    }
  });

  // ─── Bettor history (chain-backed) ─────────────────

  app.get('/bettor/:address/bets', async (req, res) => {
    const address = req.params.address;
    try {
      const matchIds = await chainService.getBettorMatchIds(address);
      if (matchIds.length === 0) {
        res.json({ bets: [], total: 0 });
        return;
      }

      const OUTCOME_LABELS: Record<number, string> = {
        0: 'NONE', 1: 'BOTH_SPLIT', 2: 'AGENT_A_STEALS', 3: 'AGENT_B_STEALS', 4: 'BOTH_STEAL',
      };
      const POOL_STATE_LABELS: Record<number, string> = {
        0: 'NONE', 1: 'OPEN', 2: 'CLOSED', 3: 'SETTLED',
      };

      const bets = await Promise.all(
        matchIds.map(async (matchId) => {
          try {
            const [bet, pool] = await Promise.all([
              chainService.getBet(matchId, address),
              chainService.getPool(matchId),
            ]);

            const poolState = Number(pool.state);
            const poolResult = Number(pool.result);
            const betOutcome = bet.outcome;
            const isWinner = poolState === 3 && betOutcome === poolResult;
            const claimable = isWinner && !bet.claimed;

            return {
              matchId,
              amount: bet.amount,
              outcome: betOutcome,
              outcomeLabel: OUTCOME_LABELS[betOutcome] || 'UNKNOWN',
              claimed: bet.claimed,
              poolState: poolState,
              poolStateLabel: POOL_STATE_LABELS[poolState] || 'UNKNOWN',
              poolResult,
              poolResultLabel: OUTCOME_LABELS[poolResult] || 'NONE',
              isWinner,
              claimable,
            };
          } catch {
            return null;
          }
        })
      );

      const validBets = bets.filter(b => b !== null);
      res.json({ bets: validBets, total: validBets.length });
    } catch (err) {
      console.error('Failed to fetch bettor bets:', err);
      res.status(500).json({ error: 'Failed to fetch bettor bets' });
    }
  });

  // ─── Tournament queue ───────────────────────────────

  app.get('/tournament-queue', (_req, res) => {
    res.json({
      size: tournamentQueueManager.getQueueSize(),
      agents: tournamentQueueManager.getQueuedAddresses(),
    });
  });

  // ═══════════════════════════════════════════════════════
  // ─── HTTP Agent API ────────────────────────────────────
  // ═══════════════════════════════════════════════════════

  // Auth middleware for HTTP agent endpoints
  function requireHttpAuth(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      res.status(401).json({ error: 'Missing Authorization header' });
      return;
    }
    const session = httpSessionManager.getSession(token);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    httpSessionManager.touchSession(token);
    (req as any).agentSession = session;
    next();
  }

  // ─── Auth: Get challenge ───────────────────────────────

  app.post('/agent/auth/challenge', (_req, res) => {
    const challenge = authManager.generateChallenge();
    res.json(challenge);
  });

  // ─── Auth: Verify signature ────────────────────────────

  app.post('/agent/auth/verify', async (req, res) => {
    const { address, signature, challengeId } = req.body;

    if (!address || !signature || !challengeId) {
      res.status(400).json({ error: 'Missing address, signature, or challengeId' });
      return;
    }

    const result = authManager.verifyChallenge(challengeId, address, signature);
    if (!result.valid) {
      res.status(401).json({ error: result.reason });
      return;
    }

    // Check on-chain registration
    try {
      const registered = await chainService.isRegistered(address);
      if (!registered) {
        res.status(403).json({ error: 'Agent not registered on AgentRegistry' });
        return;
      }
    } catch {
      res.status(500).json({ error: 'Failed to check registration' });
      return;
    }

    // Get agent name
    let name: string;
    try {
      name = await chainService.getAgentName(address) || `${address.slice(0, 6)}...${address.slice(-4)}`;
    } catch {
      name = `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    // Create bridge and register with broadcaster
    const bridge = new HttpAgentBridge();
    broadcaster.addClient(bridge as any, 'agent');
    broadcaster.authenticateAgent(bridge as any, address, name);

    // Create session (pass broadcaster to clean up old bridges from same address)
    const token = httpSessionManager.createSession(address, name, bridge, broadcaster, queueManager);

    console.log(`[HTTP] Agent authenticated: ${name} (${address})`);

    res.json({ token, address, name });
  });

  // ─── Events: Long-poll ─────────────────────────────────

  app.get('/agent/events', requireHttpAuth, async (req, res) => {
    const session = (req as any).agentSession;
    const timeout = Math.min(parseInt(req.query.timeout as string) || 30000, 60000);

    const events = await session.bridge.pollEvents(timeout);
    res.json(events);
  });

  // ─── Status ────────────────────────────────────────────

  app.get('/agent/status', requireHttpAuth, (req, res) => {
    const session = (req as any).agentSession;
    const address = session.address;

    res.json({
      address,
      name: session.name,
      inQueue: queueManager.isInQueue(address),
      activeMatch: matchEngine.getActiveMatch(address),
    });
  });

  // ─── Queue: Join ───────────────────────────────────────

  app.post('/agent/queue/join', requireHttpAuth, (req, res) => {
    const session = (req as any).agentSession;
    queueManager.addToQueue({ address: session.address, ws: session.bridge as any });
    res.json({ success: true });
  });

  // ─── Queue: Leave ──────────────────────────────────────

  app.post('/agent/queue/leave', requireHttpAuth, (req, res) => {
    const session = (req as any).agentSession;
    queueManager.removeFromQueue(session.address);
    res.json({ success: true });
  });

  // ─── Match: Send negotiation message ───────────────────

  app.post('/match/:matchId/message', requireHttpAuth, (req, res) => {
    const session = (req as any).agentSession;
    const matchId = parseInt(req.params.matchId as string);
    const { message } = req.body;

    if (isNaN(matchId)) {
      res.status(400).json({ error: 'Invalid match ID' });
      return;
    }

    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'Missing or invalid message' });
      return;
    }

    const sent = matchEngine.onNegotiationMessage(matchId, session.address, message);
    if (!sent) {
      res.status(404).json({ error: 'Match not found or not in negotiation phase' });
      return;
    }

    res.json({ success: true });
  });

  // ─── Match: Submit choice ──────────────────────────────

  app.post('/match/:matchId/choice', requireHttpAuth, (req, res) => {
    const session = (req as any).agentSession;
    const matchId = parseInt(req.params.matchId as string);
    const { choice, signature } = req.body;

    if (isNaN(matchId)) {
      res.status(400).json({ error: 'Invalid match ID' });
      return;
    }

    if (!choice || !signature) {
      res.status(400).json({ error: 'Missing choice or signature' });
      return;
    }

    const result = matchEngine.onChoiceSubmitted(matchId, session.address, choice, signature);
    res.json(result);
  });

  return app;
}
