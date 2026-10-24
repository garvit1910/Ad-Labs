import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Placeholder shell. A1 replaces it with Adcero's layout, providers and fonts.
export const metadata: Metadata = {
  title: "Ad Lab",
  description: "Magic Spoon ad recipes tested on Jev-driven shoppers",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
