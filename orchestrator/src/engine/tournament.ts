import { Broadcaster } from '../broadcast/events.js';
import { ChainService, TournamentMatchPair } from '../chain/service.js';
import { MatchEngine } from './match.js';

// ─── Types ───────────────────────────────────────────

interface TournamentPlayer {
  address: string;
  name?: string;
  points: number;
  matchesPlayed: number;
  hasBye: boolean;
}

interface TournamentRound {
  roundNumber: number;
  pairs: TournamentMatchPair[];
  matchIds: number[];
  completedMatchIds: Set<number>;
  byePlayer: string | null;
}

type TournamentPhase = 'REGISTRATION' | 'ACTIVE' | 'FINAL' | 'COMPLETE';

interface ManagedTournament {
  id: number;
  phase: TournamentPhase;
  players: Map<string, TournamentPlayer>;  // lowercase address -> player
  rounds: TournamentRound[];
  currentRound: number;
  totalRounds: number;
  choiceWindowSec: number;
  matchHistory: Map<string, Set<string>>; // address -> set of opponents played
  entryStake: string; // bigint as string
}

// ─── Points table ─────────────────────────────────────

const POINTS = {
  BOTH_SPLIT_A: 3,
  BOTH_SPLIT_B: 3,
  STEAL_WIN: 5,
  STEAL_LOSE: 1,
  BOTH_STEAL_A: 0,
  BOTH_STEAL_B: 0,
  TIMEOUT_SUBMITTER: 1,
  TIMEOUT_DEFAULTER: 0,
  BYE: 1,
} as const;

// ─── TournamentManager ───────────────────────────────

export class TournamentManager {
  private tournaments: Map<number, ManagedTournament> = new Map();

  private broadcaster: Broadcaster;
  private chainService: ChainService;
  private matchEngine: MatchEngine;

  constructor(broadcaster: Broadcaster, chainService: ChainService, matchEngine: MatchEngine) {
    this.broadcaster = broadcaster;
    this.chainService = chainService;
    this.matchEngine = matchEngine;
  }

  // ─── Create tournament ──────────────────────────────

  async createTournament(
    entryStake: bigint,
    maxPlayers: number,
    totalRounds: number,
    registrationDuration: number,
    choiceWindowSec: number = 60
  ): Promise<number> {
    const id = await this.chainService.createTournament(
      entryStake,
      maxPlayers,
      totalRounds,
      registrationDuration
    );

    this.tournaments.set(id, {
      id,
      phase: 'REGISTRATION',
      players: new Map(),
      rounds: [],
      currentRound: 0,
      totalRounds,
      choiceWindowSec,
      matchHistory: new Map(),
      entryStake: entryStake.toString(),
    });

    this.broadcaster.broadcast('TOURNAMENT_CREATED', {
      tournamentId: id,
      entryStake: entryStake.toString(),
      maxPlayers,
      totalRounds,
      registrationDuration,
    });

    console.log(`[Tournament ${id}] Created. ${totalRounds} rounds, max ${maxPlayers} players.`);
    return id;
  }

  // ─── Player joined (called when we detect on-chain event or agent notifies) ──

  registerPlayer(tournamentId: number, address: string, name?: string) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return;

    const lower = address.toLowerCase();
    if (t.players.has(lower)) return;

    t.players.set(lower, {
      address,
      name: name || undefined,
      points: 0,
      matchesPlayed: 0,
      hasBye: false,
    });

    t.matchHistory.set(lower, new Set());

    // Resolve name asynchronously if not provided
    if (!name) {
      this.chainService.getAgentName(address).then(resolvedName => {
        const player = t.players.get(lower);
        if (player) {
          player.name = resolvedName || address.slice(0, 8);
        }
      }).catch(() => {});
    }

    this.broadcaster.broadcast('TOURNAMENT_PLAYER_JOINED', {
      tournamentId,
      player: address,
      playerCount: t.players.size,
    });
  }

  // ─── Start tournament ───────────────────────────────

  async startTournament(tournamentId: number) {
    const t = this.tournaments.get(tournamentId);
    if (!t || t.phase !== 'REGISTRATION') return;

    await this.chainService.startTournament(tournamentId);
    t.phase = 'ACTIVE';
    t.currentRound = 1;

    this.broadcaster.broadcast('TOURNAMENT_STARTED', {
      tournamentId,
      playerCount: t.players.size,
      totalRounds: t.totalRounds,
    });

    console.log(`[Tournament ${tournamentId}] Started with ${t.players.size} players.`);

    // Start first round
    await this.startRound(tournamentId);
  }

  // ─── Start a round ──────────────────────────────────

  private async startRound(tournamentId: number) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return;

    const roundNum = t.currentRound;

    // Generate pairings
    const { pairs, byePlayer } = this.generatePairings(t, roundNum);

    // Assign bye point
    if (byePlayer) {
      const player = t.players.get(byePlayer.toLowerCase());
      if (player) {
        player.points += POINTS.BYE;
        player.hasBye = true;
      }
    }

    if (pairs.length === 0) {
      console.log(`[Tournament ${tournamentId}] Round ${roundNum}: No pairs generated.`);
      return;
    }

    // Create matches on-chain
    const matchIds = await this.chainService.createTournamentMatchBatch(
      tournamentId,
      pairs,
      t.choiceWindowSec
    );

    const round: TournamentRound = {
      roundNumber: roundNum,
      pairs,
      matchIds,
      completedMatchIds: new Set(),
      byePlayer: byePlayer || null,
    };

    t.rounds.push(round);

    // Create match state machines in the engine
    this.matchEngine.createMatches(matchIds, pairs, tournamentId);

    // Track match history
    for (const pair of pairs) {
      const aLower = pair.agentA.toLowerCase();
      const bLower = pair.agentB.toLowerCase();
      t.matchHistory.get(aLower)?.add(bLower);
      t.matchHistory.get(bLower)?.add(aLower);
    }

    this.broadcaster.broadcast('TOURNAMENT_ROUND_STARTED', {
      tournamentId,
      round: roundNum,
      totalRounds: t.totalRounds,
      matches: matchIds.length,
      byePlayer,
      standings: this.getStandings(tournamentId),
    });

    console.log(`[Tournament ${tournamentId}] Round ${roundNum}: ${matchIds.length} matches created.`);
  }

  // ─── Match completed callback ───────────────────────

  onMatchComplete(matchId: number, _agentA: string, _agentB: string) {
    // Find which tournament this match belongs to
    for (const [tournamentId, t] of this.tournaments) {
      const currentRound = t.rounds[t.rounds.length - 1];
      if (!currentRound) continue;

      const idx = currentRound.matchIds.indexOf(matchId);
      if (idx === -1) continue;

      currentRound.completedMatchIds.add(matchId);

      // Update standings broadcast
      this.broadcaster.broadcast('TOURNAMENT_UPDATE', {
        tournamentId,
        round: currentRound.roundNumber,
        matchesCompleted: currentRound.completedMatchIds.size,
        matchesTotal: currentRound.matchIds.length,
        standings: this.getStandings(tournamentId),
      });

      // Check if all matches in round are complete
      if (currentRound.completedMatchIds.size >= currentRound.matchIds.length) {
        this.onRoundComplete(tournamentId);
      }

      return;
    }
  }

  // ─── Round complete ─────────────────────────────────

  private async onRoundComplete(tournamentId: number) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return;

    console.log(`[Tournament ${tournamentId}] Round ${t.currentRound} complete.`);

    this.broadcaster.broadcast('TOURNAMENT_ROUND_COMPLETE', {
      tournamentId,
      round: t.currentRound,
      standings: this.getStandings(tournamentId),
    });

    if (t.currentRound >= t.totalRounds) {
      // All rounds done -> complete tournament
      await this.completeTournament(tournamentId);
    } else {
      // Next round
      t.currentRound++;
      await this.startRound(tournamentId);
    }
  }

  // ─── Complete tournament ────────────────────────────

  private async completeTournament(tournamentId: number) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return;

    // Advance to final, then complete on-chain
    await this.chainService.advanceToFinal(tournamentId);
    await this.chainService.completeTournament(tournamentId);

    // Set rankings on-chain based on points
    const standings = this.getStandings(tournamentId);
    const rankedPlayers = standings.map(s => s.address);
    await this.chainService.setFinalRankings(tournamentId, rankedPlayers);

    t.phase = 'COMPLETE';

    this.broadcaster.broadcast('TOURNAMENT_COMPLETE', {
      tournamentId,
      standings,
    });

    console.log(`[Tournament ${tournamentId}] Complete. Winner: ${rankedPlayers[0]}`);
  }

  // ─── Swiss pairing algorithm ────────────────────────

  private generatePairings(
    t: ManagedTournament,
    roundNum: number
  ): { pairs: TournamentMatchPair[]; byePlayer: string | null } {
    const playerList = Array.from(t.players.values());
    const pairs: TournamentMatchPair[] = [];
    let byePlayer: string | null = null;

    if (roundNum === 1) {
      // Round 1: Random pairing
      const shuffled = this.shuffle([...playerList]);

      // Odd number: lowest-ranked (last after shuffle) gets bye
      if (shuffled.length % 2 !== 0) {
        const bye = shuffled.pop()!;
        byePlayer = bye.address;
      }

      for (let i = 0; i < shuffled.length; i += 2) {
        pairs.push({
          agentA: shuffled[i].address,
          agentB: shuffled[i + 1].address,
        });
      }
    } else {
      // Round 2+: Sort by points descending, pair adjacent
      const sorted = [...playerList].sort((a, b) => b.points - a.points);

      // Odd number: lowest-ranked player who hasn't had a bye gets one
      if (sorted.length % 2 !== 0) {
        for (let i = sorted.length - 1; i >= 0; i--) {
          if (!sorted[i].hasBye) {
            byePlayer = sorted[i].address;
            sorted.splice(i, 1);
            break;
          }
        }
        // If everyone had a bye, give it to the last player
        if (!byePlayer && sorted.length % 2 !== 0) {
          byePlayer = sorted.pop()!.address;
        }
      }

      // Greedy pairing: pair adjacent, avoiding rematches when possible
      const paired = new Set<number>();

      for (let i = 0; i < sorted.length; i++) {
        if (paired.has(i)) continue;

        for (let j = i + 1; j < sorted.length; j++) {
          if (paired.has(j)) continue;

          const aLower = sorted[i].address.toLowerCase();
          const bLower = sorted[j].address.toLowerCase();
          const played = t.matchHistory.get(aLower)?.has(bLower) ?? false;

          // Prefer non-rematch, but accept rematch if no other option
          if (!played || j === sorted.length - 1) {
            pairs.push({
              agentA: sorted[i].address,
              agentB: sorted[j].address,
            });
            paired.add(i);
            paired.add(j);
            break;
          }
        }
      }
    }

    return { pairs, byePlayer };
  }

  // ─── Update points from match result ────────────────

  updatePoints(
    tournamentId: number,
    agentA: string,
    agentB: string,
    choiceA: number,
    choiceB: number,
    timedOut: boolean = false,
    agentATimedOut: boolean = false
  ) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return;

    const playerA = t.players.get(agentA.toLowerCase());
    const playerB = t.players.get(agentB.toLowerCase());
    if (!playerA || !playerB) return;

    if (timedOut) {
      if (agentATimedOut) {
        playerA.points += POINTS.TIMEOUT_DEFAULTER;
        playerB.points += POINTS.TIMEOUT_SUBMITTER;
      } else {
        playerA.points += POINTS.TIMEOUT_SUBMITTER;
        playerB.points += POINTS.TIMEOUT_DEFAULTER;
      }
    } else {
      const SPLIT = 1;  // Matches contract: 1 = SPLIT, 2 = STEAL
      const STEAL = 2;

      if (choiceA === SPLIT && choiceB === SPLIT) {
        playerA.points += POINTS.BOTH_SPLIT_A;
        playerB.points += POINTS.BOTH_SPLIT_B;
      } else if (choiceA === STEAL && choiceB === SPLIT) {
        playerA.points += POINTS.STEAL_WIN;
        playerB.points += POINTS.STEAL_LOSE;
      } else if (choiceA === SPLIT && choiceB === STEAL) {
        playerA.points += POINTS.STEAL_LOSE;
        playerB.points += POINTS.STEAL_WIN;
      } else if (choiceA === STEAL && choiceB === STEAL) {
        playerA.points += POINTS.BOTH_STEAL_A;
        playerB.points += POINTS.BOTH_STEAL_B;
      }
    }

    playerA.matchesPlayed++;
    playerB.matchesPlayed++;
  }

  // ─── Query helpers ──────────────────────────────────

  getStandings(tournamentId: number): Array<{
    address: string;
    name: string;
    points: number;
    matchesPlayed: number;
  }> {
    const t = this.tournaments.get(tournamentId);
    if (!t) return [];

    return Array.from(t.players.values())
      .map(p => ({
        address: p.address,
        name: p.name || p.address.slice(0, 8),
        points: p.points,
        matchesPlayed: p.matchesPlayed,
      }))
      .sort((a, b) => b.points - a.points);
  }

  getTournament(tournamentId: number) {
    const t = this.tournaments.get(tournamentId);
    if (!t) return null;

    // Get active match IDs from current round
    const currentRound = t.rounds[t.rounds.length - 1];
    const activeMatchIds = currentRound
      ? currentRound.matchIds.filter(id => !currentRound.completedMatchIds.has(id))
      : [];
    const allMatchIds = currentRound ? currentRound.matchIds : [];

    // Build players array with names
    const players = Array.from(t.players.values()).map(p => ({
      address: p.address,
      name: p.name || p.address.slice(0, 8),
      points: p.points,
      matchesPlayed: p.matchesPlayed,
    }));

    return {
      id: t.id,
      phase: t.phase,
      state: t.phase, // alias for frontend compatibility
      currentRound: t.currentRound,
      totalRounds: t.totalRounds,
      playerCount: t.players.size,
      entryStake: t.entryStake,
      players,
      standings: this.getStandings(tournamentId),
      activeMatchIds,
      allMatchIds,
    };
  }

  getActiveTournaments(): number[] {
    const active: number[] = [];
    for (const [id, t] of this.tournaments) {
      if (t.phase === 'ACTIVE' || t.phase === 'REGISTRATION') {
        active.push(id);
      }
    }
    return active;
  }

  // ─── Utility ────────────────────────────────────────

  private shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
