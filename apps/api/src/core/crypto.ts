import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function digestToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error('SecretBox key must be 32 bytes');
    }
  }

  seal(plainText: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);

    return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url');
  }

  open(payload: string): string {
    const packed = Buffer.from(payload, 'base64url');
    if (packed.length < 28) {
      throw new Error('Invalid encrypted payload');
    }

    const nonce = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const body = packed.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  }
}
