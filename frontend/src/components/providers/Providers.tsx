'use client';

import { ReactNode } from 'react';
import { WalletProvider } from '@/contexts/WalletContext';
import { OnboardingModal } from '@/components/onboarding/OnboardingModal';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      {children}
      <OnboardingModal />
    </WalletProvider>
  );
}
