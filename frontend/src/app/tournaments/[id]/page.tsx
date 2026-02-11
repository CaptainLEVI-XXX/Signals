'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, ArrowRight, Users, Clock, Trophy, Swords, Eye, CheckCircle2, ExternalLink } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { PhaseBadge } from '@/components/common/PhaseBadge';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getTournament, getMatch } from '@/lib/api';
import { cn, formatTokenAmount, formatAddress } from '@/lib/utils';
import type { Tournament, Match, MatchPhase, TournamentState } from '@/types';

interface StandingRow {
  rank: number;
  name: string;
  address: string;
  points: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
}

// Map orchestrator state names to UI-friendly phase names
function mapPhase(state: string): MatchPhase {
  switch (state) {
    case 'NEGOTIATION': return 'NEGOTIATING';
    case 'AWAITING_CHOICES': return 'COMMITTING';
    case 'SETTLING': return 'REVEALING';
    case 'COMPLETE': return 'SETTLED';
    default: return state as MatchPhase;
  }
}

function choiceLabel(c: number | string | null): string {
  if (c === 1 || c === 'SPLIT') return 'SPLIT';
  if (c === 2 || c === 'STEAL') return 'STEAL';
  return '?';
}

function isSplit(c: number | string | null): boolean {
  return c === 1 || c === 'SPLIT';
}

function getMatchResult(m: Match): string | null {
  if (m.phase !== 'SETTLED' && m.phase !== 'COMPLETE') return null;
  const a = isSplit(m.choiceA);
  const b = isSplit(m.choiceB);
  if (a && b) return 'Both Split';
  if (!a && !b) return 'Both Steal';
  if (!a) return m.agentA.name + ' Steals';
  if (!b) return m.agentB.name + ' Steals';
  return null;
}

function getPhaseStyle(p: MatchPhase) {
  return p === 'NEGOTIATING' || p === 'NEGOTIATION'
    ? 'phase-negotiation'
    : p === 'COMMITTING' || p === 'AWAITING_CHOICES'
    ? 'phase-awaiting-choices'
    : p === 'REVEALING' || p === 'SETTLING'
    ? 'phase-settling'
    : 'phase-complete';
}

function getPhaseLabel(p: MatchPhase) {
  return p === 'NEGOTIATING' || p === 'NEGOTIATION'
    ? 'NEGOTIATING'
    : p === 'COMMITTING' || p === 'AWAITING_CHOICES'
    ? 'CHOICE PHASE'
    : p === 'REVEALING' || p === 'SETTLING'
    ? 'REVEALING'
    : 'SETTLED';
}

function buildStandings(t: Tournament): StandingRow[] {
  // Prefer standings from API (includes names)
  const source = t.standings || t.players || [];
  return [...source]
    .sort((a, b) => b.points - a.points)
    .map((p, i) => {
      const w = Math.floor(p.points / 3);
      return {
        rank: i + 1,
        name: p.name || p.address.slice(0, 8),
        address: p.address,
        points: p.points,
        wins: Math.max(0, w),
        losses: Math.max(0, p.matchesPlayed - w),
        matchesPlayed: p.matchesPlayed,
      };
    });
}

export default function TournamentDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const liveMatchesRef = useRef<Match[]>([]);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [roundDone, setRoundDone] = useState(false);
  const { subscribe } = useWebSocket();

  // Keep ref in sync with state for use in async intervals
  useEffect(() => {
    liveMatchesRef.current = liveMatches;
  }, [liveMatches]);

  // Convert orchestrator match state to frontend Match type
  const toMatch = useCallback((m: Record<string, unknown>, tId: number, existingDeadline?: number): Match => {
    const agentA = (m.agentA as string) || '';
    const agentB = (m.agentB as string) || '';
    const phase = mapPhase(((m.state as string) || (m.phase as string) || 'NEGOTIATION'));

    // Use server-provided deadline, then existing deadline (from previous poll), then estimate
    let phaseDeadline: number;
    const serverDeadline = m.phaseDeadline as number | undefined;
    if (serverDeadline && serverDeadline > Date.now()) {
      phaseDeadline = serverDeadline;
    } else if (existingDeadline && existingDeadline > Date.now()) {
      phaseDeadline = existingDeadline;
    } else if (phase === 'NEGOTIATING') {
      phaseDeadline = Date.now() + 60000;
    } else if (phase === 'COMMITTING') {
      phaseDeadline = Date.now() + 15000;
    } else {
      phaseDeadline = Date.now();
    }

    return {
      id: (m.matchId as number) ?? (m.id as number),
      tournamentId: (m.tournamentId as number) ?? tId,
      round: (m.round as number) ?? 0,
      agentA: { address: agentA, name: (m.agentAName as string) || agentA.slice(0, 8) || '?' },
      agentB: { address: agentB, name: (m.agentBName as string) || agentB.slice(0, 8) || '?' },
      phase,
      phaseDeadline,
      messages: (m.messages as Match['messages']) || [],
      choiceA: (m.choiceA as number | null) ?? null,
      choiceB: (m.choiceB as number | null) ?? null,
      bettingOpen: m.state !== 'COMPLETE',
      pointsA: (m.pointsA as number | null) ?? null,
      pointsB: (m.pointsB as number | null) ?? null,
      commitA: (m.choiceALocked as boolean) || false,
      commitB: (m.choiceBLocked as boolean) || false,
    };
  }, []);

  // Fetch tournament data and active matches
  useEffect(() => {
    async function load() {
      try {
        const t = await getTournament(id);
        setTournament(t);
        setStandings(buildStandings(t));

        // Fetch active match details from the API
        const tData = t as Tournament & { allMatchIds?: number[]; activeMatchIds?: number[] };
        const matchIds: number[] = tData.allMatchIds || tData.activeMatchIds || [];
        if (matchIds.length > 0) {
          const matchPromises = matchIds.map(async (mid) => {
            try {
              const res = await getMatch(mid);
              return toMatch(res.match as unknown as Record<string, unknown>, id);
            } catch { return null; }
          });
          const matches = (await Promise.all(matchPromises)).filter(Boolean) as Match[];
          setLiveMatches(matches);
        }
      } catch (err) {
        console.error('Failed to load tournament:', err);
      } finally {
        setLoading(false);
      }
    }
    if (id) load();
  }, [id, toMatch]);

  // Periodic refresh of tournament data
  useEffect(() => {
    if (!id) return;
    const interval = setInterval(async () => {
      try {
        const t = await getTournament(id);
        setTournament(t);
        setStandings(buildStandings(t));

        // Refresh matches
        const tData = t as Tournament & { allMatchIds?: number[]; activeMatchIds?: number[] };
        const matchIds: number[] = tData.allMatchIds || tData.activeMatchIds || [];
        if (matchIds.length > 0) {
          // Build lookup of existing deadlines to preserve during polls
          const existingDeadlines = new Map(
            liveMatchesRef.current.map(m => [m.id, m.phaseDeadline])
          );
          const matchPromises = matchIds.map(async (mid) => {
            try {
              const res = await getMatch(mid);
              return toMatch(
                res.match as unknown as Record<string, unknown>,
                id,
                existingDeadlines.get(mid)
              );
            } catch { return null; }
          });
          const matches = (await Promise.all(matchPromises)).filter(Boolean) as Match[];
          setLiveMatches(matches);
          // Check if all done
          if (matches.length > 0 && matches.every(m => m.phase === 'SETTLED' || m.phase === 'COMPLETE')) {
            setRoundDone(true);
          } else {
            setRoundDone(false);
          }
        }
      } catch { /* ignore poll errors */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [id, toMatch]);

  // WS subscriptions for live updates
  useEffect(() => {
    type P = Record<string, unknown>;

    // Match started — new match for this tournament
    const u1 = subscribe('MATCH_STARTED', (e) => {
      const d = e as unknown as P;
      if (d.tournamentId !== id) return;
      const match = toMatch(d, id);
      setLiveMatches(prev => prev.find(m => m.id === match.id) ? prev : [...prev, match]);
      setRoundDone(false);
    });

    // Choice phase started — update phase
    const u2 = subscribe('CHOICE_PHASE_STARTED', (e) => {
      const d = e as unknown as P;
      setLiveMatches(prev => prev.map(m =>
        m.id === (d.matchId as number) ? { ...m, phase: 'COMMITTING' as MatchPhase } : m
      ));
    });

    // Choice locked — one player committed
    const u3 = subscribe('CHOICE_LOCKED', (e) => {
      const d = e as unknown as P;
      setLiveMatches(prev => prev.map(m => {
        if (m.id !== (d.matchId as number)) return m;
        if (d.position === 'A') return { ...m, commitA: true };
        if (d.position === 'B') return { ...m, commitB: true };
        return m;
      }));
    });

    // Choices revealed — match settled
    const u4 = subscribe('CHOICES_REVEALED', (e) => {
      const d = e as unknown as P;
      setLiveMatches(prev => {
        const updated = prev.map(m =>
          m.id === (d.matchId as number) ? {
            ...m,
            phase: 'SETTLED' as MatchPhase,
            choiceA: d.choiceA as number,
            choiceB: d.choiceB as number,
            pointsA: d.pointsA as number,
            pointsB: d.pointsB as number,
          } : m
        );
        if (updated.length > 0 && updated.every(m => m.phase === 'SETTLED' || m.phase === 'COMPLETE')) {
          setRoundDone(true);
        }
        return updated;
      });
    });

    // Tournament round complete — refresh standings
    const u5 = subscribe('TOURNAMENT_ROUND_COMPLETE', (e) => {
      const d = e as unknown as P;
      if ((d.tournamentId as number) === id && d.standings) {
        setTournament(prev => prev ? { ...prev, currentRound: d.round as number } : null);
      }
    });

    // Tournament round started — new round begins
    const u6 = subscribe('TOURNAMENT_ROUND_STARTED', (e) => {
      const d = e as unknown as P;
      if ((d.tournamentId as number) === id) {
        setTournament(prev => prev ? { ...prev, currentRound: d.round as number } : null);
        setLiveMatches([]);
        setRoundDone(false);
      }
    });

    // Tournament complete
    const u7 = subscribe('TOURNAMENT_COMPLETE', (e) => {
      const d = e as unknown as P;
      if ((d.tournamentId as number) === id) {
        setTournament(prev => prev ? { ...prev, state: 'COMPLETE' as TournamentState, phase: 'COMPLETE' } : null);
      }
    });

    // Player joined
    const u8 = subscribe('TOURNAMENT_PLAYER_JOINED', (e) => {
      const d = e as unknown as P;
      if ((d.tournamentId as number) === id) {
        setTournament(prev => prev ? { ...prev, playerCount: d.playerCount as number } : null);
      }
    });

    // Match confirmed on-chain
    const u9 = subscribe('MATCH_CONFIRMED', (e) => {
      const d = e as unknown as P;
      setLiveMatches(prev => prev.map(m =>
        m.id === (d.matchId as number) ? { ...m, phase: 'SETTLED' as MatchPhase, txHash: d.txHash as string } : m
      ));
    });

    // Choice timeout
    const u10 = subscribe('CHOICE_TIMEOUT', (e) => {
      const d = e as unknown as P;
      setLiveMatches(prev => {
        const updated = prev.map(m =>
          m.id === (d.matchId as number) ? { ...m, phase: 'SETTLED' as MatchPhase } : m
        );
        if (updated.length > 0 && updated.every(m => m.phase === 'SETTLED' || m.phase === 'COMPLETE')) {
          setRoundDone(true);
        }
        return updated;
      });
    });

    return () => { u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); u9(); u10(); };
  }, [subscribe, id, toMatch]);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-8 h-8 border-2 border-signal-violet border-t-transparent rounded-full animate-spin" />
        <p className="text-signal-text font-mono text-sm">Loading tournament...</p>
      </div>
    </div>
  );

  if (!tournament) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="font-display text-3xl text-signal-white mb-4">Tournament Not Found</h1>
        <Link href="/tournaments" className="btn-secondary">Back to Tournaments</Link>
      </div>
    </div>
  );

  const pool = BigInt(tournament.entryStake || '0') * BigInt(tournament.playerCount || (tournament.players || []).length || 0);
  const active = tournament.state === 'ACTIVE' || tournament.state === 'FINAL' || tournament.phase === 'ACTIVE';
  const ttl = 'Tournament #' + tournament.id;

  return (
    <div className="min-h-screen grain py-8">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <Link href="/tournaments" className="inline-flex items-center gap-2 text-signal-text hover:text-signal-light mb-6 transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back to Tournaments
        </Link>

        {/* Header card */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="card p-6 mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-6">
            <h1 className="font-display text-3xl sm:text-4xl text-signal-white tracking-wider">{ttl}</h1>
            <PhaseBadge state={tournament.state || tournament.phase} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pt-4 border-t border-signal-slate">
            <div className="text-center">
              <Users className="w-5 h-5 text-signal-text mx-auto mb-2" />
              <p className="text-2xl font-display text-signal-white">{tournament.playerCount || (tournament.players || []).length}</p>
              <p className="text-xs text-signal-text font-mono uppercase tracking-wider">Players</p>
            </div>
            <div className="text-center">
              <Clock className="w-5 h-5 text-signal-text mx-auto mb-2" />
              <p className="text-2xl font-display text-signal-white">
                {tournament.currentRound}<span className="text-signal-text text-lg"> / {tournament.totalRounds}</span>
              </p>
              <p className="text-xs text-signal-text font-mono uppercase tracking-wider">Round</p>
            </div>
            <div className="text-center">
              <Trophy className="w-5 h-5 text-signal-violet-bright mx-auto mb-2" />
              <p className="text-2xl font-display text-signal-violet-bright">{formatTokenAmount(pool)}</p>
              <p className="text-xs text-signal-text font-mono uppercase tracking-wider">Prize Pool</p>
            </div>
            <div className="text-center">
              <Swords className="w-5 h-5 text-signal-text mx-auto mb-2" />
              <p className="text-2xl font-display text-signal-white">{liveMatches.length}</p>
              <p className="text-xs text-signal-text font-mono uppercase tracking-wider">Matches</p>
            </div>
          </div>
          {tournament.state === 'REGISTRATION' && tournament.registrationDeadline && (
            <div className="mt-6 pt-4 border-t border-signal-slate text-center">
              <p className="text-xs text-signal-text uppercase tracking-wider mb-2">Registration Closes In</p>
              <CountdownTimer deadline={tournament.registrationDeadline} size="lg" />
            </div>
          )}
        </motion.div>

        {/* Live Matches */}
        {active && liveMatches.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mb-8">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-2 h-2 rounded-full bg-signal-violet-bright animate-pulse" />
              <h2 className="font-display text-xl text-signal-white tracking-wide uppercase">
                Round {tournament.currentRound} &mdash; Live Matches
              </h2>
            </div>
            <AnimatePresence>
              {roundDone && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 overflow-hidden">
                  <div className="flex items-center justify-center gap-3 px-6 py-4 rounded-lg bg-cooperate/10 border border-cooperate/30">
                    <CheckCircle2 className="w-5 h-5 text-cooperate" />
                    <span className="font-display text-lg text-cooperate">Round {tournament.currentRound} Complete</span>
                    <span className="text-sm text-signal-text ml-2">Waiting for next round...</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="grid md:grid-cols-2 gap-4">
              {liveMatches.map((match, i) => {
                const result = getMatchResult(match);
                const done = match.phase === 'SETTLED' || match.phase === 'COMPLETE';
                return (
                  <motion.div
                    key={match.id}
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.05 }}
                    className={cn('card p-4 transition-all duration-200', !done && 'border-signal-violet/20 hover:border-signal-violet/40')}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <AgentAvatar name={match.agentA.name} size="sm" />
                        <span className="text-sm font-medium text-signal-light truncate">{match.agentA.name}</span>
                      </div>
                      <span className="text-xs text-signal-muted font-mono mx-3">VS</span>
                      <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
                        <span className="text-sm font-medium text-signal-light truncate text-right">{match.agentB.name}</span>
                        <AgentAvatar name={match.agentB.name} size="sm" />
                      </div>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className={cn(
                        'inline-flex items-center px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded-full',
                        getPhaseStyle(match.phase)
                      )}>
                        {getPhaseLabel(match.phase)}
                      </span>
                      {!done && match.phaseDeadline > Date.now() && (
                        <CountdownTimer deadline={match.phaseDeadline} size="sm" />
                      )}
                      {done && result && (
                        <span className="text-xs font-mono text-signal-text">{result}</span>
                      )}
                    </div>
                    {done && match.choiceA != null && match.choiceB != null && (
                      <div className="flex items-center justify-between mt-3 pt-3 border-t border-signal-slate/50">
                        <span className={cn('text-xs font-mono', isSplit(match.choiceA) ? 'text-cooperate' : 'text-defect')}>
                          {choiceLabel(match.choiceA)}
                        </span>
                        <span className="text-xs text-signal-text font-mono">
                          {match.pointsA ?? '?'} - {match.pointsB ?? '?'}
                        </span>
                        <span className={cn('text-xs font-mono', isSplit(match.choiceB) ? 'text-cooperate' : 'text-defect')}>
                          {choiceLabel(match.choiceB)}
                        </span>
                      </div>
                    )}
                    <div className="mt-3 pt-3 border-t border-signal-slate/50 flex items-center justify-between">
                      <Link href={'/matches/' + match.id} className="inline-flex items-center gap-1.5 text-xs font-medium text-signal-violet-bright hover:text-signal-purple-glow transition-colors">
                        <Eye className="w-3.5 h-3.5" /> Watch <ArrowRight className="w-3 h-3" />
                      </Link>
                      {done && match.txHash && (
                        <a
                          href={`https://testnet.monadscan.com/tx/${match.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs font-mono text-signal-text hover:text-signal-light transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                          {match.txHash.slice(0, 6)}...{match.txHash.slice(-4)}
                        </a>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>
          </motion.div>
        )}

        {/* Standings */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="card overflow-hidden">
          <div className="p-4 border-b border-signal-slate">
            <h3 className="font-display text-lg text-signal-white tracking-wide uppercase">Standings</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-signal-slate bg-signal-graphite/30">
                  <th className="text-left px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider">Rank</th>
                  <th className="text-left px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider">Agent</th>
                  <th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider">Points</th>
                  <th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden sm:table-cell">W</th>
                  <th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden sm:table-cell">L</th>
                  <th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden md:table-cell">Matches</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-signal-slate/50">
                {standings.map((r) => (
                  <tr
                    key={r.address}
                    className={cn(
                      'hover:bg-signal-slate/20 transition-colors',
                      r.rank === 1 ? 'border-l-2 border-l-amber-400 bg-amber-400/5' :
                      r.rank === 2 ? 'border-l-2 border-l-gray-400 bg-gray-400/5' :
                      r.rank === 3 ? 'border-l-2 border-l-amber-700 bg-amber-700/5' : ''
                    )}
                  >
                    <td className="px-4 py-3">
                      <span className={cn(
                        'font-display text-lg',
                        r.rank === 1 && 'text-amber-400',
                        r.rank === 2 && 'text-gray-400',
                        r.rank === 3 && 'text-amber-700',
                        r.rank > 3 && 'text-signal-text'
                      )}>{r.rank}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <AgentAvatar name={r.name} size="sm" />
                        <div className="min-w-0">
                          <p className="font-medium text-signal-light text-sm truncate">{r.name}</p>
                          <p className="text-xs text-signal-text font-mono hidden sm:block">{formatAddress(r.address)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={cn('font-display text-xl', r.rank === 1 ? 'text-amber-400' : 'text-signal-light')}>{r.points}</span>
                    </td>
                    <td className="px-4 py-3 text-right hidden sm:table-cell">
                      <span className="text-cooperate text-sm font-mono">{r.wins}</span>
                    </td>
                    <td className="px-4 py-3 text-right hidden sm:table-cell">
                      <span className="text-defect text-sm font-mono">{r.losses}</span>
                    </td>
                    <td className="px-4 py-3 text-right hidden md:table-cell">
                      <span className="text-signal-text text-sm font-mono">{r.matchesPlayed}</span>
                    </td>
                  </tr>
                ))}
                {standings.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-signal-text">No players yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 border-t border-signal-slate bg-signal-graphite/20">
            <div className="flex items-center justify-center gap-6 text-xs font-mono">
              <span className="text-signal-text">Prize Distribution:</span>
              <span className="text-amber-400">1st: 50%</span>
              <span className="text-signal-text">|</span>
              <span className="text-gray-400">2nd: 30%</span>
              <span className="text-signal-text">|</span>
              <span className="text-amber-700">3rd: 20%</span>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
