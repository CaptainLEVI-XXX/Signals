'use client';

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '@/contexts/WalletContext';

const ARENA_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_ARENA_TOKEN_ADDRESS!;
const SPLIT_OR_STEAL_ADDRESS = process.env.NEXT_PUBLIC_SPLIT_OR_STEAL_ADDRESS!;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const SPLIT_OR_STEAL_ABI = [
  'function placeBet(uint256 matchId, uint8 outcome, uint256 amount)',
  'function claimWinnings(uint256 matchId)',
  'function claimRefund(uint256 matchId)',
  'function getBet(uint256 matchId, address bettor) view returns (tuple(uint256 amount, uint8 outcome, bool claimed))',
  'function getPool(uint256 matchId) view returns (tuple(uint256 totalPool, uint256[5] outcomePools, uint8 state, uint8 result, uint64 expiresAt))',
  'function calculatePotentialWinnings(uint256 matchId, uint8 outcome, uint256 amount) view returns (uint256)',
];

export interface ExistingBet {
  amount: string;
  outcome: number;
  claimed: boolean;
}

interface UseBettingReturn {
  arenaBalance: string;
  allowance: bigint;
  isApproved: boolean;
  existingBet: ExistingBet | null;
  poolState: number;
  poolResult: number;
  txPending: boolean;
  error: string | null;
  potentialWinnings: string;
  approve: () => Promise<void>;
  placeBet: (outcome: number, amount: string) => Promise<void>;
  claimWinnings: () => Promise<void>;
  claimRefund: () => Promise<void>;
  fetchPotentialWinnings: (outcome: number, amount: string) => Promise<void>;
  refresh: () => Promise<void>;
}

// Known custom error selectors from BettingEngine / SplitOrSteal
const ERROR_SELECTORS: Record<string, string> = {
  '0x969bf728': 'Your bet did not match the winning outcome — nothing to claim',
  '0x646cf558': 'Already claimed',
  '0x078d696c': 'Pool has not been settled yet',
  '0xa4c3fd12': 'Betting is closed for this match',
  '0x2101030f': 'Minimum bet is 1 ARENA',
  '0x5a2a206b': 'You already placed a bet on this match',
  '0xcebc0df0': 'Match participants cannot bet on their own match',
};

function parseRevertReason(err: unknown): string {
  const errObj = err as { reason?: string; message?: string; data?: string };
  const msg = errObj.reason || errObj.message || '';

  // Check for raw selector in data or message
  for (const [selector, message] of Object.entries(ERROR_SELECTORS)) {
    if (msg.includes(selector) || errObj.data === selector) return message;
  }

  if (msg.includes('BetTooSmall')) return 'Minimum bet is 1 ARENA';
  if (msg.includes('AlreadyBet')) return 'You already placed a bet on this match';
  if (msg.includes('PoolNotOpen')) return 'Betting is closed for this match';
  if (msg.includes('CannotBetOnOwnMatch')) return 'Match participants cannot bet on their own match';
  if (msg.includes('InvalidOutcome')) return 'Invalid outcome selected';
  if (msg.includes('NothingToClaim')) return 'Your bet did not match the winning outcome — nothing to claim';
  if (msg.includes('AlreadyClaimed')) return 'Already claimed';
  if (msg.includes('PoolNotSettled')) return 'Pool has not been settled yet';
  if (msg.includes('user rejected')) return 'Transaction rejected';
  return msg.slice(0, 120) || 'Transaction failed';
}

export function useBetting(matchId: number): UseBettingReturn {
  const { address, isConnected } = useWallet();

  const [arenaBalance, setArenaBalance] = useState('0');
  const [allowance, setAllowance] = useState<bigint>(0n);
  const [existingBet, setExistingBet] = useState<ExistingBet | null>(null);
  const [poolState, setPoolState] = useState(0);
  const [poolResult, setPoolResult] = useState(0);
  const [txPending, setTxPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [potentialWinnings, setPotentialWinnings] = useState('0');
  const [betAmountForApproval, setBetAmountForApproval] = useState(0n);

  const isApproved = allowance >= betAmountForApproval && betAmountForApproval > 0n;

  const getProvider = useCallback(() => {
    if (typeof window === 'undefined' || !window.ethereum) return null;
    return new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
  }, []);

  const fetchBalance = useCallback(async () => {
    const provider = getProvider();
    if (!provider || !address) return;
    try {
      const token = new ethers.Contract(ARENA_TOKEN_ADDRESS, ERC20_ABI, provider);
      const bal = await token.balanceOf(address);
      setArenaBalance(bal.toString());
    } catch {
      // silent
    }
  }, [address, getProvider]);

  const fetchAllowance = useCallback(async () => {
    const provider = getProvider();
    if (!provider || !address) return;
    try {
      const token = new ethers.Contract(ARENA_TOKEN_ADDRESS, ERC20_ABI, provider);
      const allow = await token.allowance(address, SPLIT_OR_STEAL_ADDRESS);
      setAllowance(BigInt(allow.toString()));
    } catch {
      // silent
    }
  }, [address, getProvider]);

  const fetchExistingBet = useCallback(async () => {
    const provider = getProvider();
    if (!provider || !address) return;
    try {
      const contract = new ethers.Contract(SPLIT_OR_STEAL_ADDRESS, SPLIT_OR_STEAL_ABI, provider);
      const bet = await contract.getBet(matchId, address);
      const amount = BigInt(bet.amount.toString());
      if (amount > 0n) {
        setExistingBet({
          amount: bet.amount.toString(),
          outcome: Number(bet.outcome),
          claimed: bet.claimed,
        });
      } else {
        setExistingBet(null);
      }
    } catch {
      // silent
    }
  }, [address, matchId, getProvider]);

  const fetchPoolState = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    try {
      const contract = new ethers.Contract(SPLIT_OR_STEAL_ADDRESS, SPLIT_OR_STEAL_ABI, provider);
      const pool = await contract.getPool(matchId);
      setPoolState(Number(pool.state));
      setPoolResult(Number(pool.result));
    } catch {
      // silent
    }
  }, [matchId, getProvider]);

  const refresh = useCallback(async () => {
    await Promise.all([fetchBalance(), fetchAllowance(), fetchExistingBet(), fetchPoolState()]);
  }, [fetchBalance, fetchAllowance, fetchExistingBet, fetchPoolState]);

  // Auto-refresh on mount and when address changes
  useEffect(() => {
    if (isConnected && address) {
      refresh();
    }
  }, [isConnected, address, refresh]);

  // Poll pool state every 10s
  useEffect(() => {
    const interval = setInterval(fetchPoolState, 10000);
    return () => clearInterval(interval);
  }, [fetchPoolState]);

  const approve = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    setError(null);
    setTxPending(true);
    try {
      const signer = await provider.getSigner();
      const token = new ethers.Contract(ARENA_TOKEN_ADDRESS, ERC20_ABI, signer);
      const tx = await token.approve(SPLIT_OR_STEAL_ADDRESS, ethers.MaxUint256);
      await tx.wait();
      await fetchAllowance();
    } catch (err) {
      setError(parseRevertReason(err));
    } finally {
      setTxPending(false);
    }
  }, [getProvider, fetchAllowance]);

  const placeBet = useCallback(async (outcome: number, amount: string) => {
    const provider = getProvider();
    if (!provider) return;
    setError(null);
    setTxPending(true);
    try {
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(SPLIT_OR_STEAL_ADDRESS, SPLIT_OR_STEAL_ABI, signer);
      const amountWei = ethers.parseEther(amount);
      const tx = await contract.placeBet(matchId, outcome, amountWei);
      await tx.wait();
      await refresh();
    } catch (err) {
      setError(parseRevertReason(err));
    } finally {
      setTxPending(false);
    }
  }, [matchId, getProvider, refresh]);

  const claimWinnings = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    setError(null);
    setTxPending(true);
    try {
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(SPLIT_OR_STEAL_ADDRESS, SPLIT_OR_STEAL_ABI, signer);
      const tx = await contract.claimWinnings(matchId);
      await tx.wait();
      await refresh();
    } catch (err) {
      setError(parseRevertReason(err));
    } finally {
      setTxPending(false);
    }
  }, [matchId, getProvider, refresh]);

  const claimRefund = useCallback(async () => {
    const provider = getProvider();
    if (!provider) return;
    setError(null);
    setTxPending(true);
    try {
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(SPLIT_OR_STEAL_ADDRESS, SPLIT_OR_STEAL_ABI, signer);
      const tx = await contract.claimRefund(matchId);
      await tx.wait();
      await refresh();
    } catch (err) {
      setError(parseRevertReason(err));
    } finally {
      setTxPending(false);
    }
  }, [matchId, getProvider, refresh]);

  const fetchPotentialWinnings = useCallback(async (outcome: number, amount: string) => {
    const provider = getProvider();
    if (!provider || !amount || parseFloat(amount) <= 0) {
      setPotentialWinnings('0');
      return;
    }
    try {
      const contract = new ethers.Contract(SPLIT_OR_STEAL_ADDRESS, SPLIT_OR_STEAL_ABI, provider);
      const amountWei = ethers.parseEther(amount);
      const winnings = await contract.calculatePotentialWinnings(matchId, outcome, amountWei);
      setPotentialWinnings(winnings.toString());
    } catch {
      setPotentialWinnings('0');
    }
  }, [matchId, getProvider]);

  // Update betAmountForApproval when checked externally
  const updateBetAmount = useCallback((amount: string) => {
    try {
      setBetAmountForApproval(ethers.parseEther(amount || '0'));
    } catch {
      setBetAmountForApproval(0n);
    }
  }, []);

  // Expose updateBetAmount via a combined placeBet that also tracks the amount
  const placeBetWithTracking = useCallback(async (outcome: number, amount: string) => {
    updateBetAmount(amount);
    await placeBet(outcome, amount);
  }, [placeBet, updateBetAmount]);

  return {
    arenaBalance,
    allowance,
    isApproved,
    existingBet,
    poolState,
    poolResult,
    txPending,
    error,
    potentialWinnings,
    approve,
    placeBet: placeBetWithTracking,
    claimWinnings,
    claimRefund,
    fetchPotentialWinnings,
    refresh,
  };
}
