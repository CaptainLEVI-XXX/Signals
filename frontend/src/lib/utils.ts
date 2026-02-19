import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function formatTokenAmount(amount: string | bigint, decimals = 18): string {
  let value: bigint;
  if (typeof amount === 'bigint') {
    value = amount;
  } else {
    try {
      const cleaned = (amount || '0').replace(/,/g, '');
      value = /^\d+$/.test(cleaned) ? BigInt(cleaned) : 0n;
    } catch {
      value = 0n;
    }
  }
  const divisor = BigInt(10 ** decimals);
  const whole = value / divisor;
  const fraction = value % divisor;

  if (fraction === 0n) {
    return whole.toLocaleString();
  }

  const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 2);
  return `${whole.toLocaleString()}.${fractionStr}`;
}

export function formatTimeRemaining(deadline: number): string {
  const now = Date.now();
  const remaining = Math.max(0, deadline - now);

  if (remaining === 0) return '0:00';

  const seconds = Math.floor(remaining / 1000) % 60;
  const minutes = Math.floor(remaining / 60000);

  if (minutes > 0) {
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }

  return `0:${seconds.toString().padStart(2, '0')}`;
}

export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getPhaseColor(phase: string): string {
  switch (phase) {
    case 'NEGOTIATION':
      return 'text-signal-gold-glow';
    case 'AWAITING_CHOICES':
      return 'text-warning-bright';
    case 'SETTLING':
      return 'text-cooperate-bright';
    case 'COMPLETE':
      return 'text-signal-text';
    default:
      return 'text-signal-text';
  }
}

export function getPhaseLabel(phase: string): string {
  switch (phase) {
    case 'NEGOTIATION': return 'NEGOTIATING';
    case 'AWAITING_CHOICES': return 'CHOICE PHASE';
    case 'SETTLING': return 'SETTLING';
    case 'COMPLETE': return 'SETTLED';
    default: return phase;
  }
}

export function getStateColor(state: string): string {
  switch (state) {
    case 'REGISTRATION':
      return 'text-blue-400';
    case 'ACTIVE':
    case 'ROUND_IN_PROGRESS':
      return 'text-warning-bright';
    case 'COMPLETE':
      return 'text-cooperate-bright';
    case 'CANCELLED':
      return 'text-defect';
    default:
      return 'text-signal-text';
  }
}

export function getChoiceLabel(choice: number | null): string {
  if (choice === 1) return 'SPLIT';
  if (choice === 2) return 'STEAL';
  return '?';
}

export function getChoiceEmoji(choice: number | null): string {
  if (choice === 1) return '🤝';
  if (choice === 2) return '⚔️';
  return '❓';
}

export function getResultLabel(result: number | null): string {
  switch (result) {
    case 0: return 'Both Split';
    case 1: return 'Agent A Steals';
    case 2: return 'Agent B Steals';
    case 3: return 'Both Steal';
    default: return 'Pending';
  }
}

export function getResultColor(result: number | null): string {
  switch (result) {
    case 0: return 'text-cooperate';
    case 1: return 'text-defect';
    case 2: return 'text-defect';
    case 3: return 'text-defect';
    default: return 'text-signal-text';
  }
}

export function calculatePoints(choiceA: number, choiceB: number): { pointsA: number; pointsB: number } {
  if (choiceA === 0 && choiceB === 0) return { pointsA: 3, pointsB: 3 };
  if (choiceA === 1 && choiceB === 0) return { pointsA: 5, pointsB: 1 };
  if (choiceA === 0 && choiceB === 1) return { pointsA: 1, pointsB: 5 };
  return { pointsA: 0, pointsB: 0 };
}
