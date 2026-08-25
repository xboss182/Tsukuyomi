function parseIpv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseIpv6(address: string): bigint | null {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (!unwrapped || unwrapped.includes('%') || unwrapped.split('::').length > 2) return null;

  let normalized = unwrapped.toLowerCase();
  const dottedMatch = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMatch?.[1]) {
    const ipv4 = parseIpv4(dottedMatch[1]);
    if (!ipv4) return null;
    const high = (ipv4[0]! << 8) | ipv4[1]!;
    const low = (ipv4[2]! << 8) | ipv4[3]!;
    normalized = normalized.slice(0, normalized.length - dottedMatch[1].length) + `${high.toString(16)}:${low.toString(16)}`;
  }

  const [leftPart = '', rightPart = ''] = normalized.split('::');
  const left = leftPart ? leftPart.split(':') : [];
  const right = rightPart ? rightPart.split(':') : [];
  if (left.length + right.length > 8) return null;
  if (!normalized.includes('::') && left.length + right.length !== 8) return null;

  const parts = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;

  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

export function isIpLiteralHost(hostname: string): boolean {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  return parseIpv4(unwrapped) !== null || parseIpv6(unwrapped) !== null;
}

/** Stable representation for comparing a DNS-pinned address with the connected socket address. */
export function normalizeIpAddress(address: string): string | null {
  const ipv4 = parseIpv4(address);
  if (ipv4) return `v4:${ipv4.join('.')}`;
  const ipv6 = parseIpv6(address);
  return ipv6 === null ? null : `v6:${ipv6.toString(16).padStart(32, '0')}`;
}

interface Ipv4Range { first: number; second?: number; secondMin?: number; secondMax?: number; third?: number; }
const PRIVATE_IPV4_RANGES: Ipv4Range[] = [
  { first: 0 }, { first: 10 }, { first: 127 }, { first: 224 },
  { first: 100, secondMin: 64, secondMax: 127 },
  { first: 169, second: 254 },
  { first: 172, secondMin: 16, secondMax: 31 },
  { first: 192, second: 0, third: 0 },
  { first: 192, second: 0, third: 2 },
  { first: 192, second: 31, third: 196 },
  { first: 192, second: 52, third: 193 },
  { first: 192, second: 88, third: 99 },
  { first: 192, second: 168 },
  { first: 192, second: 175, third: 48 },
  { first: 198, second: 18 },
  { first: 198, second: 19 },
  { first: 198, second: 51, third: 100 },
  { first: 203, second: 0, third: 113 },
];

function matchesIpv4Range(a: number, b: number, c: number, range: Ipv4Range): boolean {
  if (a !== range.first) return false;
  if (range.second !== undefined && b !== range.second) return false;
  if (range.secondMin !== undefined && (b < range.secondMin || b > (range.secondMax ?? range.secondMin))) return false;
  if (range.third !== undefined && c !== range.third) return false;
  return true;
}

function isPublicIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return !PRIVATE_IPV4_RANGES.some((range) => matchesIpv4Range(a, b, c, range));
}

function isInIpv6Range(value: bigint, prefix: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return value >> shift === prefix >> shift;
}

function isPublicIpv6(value: bigint): boolean {
  // Only globally routable unicast (2000::/3) may pass. This rejects mapped,
  // compatible, NAT64, discard-only, ULA, link-local, and multicast ranges.
  if (value >> 125n !== 1n) return false;
  if (isInIpv6Range(value, 0x20010000000000000000000000000000n, 23)) return false;
  if (isInIpv6Range(value, 0x20010db8000000000000000000000000n, 32)) return false;
  if (isInIpv6Range(value, 0x20020000000000000000000000000000n, 16)) return false;
  if (isInIpv6Range(value, 0x3fff0000000000000000000000000000n, 20)) return false;
  return true;
}

/** Reject private, special, documentation, mapped, and malformed IP addresses. */
export function isPublicIpAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPublicIpv4(ipv4);

  const ipv6 = parseIpv6(address);
  return ipv6 !== null && isPublicIpv6(ipv6);
}
