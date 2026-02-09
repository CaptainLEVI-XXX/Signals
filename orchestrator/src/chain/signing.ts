import { ethers } from 'ethers';
import { config } from '../config.js';

// EIP-712 types
export const MATCH_CHOICE_TYPES = {
  MatchChoice: [
    { name: 'matchId', type: 'uint256' },
    { name: 'choice', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export function getDomain(contractAddress: string) {
  return {
    name: 'Signals',
    version: '2',
    chainId: config.chainId,
    verifyingContract: contractAddress,
  };
}

// Build complete EIP-712 typed data for agent to sign
export function buildSigningPayload(
  contractAddress: string,
  matchId: number,
  nonce: number
) {
  const domain = getDomain(contractAddress);
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      MatchChoice: MATCH_CHOICE_TYPES.MatchChoice,
    },
    domain,
    primaryType: 'MatchChoice' as const,
    message: {
      matchId: matchId.toString(),
      choice: 0,  // agent fills this
      nonce: nonce.toString(),
    },
  };
}

// Validate signature locally (before submitting to chain)
export function validateSignature(
  contractAddress: string,
  matchId: number,
  choice: number,
  nonce: number,
  signature: string,
  expectedSigner: string
): boolean {
  const domain = getDomain(contractAddress);
  const message = { matchId, choice, nonce };

  try {
    const recovered = ethers.verifyTypedData(
      domain,
      MATCH_CHOICE_TYPES,
      message,
      signature
    );
    return recovered.toLowerCase() === expectedSigner.toLowerCase();
  } catch {
    return false;
  }
}

// Generate commitment hash for spectators (hides choice)
export function generateCommitHash(signature: string, salt: string): string {
  return ethers.keccak256(
    ethers.solidityPacked(['bytes', 'bytes32'], [signature, salt])
  );
}

// Generate random salt for match
export function generateMatchSalt(): string {
  return ethers.hexlify(ethers.randomBytes(32));
}
