// IP address classification for outbound-request guards.
//
// Pure TypeScript (no Node built-ins) so the manifest validator, the portal and
// the frozen publication runner share one implementation. IPv6 forms that carry
// an IPv4 address (IPv4-mapped/-compatible, NAT64 and 6to4) are classified by
// the embedded IPv4 address, so `::ffff:a9fe:a9fe` is link-local exactly like
// `169.254.169.254`.

export type IpAddressClass =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link_local'
  | 'shared'
  | 'unspecified'
  | 'multicast'
  | 'reserved'
  | 'invalid';

/** Strip URL brackets and an IPv6 zone index (`fe80::1%eth0`). */
function bareAddress(value: string): string {
  let address = value.trim();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1 && address.includes(':')) address = address.slice(0, zone);
  return address.toLowerCase();
}

/** Strict dotted-decimal IPv4 (the canonical form URL parsers and DNS return). */
export function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    bytes.push(byte);
  }
  return bytes;
}

/** Parse an IPv6 address into 16 bytes, including a trailing dotted quad. */
export function parseIpv6(value: string): number[] | null {
  let text = value;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const ipv4 = parseIpv4(text.slice(lastColon + 1));
    if (!ipv4) return null;
    tail = ipv4;
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !rest) return null;
  let words: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    words = [...head, ...new Array<number>(missing).fill(0), ...rest];
  } else {
    if (head.length !== 8) return null;
    words = head;
  }
  const bytes = words.flatMap((word) => [word >> 8, word & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** True when `value` (optionally bracketed) is an IPv4 or IPv6 literal. */
export function isIpAddressLiteral(value: string): boolean {
  const address = bareAddress(value);
  return Boolean(address.includes(':') ? parseIpv6(address) : parseIpv4(address));
}

function classifyIpv4(bytes: number[]): IpAddressClass {
  const [a, b, c] = bytes as [number, number, number, number];
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 0 && c === 0) return 'reserved';
  if (a === 192 && b === 168) return 'private';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

function startsWith(bytes: number[], prefix: number[]): boolean {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function classifyIpv6(bytes: number[]): IpAddressClass {
  const zeroUntil = (end: number) => bytes.slice(0, end).every((byte) => byte === 0);
  // ::/128 and ::1/128.
  if (zeroUntil(15) && bytes[15] === 0) return 'unspecified';
  if (zeroUntil(15) && bytes[15] === 1) return 'loopback';
  // IPv4-mapped ::ffff:0:0/96 and SIIT ::ffff:0:0:0/96.
  if (zeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff) return classifyIpv4(bytes.slice(12));
  if (zeroUntil(8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) {
    return classifyIpv4(bytes.slice(12));
  }
  // Deprecated IPv4-compatible ::a.b.c.d.
  if (zeroUntil(12)) return classifyIpv4(bytes.slice(12));
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48.
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b]) && bytes.slice(4, 12).every((byte) => byte === 0)) {
    return classifyIpv4(bytes.slice(12));
  }
  if (startsWith(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return classifyIpv4(bytes.slice(12));
  // 6to4 2002::/16 embeds the IPv4 address in bits 16-47.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return classifyIpv4(bytes.slice(2, 6));
  // Teredo 2001::/32 hides an IPv4 address; never treat it as a plain public host.
  if (startsWith(bytes, [0x20, 0x01, 0x00, 0x00])) return 'reserved';
  // Discard-only 100::/64.
  if (startsWith(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0])) return 'reserved';
  if ((bytes[0]! & 0xfe) === 0xfc) return 'private';
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return 'link_local';
  // Deprecated site-local fec0::/10.
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return 'private';
  if (bytes[0] === 0xff) return 'multicast';
  // Only global unicast 2000::/3 is publicly routable.
  if ((bytes[0]! & 0xe0) !== 0x20) return 'reserved';
  return 'public';
}

/** Classify an IP literal; anything that is not a valid literal is `invalid`. */
export function classifyIpAddress(value: string): IpAddressClass {
  const address = bareAddress(value);
  if (address.includes(':')) {
    const bytes = parseIpv6(address);
    return bytes ? classifyIpv6(bytes) : 'invalid';
  }
  const bytes = parseIpv4(address);
  return bytes ? classifyIpv4(bytes) : 'invalid';
}

/** True only for a valid, publicly routable unicast address. */
export function isPublicIpAddress(value: string): boolean {
  return classifyIpAddress(value) === 'public';
}

/** Host names that always denote the local machine or a local network. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
    host.endsWith('.internal') || host === 'localhost.localdomain';
}

/** Static check of a URL host: names must not be local, literals must be public. */
export function isPublicUrlHost(hostname: string): boolean {
  if (!hostname) return false;
  if (isIpAddressLiteral(hostname)) return isPublicIpAddress(hostname);
  return !isLocalHostname(hostname);
}
