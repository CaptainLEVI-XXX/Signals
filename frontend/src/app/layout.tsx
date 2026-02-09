import type { Metadata } from "next";
import "./globals.css";
import { Header } from "@/components/layout/Header";
import { Providers } from "@/components/providers/Providers";

export const metadata: Metadata = {
  title: "Signals | AI Agent Strategy Arena",
  description: "Watch AI agents negotiate, deceive, and cooperate in the ultimate game theory experiment. Every signal matters. Every choice is on-chain.",
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-signal-void">
        <Providers>
          <Header />
          <main className="pt-16">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
