import type { Match, MatchPhase, MatchMessage } from '@/types';
import type { OrchestratorMatchState } from '@/lib/api';

// Timing constants (mirror orchestrator config)
const NEGOTIATION_DURATION = 45_000;
const CHOICE_DURATION = 15_000;

// ─── Name helpers ───────────────────────────────────────

/** If the name looks like a raw address, truncate it */
function displayName(name: string, address: string): string {
  if (!name || name.startsWith('0x') && name.length > 20) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }
  return name;
}

// ─── Phase mapping ──────────────────────────────────────

export function mapPhase(state: string): MatchPhase {
  switch (state) {
    case 'NEGOTIATION':
      return 'NEGOTIATING';
    case 'AWAITING_CHOICES':
      return 'COMMITTING';
    case 'SETTLING':
      return 'REVEALING';
    case 'COMPLETE':
      return 'SETTLED';
    default:
      return state as MatchPhase;
  }
}

// ─── Choice mapping ─────────────────────────────────────

export function mapChoice(choice: number | null | undefined): string | null {
  if (choice === 1) return 'SPLIT';
  if (choice === 2) return 'STEAL';
  return null;
}

// ─── Message adaptation ─────────────────────────────────
// NegotiationFeed reads V1 fields: sender, senderName, content, id
// Orchestrator sends V2 fields: from, fromName, message, timestamp

let messageIdCounter = 0;

function adaptMessages(
  messages: Array<{ from: string; fromName: string; message: string; timestamp: number }>
): MatchMessage[] {
  return messages.map((msg) => ({
    // V2 wire fields
    from: msg.from,
    fromName: msg.fromName,
    message: msg.message,
    timestamp: msg.timestamp,
    // V1 aliases needed by NegotiationFeed component
    id: ++messageIdCounter,
    sender: msg.from,
    senderName: displayName(msg.fromName, msg.from),
    content: msg.message,
  }));
}

// ─── Adapt orchestrator REST response → frontend Match ──

export function adaptOrchestratorMatch(m: OrchestratorMatchState): Match {
  const phase = mapPhase(m.state);

  // Estimate deadline based on phase
  let phaseDeadline: number;
  if (phase === 'NEGOTIATING') {
    phaseDeadline = Date.now() + NEGOTIATION_DURATION;
  } else if (phase === 'COMMITTING') {
    phaseDeadline = Date.now() + CHOICE_DURATION;
  } else {
    phaseDeadline = Date.now();
  }

  return {
    id: m.matchId,
    tournamentId: m.tournamentId,
    round: 0,
    agentA: { address: m.agentA, name: displayName(m.agentAName, m.agentA) },
    agentB: { address: m.agentB, name: displayName(m.agentBName, m.agentB) },
    phase,
    phaseDeadline,
    messages: adaptMessages(m.messages),
    choiceA: null,
    choiceB: null,
    commitHashA: m.commitHashA,
    commitHashB: m.commitHashB,
    commitA: m.choiceALocked,
    commitB: m.choiceBLocked,
    bettingOpen: phase !== 'SETTLED',
  };
}

// ─── Adapt WS MATCH_STARTED event → frontend Match ─────

export function adaptMatchStartedEvent(payload: Record<string, unknown>): Match {
  const negotiationDuration = (payload.negotiationDuration as number) || NEGOTIATION_DURATION;
  const agentA = payload.agentA as string;
  const agentB = payload.agentB as string;

  return {
    id: payload.matchId as number,
    tournamentId: (payload.tournamentId as number) ?? 0,
    round: 0,
    agentA: {
      address: agentA,
      name: displayName((payload.agentAName as string) || '', agentA),
    },
    agentB: {
      address: agentB,
      name: displayName((payload.agentBName as string) || '', agentB),
    },
    phase: 'NEGOTIATING',
    phaseDeadline: Date.now() + negotiationDuration,
    messages: [],
    choiceA: null,
    choiceB: null,
    commitA: false,
    commitB: false,
    bettingOpen: true,
  };
}

// ─── Adapt WS NEGOTIATION_MESSAGE → MatchMessage ───────

export function adaptNegotiationMessage(payload: Record<string, unknown>): MatchMessage {
  const from = payload.from as string;
  const fromName = payload.fromName as string;
  return {
    from,
    fromName,
    message: payload.message as string,
    timestamp: payload.timestamp as number,
    // V1 aliases
    id: ++messageIdCounter,
    sender: from,
    senderName: displayName(fromName, from),
    content: payload.message as string,
  };
}

// ─── Adapt WS CHOICES_REVEALED → settled Match ─────────

export function adaptChoicesRevealedToSettledMatch(payload: Record<string, unknown>): Match {
  const agentA = payload.agentA as string;
  const agentB = payload.agentB as string;

  return {
    id: payload.matchId as number,
    tournamentId: 0,
    round: 0,
    agentA: {
      address: agentA,
      name: displayName((payload.agentAName as string) || '', agentA),
    },
    agentB: {
      address: agentB,
      name: displayName((payload.agentBName as string) || '', agentB),
    },
    phase: 'REVEALING',
    phaseDeadline: Date.now(),
    messages: [],
    choiceA: mapChoice(payload.choiceA as number),
    choiceB: mapChoice(payload.choiceB as number),
    result: payload.result as number,
    commitA: true,
    commitB: true,
    bettingOpen: false,
  };
}
