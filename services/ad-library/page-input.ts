/**
 * Parses whatever a user pastes to identify a competitor's Facebook page —
 * a page URL, an @handle, a bare handle, a profile.php?id= link, or a raw
 * numeric Page ID — into one of two canonical forms the Apify provider can
 * scrape:
 *   - handle:    vanity name → scraped via the raw facebook.com/<handle> page URL
 *   - numericId: page id      → scraped via the Ad Library view_all_page_id URL
 *
 * Customers never need to find the numeric Page ID; the sync resolves it from
 * the scraped ads afterwards.
 */

export interface ParsedPageInput {
  /** Vanity handle (no leading @), when the input is URL/handle-based. */
  handle: string | null;
  /** Numeric page id, when the input is numeric or a profile.php?id= link. */
  numericId: string | null;
}

const HANDLE_RE = /^[A-Za-z0-9.\-_]{2,}$/;
const NUMERIC_RE = /^\d{5,}$/;

/** Returns null when the input can't be understood as a page reference. */
export function parsePageInput(raw: string): ParsedPageInput | null {
  const value = raw.trim();
  if (!value) return null;

  // Bare numeric id.
  if (NUMERIC_RE.test(value)) return { handle: null, numericId: value };

  // @handle.
  if (value.startsWith('@')) {
    const handle = value.slice(1);
    return HANDLE_RE.test(handle) ? { handle, numericId: null } : null;
  }

  // A facebook URL (with or without scheme).
  if (/facebook\.com/i.test(value)) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      return null;
    }
    // profile.php?id=<num>
    if (url.pathname.toLowerCase().includes('profile.php')) {
      const id = url.searchParams.get('id')?.trim();
      return id && NUMERIC_RE.test(id) ? { handle: null, numericId: id } : null;
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    // /people/<Name>/<id> — the trailing segment is the numeric id.
    if (segments[0].toLowerCase() === 'people') {
      const id = segments[segments.length - 1];
      if (NUMERIC_RE.test(id)) return { handle: null, numericId: id };
      return null;
    }
    // Feature prefixes that sit BEFORE the page identifier. Without this the
    // prefix itself ("p") was taken as the handle and the scrape 404'd:
    //   /p/<Name>-<id>/                      unified profile URL (current)
    //   /pg/<handle>/posts/                  legacy page prefix
    //   /pages/<Name>/<id>/                  legacy pages URL
    //   /pages/category/<Cat>/<Name>-<id>/   legacy category URL
    const prefix = segments[0].toLowerCase();
    if (prefix === 'p' || prefix === 'pg' || prefix === 'pages') {
      const tail = prefix === 'pages' ? segments.slice(1) : segments.slice(1, 2);
      if (tail.length === 0) return null;
      const last = decodeURIComponent(tail[tail.length - 1]);
      if (NUMERIC_RE.test(last)) return { handle: null, numericId: last };
      return HANDLE_RE.test(last) ? { handle: last, numericId: null } : null;
    }
    const first = decodeURIComponent(segments[0]);
    if (NUMERIC_RE.test(first)) return { handle: null, numericId: first };
    return HANDLE_RE.test(first) ? { handle: first, numericId: null } : null;
  }

  // Bare handle.
  return HANDLE_RE.test(value) ? { handle: value, numericId: null } : null;
}
