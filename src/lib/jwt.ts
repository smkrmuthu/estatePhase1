import { sign, verify } from 'hono/jwt';

const ACCESS_TTL_SECONDS = 60 * 60 * 12; // 12h — a working day at the godown

export interface TokenPayload {
  orgId: string;
  userId: string;
  exp: number;
}

export async function signAccessToken(orgId: string, userId: string, secret: string): Promise<string> {
  const payload: TokenPayload = { orgId, userId, exp: Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS };
  return sign(payload as unknown as Record<string, unknown>, secret);
}

export async function verifyAccessToken(token: string, secret: string): Promise<{ orgId: string; userId: string }> {
  const payload = (await verify(token, secret, 'HS256')) as unknown as TokenPayload;
  return { orgId: payload.orgId, userId: payload.userId };
}
