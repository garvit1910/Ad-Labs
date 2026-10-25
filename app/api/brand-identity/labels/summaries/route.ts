import { z } from 'zod';
import { orgBody, pageHandler } from '@/lib/adlab/pages/http';

// Localized ad summaries only fire for a non-English locale; Ad Lab is English-only.
const schema = orgBody.extend({ locale: z.string().optional(), ids: z.array(z.string()).optional() });

export const POST = pageHandler({
  schema,
  live: async (body) => ({ locale: body.locale ?? 'en', summaries: {} }),
});
