// Server-only, zero app imports: is an IP address one a server-side fetch must
// never reach? Shared by every SSRF guard (`lib/video-fetch-utils.ts`
// `validateSafeRemoteUrl`, `lib/mcp-public/fetch-uploaded-file.ts`) so the
// private/reserved ranges and the IPv6 embeddings of an IPv4 address
// (IPv4-mapped, IPv4-compatible, NAT64 64:ff9b::/96, 6to4 2002::/16) are
// decided in one place. Before 2026-10-20 the two guards disagreed: the media
// fetcher blocked only ::ffff: and fc/fd/fe8-feb, so 64:ff9b::a9fe:a9fe
// (NAT64 of 169.254.169.254) or 2002:7f00:1:: passed it.
import { isIP } from 'node:net';

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** [network, prefix length] — every range a public file host can never live in. */
const BLOCKED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network" / unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

function isBlockedIpv4Int(value: number): boolean {
  return BLOCKED_IPV4.some(([network, prefix]) => {
    const base = ipv4ToInt(network) as number;
    const size = 2 ** (32 - prefix);
    return value >= base && value < base + size;
  });
}

/** Eight 16-bit groups, or null when the text is not an IPv6 address. */
function parseIpv6(address: string): number[] | null {
  let text = address.toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // A trailing dotted IPv4 (e.g. ::ffff:10.0.0.1) becomes two groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    text = `${text.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (const group of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  if (!head || !rest) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = (hi: number, lo: number) => hi * 65536 + lo;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;

  // :: (unspecified) and ::1 (loopback)
  if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible)
  if (leadingZero && (g5 === 0xffff || g5 === 0)) return isBlockedIpv4Int(embeddedV4(g6, g7));
  // 64:ff9b::/96 NAT64 — the embedded IPv4 decides
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4Int(embeddedV4(g6, g7));
  }
  // 2002::/16 6to4 — the embedded IPv4 decides
  if (g0 === 0x2002) return isBlockedIpv4Int(embeddedV4(g1, g2));
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard
  return false;
}

/** True when an address must never be fetched (also true for anything unparseable). */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address.replace(/^\[|\]$/g, '').split('%')[0]);
  if (family === 4) {
    const value = ipv4ToInt(address);
    return value === null || isBlockedIpv4Int(value);
  }
  if (family === 6) {
    const groups = parseIpv6(address);
    return groups === null || isBlockedIpv6(groups);
  }
  return true;
}
