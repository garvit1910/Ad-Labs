import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Per-user, per-device, per-org selection of the active Brand Presence brand
 * (agency multi-brand). Mirrors the ad-account selection pattern: the explicit
 * choice is persisted (keyed by org) so a switch survives reload; the derived
 * "current" profile lives in `useBrandProfileScope` (which falls back to the
 * newest profile when nothing is explicitly selected or the selection is
 * stale). No server state — teammates can view different brands independently.
 */
interface BrandProfileState {
  /** orgId -> selected brandProfileId. */
  explicitSelections: Record<string, string>;
  setSelectedProfile: (organizationId: string, brandProfileId: string) => void;
  clearSelection: (organizationId: string) => void;
}

export const useBrandProfileStore = create<BrandProfileState>()(
  persist(
    (set) => ({
      explicitSelections: {},
      setSelectedProfile: (organizationId, brandProfileId) =>
        set((state) => ({
          explicitSelections: {
            ...state.explicitSelections,
            [organizationId]: brandProfileId,
          },
        })),
      clearSelection: (organizationId) =>
        set((state) => {
          if (!(organizationId in state.explicitSelections)) return state;
          const next = { ...state.explicitSelections };
          delete next[organizationId];
          return { explicitSelections: next };
        }),
    }),
    {
      name: 'brand-profile-storage',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ explicitSelections: state.explicitSelections }),
    },
  ),
);
