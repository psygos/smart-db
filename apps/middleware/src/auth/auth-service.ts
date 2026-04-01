import { UnauthenticatedError, type AuthSession } from "@smart-db/contracts";
import { PartDbClient } from "../partdb/partdb-client.js";

export class AuthService {
  constructor(private readonly partDbClient: PartDbClient) {}

  async authenticateApiToken(apiToken: string): Promise<AuthSession> {
    return this.partDbClient.authenticate(apiToken);
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
