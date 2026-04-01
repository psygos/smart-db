import { UnauthenticatedError, type AuthSession } from "@smart-db/contracts";
import { PartDbClient } from "../partdb/partdb-client.js";
import { AuthTokenCache } from "./auth-token-cache.js";

export class AuthService {
  constructor(
    private readonly partDbClient: PartDbClient,
    private readonly cache = new AuthTokenCache(),
  ) {}

  async authenticateApiToken(apiToken: string): Promise<AuthSession> {
    const hash = AuthTokenCache.hashToken(apiToken);

    const cached = this.cache.get(hash);
    if (cached) {
      return cached;
    }

    try {
      const session = await this.partDbClient.authenticate(apiToken);
      this.cache.set(hash, session);
      return session;
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        this.cache.delete(hash);
        throw error;
      }

      const stale = this.cache.getStale(hash);
      if (stale) {
        return stale;
      }

      throw error;
    }
  }

  extractBearerToken(authorizationHeader: string | undefined): string {
    if (!authorizationHeader) {
      throw new UnauthenticatedError("A Part-DB API token is required.");
    }

    const [scheme, token] = authorizationHeader.split(" ");
    if (scheme !== "Bearer" || !token?.trim()) {
      throw new UnauthenticatedError("Authorization must use a Bearer token.");
    }

    return token.trim();
  }
}
