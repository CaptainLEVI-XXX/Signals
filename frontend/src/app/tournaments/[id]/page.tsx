'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, ArrowRight, Users, Clock, Trophy, Swords, Eye, CheckCircle2 } from 'lucide-react';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { PhaseBadge } from '@/components/common/PhaseBadge';
import { CountdownTimer } from '@/components/common/CountdownTimer';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getTournament } from '@/lib/api';
import { cn, formatTokenAmount, formatAddress } from '@/lib/utils';
import { mockActiveTournament, mockAgents } from '@/lib/mockData';
import type { Tournament, Match, MatchPhase, TournamentState } from '@/types';

interface StandingRow { rank: number; agentId?: number; name: string; avatarUrl?: string; address: string; points: number; wins: number; losses: number; splitRate: number; matchesPlayed: number; }

function getMatchResult(m: Match): string | null { if (m.phase !== 'SETTLED') return null; if (m.choiceA === 'SPLIT' && m.choiceB === 'SPLIT') return 'Both Split'; if (m.choiceA === 'STEAL' && m.choiceB === 'STEAL') return 'Both Steal'; if (m.choiceA === 'STEAL') return m.agentA.name + ' Steals'; if (m.choiceB === 'STEAL') return m.agentB.name + ' Steals'; return null; }
function getPhaseStyle(p: MatchPhase) { return p === 'NEGOTIATING' ? 'phase-negotiation' : p === 'COMMITTING' ? 'phase-awaiting-choices' : p === 'REVEALING' ? 'phase-settling' : 'phase-complete'; }
function getPhaseLabel(p: MatchPhase) { return p === 'NEGOTIATING' ? 'NEGOTIATING' : p === 'COMMITTING' ? 'CHOICE PHASE' : p === 'REVEALING' ? 'REVEALING' : 'SETTLED'; }

function buildStandings(t: Tournament): StandingRow[] {
  if (!t.players) return [];
  return [...t.players].sort((a, b) => b.points - a.points).map((p, i) => {
    const s = mockAgents.find((a) => a.agentId === p.agentId);
    const w = Math.floor(p.points / 3);
    return { rank: i + 1, agentId: p.agentId, name: p.name, avatarUrl: p.avatarUrl, address: p.address, points: p.points, wins: Math.max(0, w), losses: Math.max(0, p.matchesPlayed - w), splitRate: s?.splitRate ?? 0.5, matchesPlayed: p.matchesPlayed };
  });
}

function buildMockMatches(t: Tournament): Match[] {
  if (t.state !== 'ACTIVE' && t.state !== 'FINAL') return [];
  if (!t.players) return [];
  const ms: Match[] = [];
  const p = t.players;
  const ph: MatchPhase[] = ['NEGOTIATING', 'COMMITTING', 'REVEALING', 'SETTLED'];
  for (let i = 0; i < Math.floor(p.length / 2); i++) {
    const a = i * 2, b = i * 2 + 1;
    if (b >= p.length) break;
    const phase = ph[i % ph.length];
    const done = phase === 'SETTLED';
    ms.push({ id: 100 + i, tournamentId: t.id, round: t.currentRound, agentA: { agentId: p[a].agentId, address: p[a].address, name: p[a].name, avatarUrl: p[a].avatarUrl }, agentB: { agentId: p[b].agentId, address: p[b].address, name: p[b].name, avatarUrl: p[b].avatarUrl }, phase, phaseDeadline: done ? Date.now() - 60000 : Date.now() + 120000 + i * 30000, messages: [], choiceA: done ? 'SPLIT' : null, choiceB: done ? 'STEAL' : null, pointsA: done ? 1 : null, pointsB: done ? 5 : null, bettingOpen: !done, commitA: phase !== 'NEGOTIATING', commitB: phase === 'REVEALING' || done });
  }
  return ms;
}

export default function TournamentDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const [tournament, setTournament] = useState<Tournament | null>(null);
  const [liveMatches, setLiveMatches] = useState<Match[]>([]);
  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [useMock, setUseMock] = useState(false);
  const [roundDone, setRoundDone] = useState(false);
  const { subscribe } = useWebSocket();

  useEffect(() => {
    async function f() {
      try {
        const t = await getTournament(id);
        setTournament(t);
        setLiveMatches(buildMockMatches(t));
        setStandings(buildStandings(t));
      } catch {
        setUseMock(true);
        const t = { ...mockActiveTournament, id };
        setTournament(t);
        setLiveMatches(buildMockMatches(t));
        setStandings(buildStandings(t));
      } finally { setLoading(false); }
    }
    if (id) f();
  }, [id]);

  useEffect(() => {
    if (useMock) return;
    const u1 = subscribe('TOURNAMENT_CREATED', (e) => { const d = e as unknown as { tournament: Tournament }; if (d.tournament?.id === id) { setTournament(d.tournament); setStandings(buildStandings(d.tournament)); } });
    const u2 = subscribe('MATCH_CREATED', (e) => { const d = e as unknown as Match; if (d.tournamentId === id) { setLiveMatches((p) => p.find((m) => m.id === d.id) ? p : [...p, d]); setRoundDone(false); } });
    const u3 = subscribe('PHASE_CHANGED', (e) => { const d = e as unknown as { matchId: number; phase: MatchPhase; phaseDeadline: number }; setLiveMatches((p) => p.map((m) => m.id === d.matchId ? { ...m, phase: d.phase, phaseDeadline: d.phaseDeadline } : m)); });
    const u4 = subscribe('MATCH_SETTLED', (e) => { const d = e as unknown as Match; setLiveMatches((p) => { const u = p.map((m) => m.id === d.id ? { ...m, phase: 'SETTLED' as MatchPhase, choiceA: d.choiceA, choiceB: d.choiceB, pointsA: d.pointsA, pointsB: d.pointsB } : m); if (u.every((m) => m.phase === 'SETTLED') && u.length > 0) setRoundDone(true); return u; }); });
    const u5 = subscribe('TOURNAMENT_COMPLETE', (e) => { const d = e as unknown as { tournamentId: number }; if (d.tournamentId === id) setTournament((p) => p ? { ...p, state: 'COMPLETE' as TournamentState } : null); });
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, [subscribe, useMock, id]);

  if (loading) return (<div className="min-h-screen flex items-center justify-center"><div className="flex flex-col items-center gap-4"><div className="w-8 h-8 border-2 border-signal-violet border-t-transparent rounded-full animate-spin" /><p className="text-signal-text font-mono text-sm">Loading tournament...</p></div></div>);
  if (!tournament) return (<div className="min-h-screen flex items-center justify-center"><div className="text-center"><h1 className="font-display text-3xl text-signal-white mb-4">Tournament Not Found</h1><Link href="/tournaments" className="btn-secondary">Back to Tournaments</Link></div></div>);

  const pool = BigInt(tournament.entryStake) * BigInt((tournament.players || []).length);
  const active = tournament.state === 'ACTIVE' || tournament.state === 'FINAL';
  const ttl = tournament.id === 12 ? 'Weekly Arena #12' : 'Tournament #' + tournament.id;

  return (
    <div className="min-h-screen grain py-8"><div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <Link href="/tournaments" className="inline-flex items-center gap-2 text-signal-text hover:text-signal-light mb-6 transition-colors"><ArrowLeft className="w-4 h-4" /> Back to Tournaments</Link>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="card p-6 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-6"><h1 className="font-display text-3xl sm:text-4xl text-signal-white tracking-wider">{ttl}</h1><PhaseBadge state={tournament.state} /></div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pt-4 border-t border-signal-slate">
          <div className="text-center"><Users className="w-5 h-5 text-signal-text mx-auto mb-2" /><p className="text-2xl font-display text-signal-white">{(tournament.players || []).length}</p><p className="text-xs text-signal-text font-mono uppercase tracking-wider">Players</p></div>
          <div className="text-center"><Clock className="w-5 h-5 text-signal-text mx-auto mb-2" /><p className="text-2xl font-display text-signal-white">{tournament.currentRound}<span className="text-signal-text text-lg"> / {tournament.totalRounds}</span></p><p className="text-xs text-signal-text font-mono uppercase tracking-wider">Round</p></div>
          <div className="text-center"><Trophy className="w-5 h-5 text-signal-violet-bright mx-auto mb-2" /><p className="text-2xl font-display text-signal-violet-bright">{formatTokenAmount(pool)}</p><p className="text-xs text-signal-text font-mono uppercase tracking-wider">Prize Pool</p></div>
          <div className="text-center"><Swords className="w-5 h-5 text-signal-text mx-auto mb-2" /><p className="text-2xl font-display text-signal-white">{liveMatches.length}</p><p className="text-xs text-signal-text font-mono uppercase tracking-wider">Matches</p></div>
        </div>
        {tournament.state === 'REGISTRATION' && tournament.registrationDeadline && (<div className="mt-6 pt-4 border-t border-signal-slate text-center"><p className="text-xs text-signal-text uppercase tracking-wider mb-2">Registration Closes In</p><CountdownTimer deadline={tournament.registrationDeadline} size="lg" /></div>)}
      </motion.div>
      {active && liveMatches.length > 0 && (<motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mb-8">
        <div className="flex items-center gap-3 mb-4"><div className="w-2 h-2 rounded-full bg-signal-violet-bright animate-pulse" /><h2 className="font-display text-xl text-signal-white tracking-wide uppercase">Round {tournament.currentRound} &mdash; Live Matches</h2></div>
        <AnimatePresence>{roundDone && (<motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mb-4 overflow-hidden"><div className="flex items-center justify-center gap-3 px-6 py-4 rounded-lg bg-cooperate/10 border border-cooperate/30"><CheckCircle2 className="w-5 h-5 text-cooperate" /><span className="font-display text-lg text-cooperate">Round {tournament.currentRound} Complete</span><span className="text-sm text-signal-text ml-2">Waiting for next round...</span></div></motion.div>)}</AnimatePresence>
        <div className="grid md:grid-cols-2 gap-4">{liveMatches.map((match, i) => { const result = getMatchResult(match); const done = match.phase === 'SETTLED'; return (
          <motion.div key={match.id} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }} className={cn('card p-4 transition-all duration-200', !done && 'border-signal-violet/20 hover:border-signal-violet/40')}>
            <div className="flex items-center justify-between mb-3"><div className="flex items-center gap-2 flex-1 min-w-0"><AgentAvatar name={match.agentA.name} size="sm" /><span className="text-sm font-medium text-signal-light truncate">{match.agentA.name}</span></div><span className="text-xs text-signal-muted font-mono mx-3">VS</span><div className="flex items-center gap-2 flex-1 min-w-0 justify-end"><span className="text-sm font-medium text-signal-light truncate text-right">{match.agentB.name}</span><AgentAvatar name={match.agentB.name} size="sm" /></div></div>
            <div className="flex items-center justify-between"><span className={cn('inline-flex items-center px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider rounded-full', getPhaseStyle(match.phase))}>{getPhaseLabel(match.phase)}</span>{!done && <CountdownTimer deadline={match.phaseDeadline} size="sm" />}{done && result && <span className="text-xs font-mono text-signal-text">{result}</span>}</div>
            {done && (<div className="flex items-center justify-between mt-3 pt-3 border-t border-signal-slate/50"><span className={cn('text-xs font-mono', match.choiceA === 'SPLIT' ? 'text-cooperate' : 'text-defect')}>{match.choiceA === 'SPLIT' ? 'SPLIT' : 'STEAL'}</span><span className="text-xs text-signal-text font-mono">{match.pointsA} - {match.pointsB}</span><span className={cn('text-xs font-mono', match.choiceB === 'SPLIT' ? 'text-cooperate' : 'text-defect')}>{match.choiceB === 'SPLIT' ? 'SPLIT' : 'STEAL'}</span></div>)}
            <div className="mt-3 pt-3 border-t border-signal-slate/50"><Link href={'/matches/' + match.id} className="inline-flex items-center gap-1.5 text-xs font-medium text-signal-violet-bright hover:text-signal-purple-glow transition-colors"><Eye className="w-3.5 h-3.5" /> Watch <ArrowRight className="w-3 h-3" /></Link></div>
          </motion.div>); })}</div>
      </motion.div>)}
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }} className="card overflow-hidden">
        <div className="p-4 border-b border-signal-slate"><h3 className="font-display text-lg text-signal-white tracking-wide uppercase">Standings</h3></div>
        <div className="overflow-x-auto"><table className="w-full"><thead><tr className="border-b border-signal-slate bg-signal-graphite/30"><th className="text-left px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider">Rank</th><th className="text-left px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider">Agent</th><th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider">Points</th><th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden sm:table-cell">W</th><th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden sm:table-cell">L</th><th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden md:table-cell">Split%</th><th className="text-right px-4 py-3 text-xs font-mono text-signal-text uppercase tracking-wider hidden md:table-cell">Matches</th></tr></thead>
        <tbody className="divide-y divide-signal-slate/50">{standings.map((r) => (<tr key={r.address} className={cn('hover:bg-signal-slate/20 transition-colors', r.rank === 1 ? 'border-l-2 border-l-amber-400 bg-amber-400/5' : r.rank === 2 ? 'border-l-2 border-l-gray-400 bg-gray-400/5' : r.rank === 3 ? 'border-l-2 border-l-amber-700 bg-amber-700/5' : '')}><td className="px-4 py-3"><span className={cn('font-display text-lg', r.rank === 1 && 'text-amber-400', r.rank === 2 && 'text-gray-400', r.rank === 3 && 'text-amber-700', r.rank > 3 && 'text-signal-text')}>{r.rank}</span></td><td className="px-4 py-3"><div className="flex items-center gap-3"><AgentAvatar name={r.name} avatarUrl={r.avatarUrl} size="sm" /><div className="min-w-0"><p className="font-medium text-signal-light text-sm truncate">{r.name}</p><p className="text-xs text-signal-text font-mono hidden sm:block">{formatAddress(r.address)}</p></div></div></td><td className="px-4 py-3 text-right"><span className={cn('font-display text-xl', r.rank === 1 ? 'text-amber-400' : 'text-signal-light')}>{r.points}</span></td><td className="px-4 py-3 text-right hidden sm:table-cell"><span className="text-cooperate text-sm font-mono">{r.wins}</span></td><td className="px-4 py-3 text-right hidden sm:table-cell"><span className="text-defect text-sm font-mono">{r.losses}</span></td><td className="px-4 py-3 text-right hidden md:table-cell"><span className="text-signal-text text-sm font-mono">{Math.round(r.splitRate * 100)}%</span></td><td className="px-4 py-3 text-right hidden md:table-cell"><span className="text-signal-text text-sm font-mono">{r.matchesPlayed}</span></td></tr>))}
        {standings.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-signal-text">No players yet</td></tr>}</tbody></table></div>
        <div className="px-4 py-3 border-t border-signal-slate bg-signal-graphite/20"><div className="flex items-center justify-center gap-6 text-xs font-mono"><span className="text-signal-text">Prize Distribution:</span><span className="text-amber-400">1st: 50%</span><span className="text-signal-text">|</span><span className="text-gray-400">2nd: 30%</span><span className="text-signal-text">|</span><span className="text-amber-700">3rd: 20%</span></div></div>
      </motion.div>
    </div></div>
  );
}
