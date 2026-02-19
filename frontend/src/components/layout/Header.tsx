'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'framer-motion';
import { Trophy, Radio, BarChart3, Wallet, ChevronDown, LogOut, Droplets, Swords } from 'lucide-react';
import { cn, formatAddress } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useWallet } from '@/contexts/WalletContext';
import { useState, useRef, useEffect } from 'react';

const navItems = [
  { href: '/', label: 'Arena', icon: Radio },
  { href: '/matches', label: 'Matches', icon: Swords },
  { href: '/tournaments', label: 'Tournaments', icon: Trophy },
  { href: '/leaderboard', label: 'Leaderboard', icon: BarChart3 },
];

export function Header() {
  const pathname = usePathname();
  const { isConnected: wsConnected } = useWebSocket();
  const { address, isConnected, isConnecting, connect, disconnect } = useWallet();
  const [showDropdown, setShowDropdown] = useState(false);
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetMessage, setFaucetMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Clear faucet message after 5 seconds
  useEffect(() => {
    if (faucetMessage) {
      const timer = setTimeout(() => setFaucetMessage(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [faucetMessage]);

  const handleFaucet = async () => {
    if (!isConnected || !window.ethereum) {
      setFaucetMessage({ type: 'error', text: 'Please connect your wallet first' });
      return;
    }

    setFaucetLoading(true);
    try {
      const arenaTokenAddress = process.env.NEXT_PUBLIC_ARENA_TOKEN_ADDRESS;

      if (!arenaTokenAddress) {
        setFaucetMessage({ type: 'error', text: 'Token contract not configured' });
        return;
      }

      // Faucet function selector: keccak256("faucet()") = 0xde5f72fd
      const data = '0xde5f72fd';

      const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
          from: address,
          to: arenaTokenAddress,
          data: data,
        }],
      });

      setFaucetMessage({ type: 'success', text: 'Claimed 100 ARENA! Check your wallet.' });
      console.log('Faucet tx:', txHash);
    } catch (error: unknown) {
      console.error('Faucet error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (errorMessage.includes('cooldown') || errorMessage.includes('FaucetCooldownActive')) {
        setFaucetMessage({ type: 'error', text: 'Cooldown active. Try again in 24 hours.' });
      } else if (errorMessage.includes('rejected')) {
        setFaucetMessage({ type: 'error', text: 'Transaction rejected' });
      } else {
        setFaucetMessage({ type: 'error', text: 'Failed to claim tokens' });
      }
    } finally {
      setFaucetLoading(false);
    }
  };

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 backdrop-blur-xl bg-signal-void/90 border-b border-signal-slate">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Logo */}
            <Link href="/" className="flex items-center gap-3 group">
              <div className="relative">
                <Radio className="w-8 h-8 text-signal-gold group-hover:text-signal-gold-bright transition-colors" />
                <div className="absolute inset-0 bg-signal-gold/20 blur-lg rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div className="hidden sm:block">
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-display font-bold tracking-tight text-signal-white">
                    SIGNALS
                  </h1>
                  <span className="badge-beta">Beta</span>
                </div>
                <p className="text-[10px] text-signal-text font-mono uppercase tracking-widest -mt-0.5">
                  BSC Testnet
                </p>
              </div>
            </Link>

            {/* Navigation */}
            <nav className="flex items-center gap-1">
              {navItems.map((item) => {
                const isActive = pathname === item.href ||
                  (item.href !== '/' && pathname.startsWith(item.href));
                const Icon = item.icon;

                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      'relative px-4 py-2 rounded-lg flex items-center gap-2 transition-all duration-200',
                      isActive
                        ? 'text-signal-gold-bright'
                        : 'text-signal-text hover:text-signal-light hover:bg-signal-slate/50'
                    )}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="hidden sm:inline text-sm font-medium">
                      {item.label}
                    </span>
                    {isActive && (
                      <motion.div
                        layoutId="nav-indicator"
                        className="absolute inset-0 bg-signal-gold/15 border border-signal-gold/30 rounded-lg -z-10"
                        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                      />
                    )}
                  </Link>
                );
              })}
            </nav>

            {/* Right side: Status + Faucet + Wallet */}
            <div className="flex items-center gap-3">
              {/* WebSocket status */}
              <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-signal-graphite border border-signal-slate">
                <div className={cn(
                  'w-2 h-2 rounded-full',
                  wsConnected ? 'bg-cooperate animate-pulse' : 'bg-defect'
                )} />
                <span className="text-xs font-mono text-signal-text">
                  {wsConnected ? 'LIVE' : 'OFFLINE'}
                </span>
              </div>

              {/* Faucet Button */}
              {isConnected && (
                <button
                  onClick={handleFaucet}
                  disabled={faucetLoading}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all duration-200',
                    'bg-signal-gold/15 border border-signal-gold/30 text-signal-gold-bright',
                    'hover:bg-signal-gold/25 hover:border-signal-gold/50',
                    faucetLoading && 'opacity-50 cursor-not-allowed'
                  )}
                >
                  <Droplets className={cn('w-4 h-4', faucetLoading && 'animate-pulse')} />
                  <span className="hidden sm:inline text-sm font-medium">
                    {faucetLoading ? 'Claiming...' : 'Faucet'}
                  </span>
                </button>
              )}

              {/* Wallet */}
              {isConnected && address ? (
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => setShowDropdown(!showDropdown)}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-signal-graphite border border-signal-slate hover:border-signal-gold/50 transition-colors"
                  >
                    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-signal-gold to-signal-gold-glow" />
                    <span className="text-sm font-mono text-signal-light">
                      {formatAddress(address)}
                    </span>
                    <ChevronDown className={cn(
                      'w-4 h-4 text-signal-text transition-transform',
                      showDropdown && 'rotate-180'
                    )} />
                  </button>

                  {showDropdown && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="absolute right-0 mt-2 w-48 rounded-lg bg-signal-charcoal border border-signal-slate shadow-xl overflow-hidden"
                    >
                      <div className="p-3 border-b border-signal-slate">
                        <p className="text-xs text-signal-text">Connected</p>
                        <p className="text-sm font-mono text-signal-light truncate">
                          {address}
                        </p>
                      </div>
                      <button
                        onClick={() => {
                          disconnect();
                          setShowDropdown(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm text-defect hover:bg-signal-slate/50 transition-colors"
                      >
                        <LogOut className="w-4 h-4" />
                        Disconnect
                      </button>
                    </motion.div>
                  )}
                </div>
              ) : (
                <button
                  onClick={connect}
                  disabled={isConnecting}
                  className="flex items-center gap-2 btn-primary py-2"
                >
                  <Wallet className="w-4 h-4" />
                  <span className="hidden sm:inline">
                    {isConnecting ? 'Connecting...' : 'Connect Wallet'}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Faucet notification toast */}
      {faucetMessage && (
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -20 }}
          className={cn(
            'fixed top-20 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg',
            faucetMessage.type === 'success'
              ? 'bg-cooperate/20 border border-cooperate/30 text-cooperate'
              : 'bg-defect/20 border border-defect/30 text-defect'
          )}
        >
          <p className="text-sm font-medium">{faucetMessage.text}</p>
        </motion.div>
      )}
    </>
  );
}
