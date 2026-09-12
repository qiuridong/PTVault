import {
  LoginRequestSchema,
  MfaRequestSchema,
  SessionSchema,
  type LoginRequest,
  type MfaRequest,
  type Session,
} from '@ptvault/contracts';
import { z } from 'zod';

import { ApiError, apiGet, apiMutation, apiMutationVoid } from '../../api/client.js';
import {
  clearDemoSession,
  finishDemoLogin,
  hasDemoSessionRecord,
  startDemoLogin,
} from '../../demo/demoSession.js';

export const LoginChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  expiresAt: z.number().int(),
});

export type LoginChallenge = z.infer<typeof LoginChallengeSchema>;

export const sessionQueryKey = ['auth', 'session'] as const;

export async function startLogin(input: LoginRequest): Promise<LoginChallenge> {
  const demo = startDemoLogin(input.username, input.password);
  if (demo.handled) {
    if (!demo.accepted) throw new ApiError(401, 'Invalid credentials');
    return LoginChallengeSchema.parse(demo.challenge);
  }
  return apiMutation('/api/auth/login', LoginRequestSchema.parse(input), LoginChallengeSchema);
}

export async function finishLogin(input: MfaRequest): Promise<Session> {
  const demo = finishDemoLogin(input.challengeId, input.code);
  if (demo.handled) {
    if (!demo.accepted) throw new ApiError(401, 'Invalid credentials');
    return SessionSchema.parse(demo.session);
  }
  return apiMutation('/api/auth/mfa', MfaRequestSchema.parse(input), SessionSchema);
}

export async function getSession(): Promise<Session> {
  return apiGet('/api/auth/session', SessionSchema);
}

export async function logout(): Promise<void> {
  if (hasDemoSessionRecord()) {
    clearDemoSession();
    return;
  }
  await apiMutationVoid('/api/auth/logout');
}
