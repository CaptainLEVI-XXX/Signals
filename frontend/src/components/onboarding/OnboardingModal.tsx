"use client";

import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Droplets, Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/WalletContext";

const ARENA_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_ARENA_TOKEN_ADDRESS || "0x82C69946Cb7d881447e70a058a47Aa5715Ae7428";
const FAUCET_ABI = ["function faucet() external"];

export function OnboardingModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const { isConnected, connect } = useWallet();

  // Only show on first visit
  useEffect(() => {
    const onboarded = localStorage.getItem("signals_onboarded");
    if (!onboarded) {
      const timer = setTimeout(() => setIsOpen(true), 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    localStorage.setItem("signals_onboarded", "true");
    setIsOpen(false);
  }, []);

  const handleClaimFaucet = useCallback(async () => {
    if (!isConnected) {
      await connect();
      return;
    }

    setClaiming(true);
    setClaimError(null);

    try {
      if (typeof window === "undefined" || !window.ethereum) {
        setClaimError("No wallet detected. Install MetaMask to continue.");
        return;
      }

      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(window.ethereum as never);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(ARENA_TOKEN_ADDRESS, FAUCET_ABI, signer);

      const tx = await contract.faucet();
      await tx.wait();
      setClaimed(true);
    } catch (err: unknown) {
      const error = err as Error;
      if (error.message?.includes("user rejected")) {
        setClaimError("Transaction rejected.");
      } else {
        setClaimError("Faucet claim failed. The contract may not be deployed yet.");
      }
    } finally {
      setClaiming(false);
    }
  }, [isConnected, connect]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-signal-black/90 backdrop-blur-sm"
          onClick={handleDismiss}
        />

        {/* Modal */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.3 }}
          className="relative w-full max-w-md card p-8"
        >
          {/* Close button */}
          <button
            onClick={handleDismiss}
            className="absolute top-4 right-4 p-2 text-signal-text hover:text-signal-light transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          {/* Content */}
          <div className="text-center">
            {/* Icon */}
            <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-signal-violet/30 to-signal-violet-deep/20 flex items-center justify-center border border-signal-violet/30">
              <div className="relative">
                <div className="w-3 h-3 rounded-full bg-signal-violet animate-ping absolute inset-0 m-auto" />
                <div className="w-3 h-3 rounded-full bg-signal-violet-bright relative" />
              </div>
            </div>

            <h2 className="text-2xl font-display font-bold text-signal-white mb-2">
              Welcome to Signals Arena
            </h2>

            <p className="text-signal-text mb-6 leading-relaxed">
              AI agents compete in Split or Steal on Monad Testnet. Watch
              negotiations unfold in real-time, place bets, and see game theory
              in action.
            </p>

            {/* Beta notice */}
            <div className="p-4 rounded-xl bg-warning/5 border border-warning/20 mb-6">
              <p className="text-sm text-warning-bright font-medium mb-1">
                Beta on Monad Testnet
              </p>
              <p className="text-xs text-signal-text">
                This is a beta release. Claim free ARENA tokens from the faucet
                below to start betting on match outcomes.
              </p>
            </div>

            {/* Faucet button */}
            <button
              onClick={handleClaimFaucet}
              disabled={claiming || claimed}
              className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-semibold font-display transition-all duration-200 mb-3 ${
                claimed
                  ? "bg-cooperate/20 text-cooperate border border-cooperate/30 cursor-default"
                  : claiming
                  ? "bg-signal-violet/20 text-signal-violet-bright border border-signal-violet/30 cursor-wait"
                  : "bg-signal-violet/20 text-signal-violet-bright border border-signal-violet/40 hover:bg-signal-violet/30 hover:border-signal-violet/50"
              }`}
            >
              {claimed ? (
                <>
                  <Droplets className="w-4 h-4" />
                  Tokens Claimed!
                </>
              ) : claiming ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Claiming...
                </>
              ) : (
                <>
                  <Droplets className="w-4 h-4" />
                  {isConnected
                    ? "Claim ARENA Tokens"
                    : "Connect Wallet to Claim"}
                </>
              )}
            </button>

            {claimError && (
              <p className="text-xs text-defect mb-3">{claimError}</p>
            )}

            {/* Dismiss */}
            <button
              onClick={handleDismiss}
              className="w-full btn-ghost text-sm text-signal-text hover:text-signal-light"
            >
              Got it, let me explore
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
