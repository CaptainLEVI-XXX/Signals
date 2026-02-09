import { ethers } from 'ethers';
import { config } from '../config.js';

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
}

export class AuthManager {
  private pendingChallenges: Map<string, PendingChallenge> = new Map();  // challengeId -> challenge

  // Generate a challenge for a new connection
  generateChallenge(): { challengeId: string; challenge: string; expiresAt: number } {
    const challengeId = ethers.hexlify(ethers.randomBytes(16));
    const challenge = `Sign this message to authenticate with Signals Arena.\n\nChallenge: ${ethers.hexlify(ethers.randomBytes(32))}\nTimestamp: ${Date.now()}`;
    const expiresAt = Date.now() + config.authChallengeExpiry;

    this.pendingChallenges.set(challengeId, { challenge, expiresAt });

    // Auto-cleanup after expiry
    setTimeout(() => this.pendingChallenges.delete(challengeId), config.authChallengeExpiry + 1000);

    return { challengeId, challenge, expiresAt };
  }

  // Verify a challenge response
  verifyChallenge(challengeId: string, address: string, signature: string): { valid: boolean; reason?: string } {
    const pending = this.pendingChallenges.get(challengeId);

    if (!pending) {
      return { valid: false, reason: 'Challenge not found or expired' };
    }

    if (Date.now() > pending.expiresAt) {
      this.pendingChallenges.delete(challengeId);
      return { valid: false, reason: 'Challenge expired' };
    }

    try {
      const recovered = ethers.verifyMessage(pending.challenge, signature);
      if (recovered.toLowerCase() !== address.toLowerCase()) {
        return { valid: false, reason: 'Signature does not match claimed address' };
      }

      // Challenge consumed
      this.pendingChallenges.delete(challengeId);
      return { valid: true };
    } catch {
      return { valid: false, reason: 'Invalid signature format' };
    }
  }
}
