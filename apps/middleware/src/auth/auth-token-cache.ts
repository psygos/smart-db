import { createHash } from "node:crypto";
import type { AuthSession } from "@smart-db/contracts";

interface CacheEntry {
  session: AuthSession;
  validatedAt: number;
}

export class AuthTokenCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs: number = 5 * 60 * 1000) {}

  static hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  get(hash: string): AuthSession | null {
    const entry = this.entries.get(hash);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.validatedAt > this.ttlMs) {
      this.entries.delete(hash);
      return null;
    }

    return entry.session;
  }

  set(hash: string, session: AuthSession): void {
    this.entries.set(hash, { session, validatedAt: Date.now() });
  }

  delete(hash: string): void {
    this.entries.delete(hash);
  }
}
