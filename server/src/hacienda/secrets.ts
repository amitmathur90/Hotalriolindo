import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Hacienda credentials (ATV password, .p12 key and its PIN) are stored encrypted with a key derived from JWT_SECRET.
const key = () => createHash('sha256').update(`hacienda-secrets:${process.env.JWT_SECRET || 'dev-only-change-me'}`).digest();

export function encrypt(plain: string | Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decryptBuf(enc: string): Buffer {
  const b = Buffer.from(enc, 'base64');
  const d = createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  try {
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  } catch {
    throw new Error('No se pudo descifrar la credencial de Hacienda (¿cambió JWT_SECRET?). Vuelva a cargarla en Configuración.');
  }
}
export const decrypt = (enc: string) => decryptBuf(enc).toString('utf8');
