import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, interceptors } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { isBlockedAddress } from '@/lib/security/blocked-address';

/**
 * Shared utilities for safely fetching remote media in API routes.
 * Prevents SSRF attacks and OOM from oversized payloads.
 */

const DEFAULT_MAX_VIDEO_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB
const DEFAULT_MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_PROXY_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

/** CIDR-style blocked ranges as [start, end] numeric pairs for IPv4 */
const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipToNum('127.0.0.0'), ipToNum('127.255.255.255')], // 127.0.0.0/8
  [ipToNum('10.0.0.0'), ipToNum('10.255.255.255')], // 10.0.0.0/8
  [ipToNum('100.64.0.0'), ipToNum('100.127.255.255')], // 100.64.0.0/10
  [ipToNum('172.16.0.0'), ipToNum('172.31.255.255')], // 172.16.0.0/12
  [ipToNum('192.168.0.0'), ipToNum('192.168.255.255')], // 192.168.0.0/16
  [ipToNum('169.254.0.0'), ipToNum('169.254.255.255')], // 169.254.0.0/16
  [ipToNum('0.0.0.0'), ipToNum('0.255.255.255')], // 0.0.0.0/8
  [ipToNum('198.18.0.0'), ipToNum('198.19.255.255')], // 198.18.0.0/15
  [ipToNum('224.0.0.0'), ipToNum('255.255.255.255')], // multicast + reserved
];

const BLOCKED_IPV6_PREFIXES = ['fc', 'fd', 'fe8', 'fe9', 'fea', 'feb', '2001:db8:'];
const GENERIC_BINARY_CONTENT_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);
const DEFAULT_MEDIA_BLOCKED_PREFIXES = ['text/', 'application/xhtml+xml', 'application/xml'];

export type SafeRemoteMediaKind = 'asset' | 'image' | 'video';

export interface SafeRemoteUrlValidationOptions {
  allowedProtocols?: readonly string[];
  allowedHosts?: readonly string[];
  blockedHostnames?: readonly string[];
  blockedHostnameSuffixes?: readonly string[];
}

export interface SafeRemoteFetchOptions {
  kind: SafeRemoteMediaKind;
  maxBytes?: number;
  allowedHosts?: string[];
  allowedProtocols?: readonly string[];
  blockedHostnames?: readonly string[];
  blockedHostnameSuffixes?: readonly string[];
}

export interface SafeRemoteFetchResult {
  buffer: ArrayBuffer;
  contentType: string;
  mimeType: string;
}

export interface SafeRemoteUrlValidationResult {
  valid: true;
  parsed: URL;
  pinnedAddress: string;
}

export type SafeRemoteUrlValidationOutcome =
  | SafeRemoteUrlValidationResult
  | { valid: false; reason: string };

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

export function getDeclaredContentLength(response: Response): number | null {
  const contentLengthHeader = response.headers.get('content-length');
  if (!contentLengthHeader) {
    return null;
  }

  const declaredSize = Number.parseInt(contentLengthHeader, 10);
  return Number.isFinite(declaredSize) && declaredSize >= 0
    ? declaredSize
    : null;
}

export function isRedirectResponse(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

export function isDeclaredContentLengthAboveLimit(
  response: Response,
  maxBytes: number
): boolean {
  const declaredSize = getDeclaredContentLength(response);
  return declaredSize !== null && declaredSize > maxBytes;
}

export async function readResponseBufferWithLimit(
  response: Response,
  maxBytes: number
): Promise<ArrayBuffer> {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error(
            `Remote media exceeds maximum allowed size (${Math.round(maxBytes / 1024 / 1024)}MB). Actual size exceeded the configured limit`
          );
        }

        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return combined.buffer;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw new Error(
      `Remote media exceeds maximum allowed size (${Math.round(maxBytes / 1024 / 1024)}MB). Actual size: ${Math.round(buffer.byteLength / 1024 / 1024)}MB`
    );
  }

  return buffer;
}

function ipToNum(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, octet) => (acc << 8) + Number.parseInt(octet, 10), 0) >>> 0;
}

// The local range lists below are kept as an extra layer; every IP literal
// and every resolved address is ALSO run through the shared classifier
// (`lib/security/blocked-address.ts`), which decides the IPv6 embeddings of
// an IPv4 address (NAT64 64:ff9b::/96, 6to4 2002::/16, IPv4-compatible
// ::a.b.c.d) by the embedded address — the local prefix list missed them.
function isBlockedIPv4(hostname: string): boolean {
  if (isIP(hostname) === 4 && isBlockedAddress(hostname)) {
    return true;
  }
  const parts = hostname.split('.');
  if (
    parts.length !== 4 ||
    parts.some((part) => {
      const octet = Number(part);
      return (
        Number.isNaN(octet) ||
        !Number.isInteger(octet) ||
        octet < 0 ||
        octet > 255
      );
    })
  ) {
    return false;
  }

  const num = ipToNum(hostname);
  return BLOCKED_IPV4_RANGES.some(([start, end]) => num >= start && num <= end);
}

function isBlockedIPv6(hostname: string): boolean {
  const lower = normalizeHostname(hostname);

  if (lower === '::' || lower === '::1') {
    return true;
  }

  if (lower.startsWith('::ffff:')) {
    return true;
  }

  if (isIP(lower) === 6 && isBlockedAddress(lower)) {
    return true;
  }

  return BLOCKED_IPV6_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isBlockedIpAddress(address: string): boolean {
  return isBlockedIPv4(address) || isBlockedIPv6(address);
}

async function resolveHostnameAddresses(hostname: string): Promise<string[]> {
  const normalizedHost = normalizeHostname(hostname);
  if (isIP(normalizedHost)) {
    return [normalizedHost];
  }

  const results = await lookup(normalizedHost, {
    all: true,
    verbatim: true,
  });

  return results.map((result) => result.address.toLowerCase());
}

export function createPinnedDispatcher(address: string): Agent {
  const family = isIP(address) === 6 ? 6 : 4;

  return new Agent({
    interceptors: {
      Client: [],
      Pool: [],
      Agent: [
        interceptors.dns({
          lookup(_hostname, _options, callback) {
            callback(null, [{ address, family, ttl: 60 }]);
          },
        }),
      ],
    },
  });
}

export function normalizeRemoteContentType(contentType: string | null): string {
  return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function isGenericBinaryContentType(contentType: string): boolean {
  return GENERIC_BINARY_CONTENT_TYPES.has(contentType);
}

export function isSafeRemoteMediaContentType(
  kind: SafeRemoteMediaKind,
  contentType: string
): boolean {
  if (!contentType) {
    return true;
  }

  if (DEFAULT_MEDIA_BLOCKED_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
    return false;
  }

  if (kind === 'image') {
    return contentType.startsWith('image/') || isGenericBinaryContentType(contentType);
  }

  if (kind === 'video') {
    return contentType.startsWith('video/') || isGenericBinaryContentType(contentType);
  }

  return (
    contentType.startsWith('image/') ||
    contentType.startsWith('video/') ||
    isGenericBinaryContentType(contentType)
  );
}

function inferVideoMimeType(url: string, contentType: string): string {
  if (contentType.startsWith('video/')) {
    return contentType;
  }

  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith('.webm')) {
    return 'video/webm';
  }
  if (lowerUrl.endsWith('.mov')) {
    return 'video/quicktime';
  }
  if (lowerUrl.endsWith('.mkv')) {
    return 'video/x-matroska';
  }

  return 'video/mp4';
}

export async function validateSafeRemoteUrl(
  url: string,
  options: SafeRemoteUrlValidationOptions = {}
): Promise<SafeRemoteUrlValidationOutcome> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  const allowedProtocols = options.allowedProtocols ?? ['https:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    return {
      valid: false,
      reason:
        allowedProtocols.length === 2 &&
        allowedProtocols.includes('http:') &&
        allowedProtocols.includes('https:')
          ? 'Only HTTP and HTTPS URLs are allowed'
          : 'Only HTTPS URLs are allowed',
    };
  }

  const hostname = normalizeHostname(parsed.hostname);

  const blockedHostnames = new Set([
    'localhost',
    'localhost.',
    'localhost.localdomain',
    '0.0.0.0',
    '::1',
    ...(options.blockedHostnames ?? []),
  ].map((value) => value.toLowerCase()));
  if (blockedHostnames.has(hostname)) {
    return { valid: false, reason: 'Localhost URLs are not allowed' };
  }

  const blockedHostnameSuffixes = options.blockedHostnameSuffixes ?? [];
  if (
    blockedHostnameSuffixes.some((suffix) =>
      hostname === suffix.slice(1) || hostname.endsWith(suffix)
    )
  ) {
    return { valid: false, reason: 'Host is not allowed' };
  }

  if (isBlockedIPv4(hostname)) {
    return { valid: false, reason: 'Internal/private IP addresses are not allowed' };
  }

  if (isBlockedIPv6(hostname)) {
    return { valid: false, reason: 'Internal/private IPv6 addresses are not allowed' };
  }

  const allowedHosts = options.allowedHosts?.map((host) => host.toLowerCase()) ?? [];
  if (allowedHosts.length && !allowedHosts.includes(hostname)) {
    return { valid: false, reason: 'Host is not in the allowlist' };
  }

  try {
    const resolvedAddresses = await resolveHostnameAddresses(hostname);
    if (resolvedAddresses.length === 0) {
      return { valid: false, reason: 'Host did not resolve to any address' };
    }

    if (resolvedAddresses.some((address) => isBlockedIpAddress(address))) {
      return {
        valid: false,
        reason: 'Host resolves to an internal/private IP address',
      };
    }

    return {
      valid: true,
      parsed,
      pinnedAddress: resolvedAddresses[0],
    };
  } catch {
    return { valid: false, reason: 'Host could not be resolved safely' };
  }
}

export async function fetchPinnedRemoteResponse(
  parsed: URL,
  pinnedAddress: string,
  init?: Omit<RequestInit, 'body'>
): Promise<Response> {
  const dispatcher = createPinnedDispatcher(pinnedAddress);
  const fetchWithDispatcher = fetch as unknown as (
    input: string,
    init?: UndiciRequestInit
  ) => Promise<Response>;

  const requestInit: UndiciRequestInit = {
    redirect: 'manual',
    dispatcher,
  };

  if (init?.method) {
    requestInit.method = init.method;
  }
  if (init?.headers) {
    requestInit.headers = init.headers as UndiciRequestInit['headers'];
  }
  if (init?.signal) {
    requestInit.signal = init.signal;
  }
  if (init?.credentials) {
    requestInit.credentials = init.credentials;
  }
  if (init?.mode) {
    requestInit.mode = init.mode;
  }
  if (init?.referrer) {
    requestInit.referrer = init.referrer;
  }
  if (init?.referrerPolicy) {
    requestInit.referrerPolicy = init.referrerPolicy;
  }
  if (init?.integrity) {
    requestInit.integrity = init.integrity;
  }
  if (typeof init?.keepalive === 'boolean') {
    requestInit.keepalive = init.keepalive;
  }
  if (init?.window !== undefined) {
    requestInit.window = init.window;
  }

  try {
    const response = await fetchWithDispatcher(parsed.toString(), requestInit);
    // Do NOT `await dispatcher.close()` before returning. `Agent.close()` is a
    // *graceful* close that waits for in-flight requests to finish, but the
    // response body is a lazy stream the CALLER consumes only after this
    // function returns. Awaiting the close here races the body drain: it either
    // deadlocks (backpressure — the request never completes because nobody is
    // reading yet, so close() never resolves and the body is never returned) or
    // tears the pinned connection down mid-stream so the caller's later
    // `.text()`/`.arrayBuffer()` aborts with `terminated` /
    // `The operation was aborted`. Whether the abort or the hang wins depends on
    // body size and network latency, which is why it stayed hidden on localhost
    // yet fired reliably against CDN-fronted storefronts on Vercel.
    //
    // Fire the graceful close in the background instead: it lets the caller
    // finish reading the body (or cancel it), then closes the pinned socket.
    void dispatcher.close().catch(() => undefined);
    return response;
  } catch (error) {
    void dispatcher.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Safely fetch remote media with SSRF and size protections.
 */
export async function safeFetchRemoteMedia(
  url: string,
  options: SafeRemoteFetchOptions
): Promise<SafeRemoteFetchResult> {
  const validation = await validateSafeRemoteUrl(url, {
    allowedHosts: options.allowedHosts,
    allowedProtocols: options.allowedProtocols,
    blockedHostnames: options.blockedHostnames,
    blockedHostnameSuffixes: options.blockedHostnameSuffixes,
  });
  if (!validation.valid) {
    throw new Error(`Remote URL rejected: ${validation.reason}`);
  }

  const maxBytes =
    options.maxBytes ??
    (options.kind === 'image'
      ? DEFAULT_MAX_IMAGE_SIZE_BYTES
      : options.kind === 'video'
        ? DEFAULT_MAX_VIDEO_SIZE_BYTES
        : DEFAULT_MAX_PROXY_SIZE_BYTES);

  const response = await fetchPinnedRemoteResponse(
    validation.parsed,
    validation.pinnedAddress
  );

  if (isRedirectResponse(response)) {
    throw new Error('Remote URL rejected: redirects are not allowed');
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch media: ${response.status} ${response.statusText}`);
  }

  const contentType = normalizeRemoteContentType(
    response.headers.get('content-type')
  );
  if (!isSafeRemoteMediaContentType(options.kind, contentType)) {
    throw new Error(`Remote URL rejected: unsupported content type "${contentType || 'unknown'}"`);
  }

  if (isDeclaredContentLengthAboveLimit(response, maxBytes)) {
    const declaredSize = getDeclaredContentLength(response) ?? 0;
    throw new Error(
      `Remote media exceeds maximum allowed size (${Math.round(maxBytes / 1024 / 1024)}MB). Declared size: ${Math.round(declaredSize / 1024 / 1024)}MB`
    );
  }

  const buffer = await readResponseBufferWithLimit(response, maxBytes);

  return {
    buffer,
    contentType: contentType || 'application/octet-stream',
    mimeType:
      options.kind === 'video'
        ? inferVideoMimeType(validation.parsed.toString(), contentType)
        : contentType || 'application/octet-stream',
  };
}

/**
 * Backwards-compatible helper for video generation routes.
 */
export async function safeFetchVideo(url: string): Promise<{
  buffer: ArrayBuffer;
  mimeType: string;
}> {
  const result = await safeFetchRemoteMedia(url, { kind: 'video' });
  return { buffer: result.buffer, mimeType: result.mimeType };
}
