import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

function makeService(keyHex: string): CryptoService {
  const config = { get: () => keyHex } as unknown as ConfigService<never, true>;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  const key = 'a'.repeat(64);

  it('round-trips plaintext', () => {
    const svc = makeService(key);
    const secret = 'bot123456:ABC-secret_token';
    expect(svc.decrypt(svc.encrypt(secret))).toBe(secret);
  });

  it('produces a different ciphertext per call (random IV)', () => {
    const svc = makeService(key);
    expect(svc.encrypt('x')).not.toBe(svc.encrypt('x'));
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const svc = makeService(key);
    const stored = svc.encrypt('secret');
    const [iv, ct, tag] = stored.split(':') as [string, string, string];
    const flipped = ct.startsWith('0') ? `1${ct.slice(1)}` : `0${ct.slice(1)}`;
    expect(() => svc.decrypt(`${iv}:${flipped}:${tag}`)).toThrow();
  });

  it('rejects ciphertext encrypted with a different key', () => {
    const a = makeService(key);
    const b = makeService('b'.repeat(64));
    expect(() => b.decrypt(a.encrypt('secret'))).toThrow();
  });

  it('rejects malformed stored values', () => {
    const svc = makeService(key);
    expect(() => svc.decrypt('not-a-ciphertext')).toThrow('malformed');
  });
});
