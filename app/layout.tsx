import './globals.css';
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
          <Providers>
            <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background p-6 sm:p-8">
              <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col gap-6">{children}</div>
            </div>
          </Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
