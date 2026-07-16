import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

/**
 * AES-256-GCM encryption for per-client secrets at rest (Telegram bot tokens,
 * Google OAuth token bundles, webhook secrets).
 *
 * Wire format: `iv:ciphertext:authTag` (hex). GCM is authenticated — any
 * tampering with the stored value fails decryption loudly instead of
 * returning garbage.
 */
@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const keyHex: string = config.get('ENCRYPTION_KEY', { infer: true });
    this.key = Buffer.from(keyHex, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${ciphertext.toString('hex')}:${tag.toString('hex')}`;
  }

  decrypt(stored: string): string {
    const [ivHex, ctHex, tagHex] = stored.split(':');
    if (!ivHex || !ctHex || !tagHex) {
      throw new Error('CryptoService.decrypt: malformed ciphertext');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(ctHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }
}
