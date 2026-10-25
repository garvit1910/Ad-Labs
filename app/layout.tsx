import './globals.css';
import './landing-bg.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import { formats } from '@/i18n/formats';
import { geistSans, geistMono, poppins } from '@/lib/fonts-online';
import { Providers } from './providers';

// Adcero's shell (REUSE_MANIFEST §7.6) without auth, sidebar or section chrome.
export const metadata: Metadata = {
  title: 'Ad Lab',
  description: 'Magic Spoon ad recipes tested on Jev-driven shoppers',
};

// The browser gets only the namespaces the copied pages read (§7.5), not all
// 1.3 MB of en.json.
const CLIENT_NAMESPACES = [
  'BrandIdentity',
  'BrandReport',
  'BrandPresence',
  'Common',
  'Dashboard',
  'Shell',
  'Billing',
] as const;
const messages = Object.fromEntries(CLIENT_NAMESPACES.map((ns) => [ns, en[ns]]));

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" data-theme="dark">
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${poppins.variable} bg-background text-foreground antialiased`}
      >
        <NextIntlClientProvider locale="en" messages={messages} formats={formats} timeZone="UTC">
          {/* No shell here: the landing page runs full-bleed, and each section's own
              layout wraps itself in AppShell (padding, width cap, TopNav). */}
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
