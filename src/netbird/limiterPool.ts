import { createHash } from "node:crypto";
import { RateLimiter } from "./rateLimiter.js";

/**
 * Per-tenant pool of {@link RateLimiter}s for the multi-tenant HTTP deployment.
 *
 * Callers hand it a tenant's NetBird token and get back that tenant's limiter;
 * the same token always maps to the same limiter, and distinct tokens get
 * isolated budgets so one account can't spend another's slice of NetBird's
 * per-account request budget.
 *
 * The token is never retained as a key — it's reduced to a truncated SHA-256
 * digest before it touches the map, so the raw secret never lives in the pool.
 */
export class LimiterPool {
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly maxRequestsPerMinute: number) {}

  /** Returns the rate limiter for a tenant, creating it on first use. */
  get(token: string): RateLimiter {
    const key = createHash("sha256").update(token).digest("hex").slice(0, 16);
    let limiter = this.limiters.get(key);
    if (!limiter) {
      limiter = new RateLimiter(this.maxRequestsPerMinute);
      this.limiters.set(key, limiter);
    }
    return limiter;
  }
}
