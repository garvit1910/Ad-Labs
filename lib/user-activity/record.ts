/**
 * Ad Lab same-path stub (REUSE_MANIFEST §8.2): the actor schema the
 * brand-presence payloads validate, and a no-op activity log.
 */
import { z } from 'zod';

export const userActivityActorSchema = z.object({
  type: z.enum(['human', 'agent', 'system']),
  userId: z.string().uuid().nullable(),
  impersonatedBy: z.string().nullable(),
});

export type UserActivityActor = z.infer<typeof userActivityActorSchema>;

export const SYSTEM_ACTIVITY_ACTOR: UserActivityActor = {
  type: 'system',
  userId: null,
  impersonatedBy: null,
};

export type ListeningPlatform =
  | 'reddit'
  | 'amazon'
  | 'google_maps'
  | 'trustpilot'
  | 'x'
  | 'tiktok'
  | 'instagram';

export async function recordListeningStarted(
  _db: unknown,
  _params: {
    organizationId: string;
    brandProfileId: string;
    actor: UserActivityActor;
    platform: ListeningPlatform;
    sourceId?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {}
