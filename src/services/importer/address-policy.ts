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

function isPublicIpv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 198 && b === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIpv6(value: bigint): boolean {
  const top16 = Number(value >> 112n);
  const top32 = Number(value >> 96n);
  const top96 = value >> 32n;

  if (value === 0n || value === 1n) return false;
  if (top96 === 0xffffn) return false; // IPv4-mapped addresses are never accepted.
  if ((top16 & 0xfe00) === 0xfc00) return false; // Unique local fc00::/7.
  if ((top16 & 0xffc0) === 0xfe80) return false; // Link local fe80::/10.
  if ((top16 & 0xff00) === 0xff00) return false; // Multicast ff00::/8.
  if (top32 === 0x0064ff9b) return false; // NAT64 well-known prefix.
  if (top32 === 0x20010db8 || top32 === 0x20010000) return false; // Documentation / Teredo.
  if ((top16 & 0xffff) === 0x2002) return false; // 6to4 can encode private IPv4 addresses.
  return true;
}

/** Reject private, special, documentation, mapped, and malformed IP addresses. */
export function isPublicIpAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPublicIpv4(ipv4);

  const ipv6 = parseIpv6(address);
  return ipv6 !== null && isPublicIpv6(ipv6);
}
