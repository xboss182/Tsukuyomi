import { describe, expect, it } from 'bun:test';
import { isIpLiteralHost, isPublicIpAddress } from 'src/services/importer/address-policy';

describe('import address policy', () => {
  it('rejects private, special, mapped, documentation, and malformed addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '192.0.2.1',
      '203.0.113.1',
      '::1',
      '::2',
      '::192.168.1.1',
      '::ffff:0:192.168.1.1',
      'fe80::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '64:ff9b::1',
      '100::1',
      '2001:2::1',
      '2001:20::1',
      '2001:db8::1',
      '3fff::1',
      'not-an-address',
    ]) {
      expect(isPublicIpAddress(address)).toBe(false);
    }
  });

  it('accepts ordinary public addresses and identifies literal hosts', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isIpLiteralHost('8.8.8.8')).toBe(true);
    expect(isIpLiteralHost('[2606:4700:4700::1111]')).toBe(true);
    expect(isIpLiteralHost('kakuyomu.jp')).toBe(false);
  });
});
