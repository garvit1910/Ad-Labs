import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl's plugin points the runtime at i18n/request.ts (Adcero's setup).
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  // Don't let `next dev` write an AGENTS.md into the repo root when a coding agent runs it.
  agentRules: false,
};

export default withNextIntl(nextConfig);
