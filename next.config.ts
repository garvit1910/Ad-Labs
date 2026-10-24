import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// next-intl's plugin points the runtime at i18n/request.ts (Adcero's setup).
const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {};

export default withNextIntl(nextConfig);
