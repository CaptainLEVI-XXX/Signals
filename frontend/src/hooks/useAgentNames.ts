'use client';

import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import type { Match } from '@/types';

const AGENT_REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS!;
const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545/';

const REGISTRY_ABI = [
  'function getAgentByWallet(address wallet) view returns (tuple(uint256 id, address wallet, string name, string avatarUrl, string metadataUri))',
];

// Global cache so names persist across component mounts and re-renders
const nameCache = new Map<string, string>();
// Track in-flight lookups to avoid duplicate RPC calls
const pendingLookups = new Map<string, Promise<string>>();

let provider: ethers.JsonRpcProvider | null = null;
function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return provider;
}

/** Check if a "name" is actually an address or truncated address */
export function isAddressLike(name: string): boolean {
  if (!name) return true;
  if (name.startsWith('0x')) return true;
  if (/^[a-f0-9]{4,}\.\.\.[a-f0-9]{4,}$/i.test(name)) return true;
  return false;
}

/** Resolve a single agent name from the on-chain registry. Cached. */
export async function resolveAgentName(address: string): Promise<string> {
  if (!address) return '';
  const lower = address.toLowerCase();

  const cached = nameCache.get(lower);
  if (cached) return cached;

  // De-duplicate in-flight requests
  const pending = pendingLookups.get(lower);
  if (pending) return pending;

  const lookup = (async () => {
    try {
      const registry = new ethers.Contract(AGENT_REGISTRY_ADDRESS, REGISTRY_ABI, getProvider());
      const agent = await registry.getAgentByWallet(address);
      const name = agent.name || '';
      if (name) {
        nameCache.set(lower, name);
        return name;
      }
    } catch {
      // Not registered or RPC error
    } finally {
      pendingLookups.delete(lower);
    }
    return '';
  })();

  pendingLookups.set(lower, lookup);
  return lookup;
}

/** Get cached name synchronously (returns '' if not cached yet) */
export function getCachedName(address: string): string {
  return nameCache.get(address.toLowerCase()) || '';
}

/**
 * Hook: resolves on-chain names for two agents.
 * Used on the match detail page.
 */
export function useAgentNames(
  agentA: { address: string; name: string },
  agentB: { address: string; name: string },
): { nameA: string; nameB: string } {
  const [nameA, setNameA] = useState(agentA.name);
  const [nameB, setNameB] = useState(agentB.name);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      const [resolvedA, resolvedB] = await Promise.all([
        isAddressLike(agentA.name) ? resolveAgentName(agentA.address) : Promise.resolve(''),
        isAddressLike(agentB.name) ? resolveAgentName(agentB.address) : Promise.resolve(''),
      ]);

      if (cancelled) return;
      if (resolvedA) setNameA(resolvedA);
      else setNameA(agentA.name);
      if (resolvedB) setNameB(resolvedB);
      else setNameB(agentB.name);
    }

    resolve();
    return () => { cancelled = true; };
  }, [agentA.address, agentA.name, agentB.address, agentB.name]);

  return { nameA, nameB };
}

/**
 * Hook: resolves names for a list of matches.
 * Used on the home page for match cards.
 */
export function useResolvedMatches(matches: Match[]): Match[] {
  const [resolved, setResolved] = useState<Match[]>(matches);

  const resolveAll = useCallback(async (input: Match[]) => {
    if (input.length === 0) {
      setResolved([]);
      return;
    }

    // Collect unique addresses that need resolution
    const needsResolution = new Set<string>();
    for (const m of input) {
      if (isAddressLike(m.agentA.name)) needsResolution.add(m.agentA.address);
      if (isAddressLike(m.agentB.name)) needsResolution.add(m.agentB.address);
    }

    // Resolve all at once
    if (needsResolution.size > 0) {
      await Promise.all(
        Array.from(needsResolution).map((addr) => resolveAgentName(addr))
      );
    }

    // Apply cached names
    const result = input.map((m) => {
      const nameA = getCachedName(m.agentA.address) || m.agentA.name;
      const nameB = getCachedName(m.agentB.address) || m.agentB.name;
      if (nameA === m.agentA.name && nameB === m.agentB.name) return m;
      return {
        ...m,
        agentA: { ...m.agentA, name: nameA },
        agentB: { ...m.agentB, name: nameB },
      };
    });

    setResolved(result);
  }, []);

  useEffect(() => {
    resolveAll(matches);
  }, [matches, resolveAll]);

  return resolved;
}
