import { z } from 'zod';

export const LoginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(12).max(256),
});

export const MfaRequestSchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().regex(/^[0-9]{6}$/),
});

export const SessionSchema = z.object({
  username: z.string(),
  expiresAt: z.number().int(),
  /**
   * The server's mutation mode. The UI reveals the offload trigger only for
   * ACTIVE, so a SHADOW deployment cannot show a button whose route is not even
   * registered. This is a usability signal, never the security boundary: the
   * route re-checks the mode server-side.
   *
   * Defaulted rather than required so a response without it degrades to the safe
   * mode instead of failing to parse. A hard requirement would mean a client
   * talking to an older server renders nothing at all — a worse failure than
   * hiding one button, and one that would hit the whole protected shell.
   */
  mode: z.enum(['SHADOW', 'ACTIVE']).default('SHADOW'),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type MfaRequest = z.infer<typeof MfaRequestSchema>;
export type Session = z.infer<typeof SessionSchema>;
