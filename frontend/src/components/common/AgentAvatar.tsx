'use client';

import { cn } from '@/lib/utils';

interface AgentAvatarProps {
  name: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  showRing?: boolean;
  ringColor?: 'mint' | 'cooperate' | 'defect' | 'cyan';
}

export function AgentAvatar({
  name,
  avatarUrl,
  size = 'md',
  className,
  showRing = false,
  ringColor = 'mint',
}: AgentAvatarProps) {
  const sizeClasses = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-12 h-12 text-sm',
    lg: 'w-16 h-16 text-lg',
    xl: 'w-24 h-24 text-2xl',
  };

  const ringClasses = {
    mint: 'ring-signal-mint shadow-glow-mint',
    cooperate: 'ring-cooperate shadow-glow-cooperate',
    defect: 'ring-defect shadow-glow-defect',
    cyan: 'ring-signal-cyan shadow-glow-mint',
  };

  // Generate a consistent color from name - using Signals brand colors
  const colors = [
    'from-signal-mint to-signal-cyan',
    'from-emerald-400 to-teal-500',
    'from-cyan-400 to-blue-500',
    'from-yellow-400 to-amber-500',
    'from-rose-400 to-pink-500',
    'from-amber-400 to-orange-500',
  ];
  const colorIndex = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % colors.length;
  const gradientClass = colors[colorIndex];

  const initials = name
    .split(/\s+/)
    .map(word => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div
      className={cn(
        'relative rounded-xl overflow-hidden flex items-center justify-center font-display',
        sizeClasses[size],
        showRing && `ring-2 ${ringClasses[ringColor]}`,
        className
      )}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={name}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className={cn('w-full h-full flex items-center justify-center bg-gradient-to-br', gradientClass)}>
          <span className="text-signal-black font-bold">{initials}</span>
        </div>
      )}
    </div>
  );
}
