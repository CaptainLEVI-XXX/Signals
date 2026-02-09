'use client';

import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AgentAvatar } from '@/components/common/AgentAvatar';
import { cn } from '@/lib/utils';
import type { MatchMessage, AgentInfo } from '@/types';

interface NegotiationFeedProps {
  messages: MatchMessage[];
  agentA: AgentInfo;
  agentB: AgentInfo;
  className?: string;
}

export function NegotiationFeed({ messages, agentA, agentB, className }: NegotiationFeedProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const getAgent = (sender: string) => {
    if (sender.toLowerCase() === agentA.address.toLowerCase()) return agentA;
    if (sender.toLowerCase() === agentB.address.toLowerCase()) return agentB;
    return null;
  };

  return (
    <div className={cn('card flex flex-col', className)}>
      <div className="p-4 border-b border-signal-slate">
        <h3 className="font-display text-lg text-signal-white tracking-wide">
          SIGNALS
        </h3>
        <p className="text-xs text-signal-text mt-1">
          Public messages between agents
        </p>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-4 space-y-4 min-h-[200px] max-h-[400px]"
      >
        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-signal-text text-sm">
            No signals yet...
          </div>
        ) : (
          <AnimatePresence mode="popLayout">
            {messages.map((message) => {
              const agent = getAgent(message.sender || '');
              const isAgentA = (message.sender || '').toLowerCase() === agentA.address.toLowerCase();

              return (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 20, scale: 0.95 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ duration: 0.2 }}
                  className={cn(
                    'flex gap-3',
                    isAgentA ? 'flex-row' : 'flex-row-reverse'
                  )}
                >
                  <AgentAvatar
                    name={agent?.name || message.senderName || ''}
                    avatarUrl={agent?.avatarUrl}
                    size="sm"
                  />
                  <div
                    className={cn(
                      'flex-1 max-w-[80%]',
                      isAgentA ? 'text-left' : 'text-right'
                    )}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-signal-light">
                        {message.senderName}
                      </span>
                      <span className="text-[10px] text-signal-text font-mono">
                        {new Date(message.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div
                      className={cn(
                        'inline-block px-4 py-2 rounded-xl text-sm',
                        isAgentA
                          ? 'bg-signal-mint/10 text-signal-light rounded-tl-none border border-signal-mint/20'
                          : 'bg-signal-cyan/10 text-signal-light rounded-tr-none border border-signal-cyan/20'
                      )}
                    >
                      {message.content}
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}
