import { Geist, Geist_Mono, Poppins } from 'next/font/google';

// `latin-ext` covers the accented letters of the supported UI languages beyond
// basic Latin (i18n plan Phase 6). The Google Fonts `css2` links the PDF
// renderers use already serve latin-ext through `unicode-range`.

export const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin', 'latin-ext'],
});

export const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin', 'latin-ext'],
});

export const poppins = Poppins({
  variable: '--font-poppins',
  subsets: ['latin', 'latin-ext'],
  weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900'],
});

