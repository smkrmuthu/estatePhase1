// In-memory sliding window rate limiter for Cloudflare Worker instances.
// Slows down password guessing on the sign-in endpoint (per Worker instance).

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, RateLimitEntry>();

function cleanupStore(now: number) {
  if (memoryStore.size > 5_000) {
    for (const [key, entry] of memoryStore.entries()) {
      if (entry.resetAt <= now) {
        memoryStore.delete(key);
      }
    }
  }
}

export interface RateLimitOptions {
  windowSeconds: number;
  maxRequests: number;
  keyPrefix: string;
}

export function checkRateLimit(
  identifier: string,
  options: RateLimitOptions
): { allowed: boolean; remaining: number; resetInSeconds: number } {
  const now = Date.now();
  cleanupStore(now);

  const fullKey = `${options.keyPrefix}:${identifier}`;
  const entry = memoryStore.get(fullKey);

  if (!entry || entry.resetAt <= now) {
    memoryStore.set(fullKey, {
      count: 1,
      resetAt: now + options.windowSeconds * 1000
    });
    return {
      allowed: true,
      remaining: options.maxRequests - 1,
      resetInSeconds: options.windowSeconds
    };
  }

  if (entry.count >= options.maxRequests) {
    const resetInSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      resetInSeconds
    };
  }

  entry.count += 1;
  const resetInSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return {
    allowed: true,
    remaining: options.maxRequests - entry.count,
    resetInSeconds
  };
}

export function getClientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-real-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    '127.0.0.1'
  );
}
