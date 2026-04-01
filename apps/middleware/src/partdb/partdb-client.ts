import type {
  AuthSession,
  PartDbConnectionStatus,
  PartDbDiscoveredResources,
  PartDbLookupSummary,
  UnauthenticatedError,
} from "@smart-db/contracts";
import { IntegrationError, UnauthenticatedError as UnauthenticatedApplicationError } from "@smart-db/contracts";
import { withRetry, type RetryOptions, defaultRetryOptions } from "./retry.js";

interface PartDbConfig {
  baseUrl: string | null;
  publicBaseUrl?: string | null;
  apiToken?: string | null;
  retry?: RetryOptions;
}

interface OpenApiDocument {
  paths?: Record<string, unknown>;
}

interface TokenInfo {
  tokenLabel: string | null;
  username: string;
  expiresAt: string | null;
}

const authRetryOptions: RetryOptions = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
};

export class PartDbClient {
  constructor(private readonly config: PartDbConfig) {}

  async authenticate(apiToken: string): Promise<AuthSession> {
    const tokenInfo = await this.getTokenInfo(apiToken, authRetryOptions);
    return {
      subject: null,
      username: tokenInfo.username,
      name: null,
      email: null,
      roles: [],
      issuedAt: new Date().toISOString(),
      expiresAt: tokenInfo.expiresAt,
    };
  }

  async getConnectionStatus(apiToken: string | null = null): Promise<PartDbConnectionStatus> {
    const activeToken = this.activeToken(apiToken);
    const usingServiceToken = !apiToken && Boolean(this.config.apiToken);
    if (!this.config.baseUrl || !activeToken) {
      return {
        configured: false,
        connected: false,
        baseUrl: this.publicBaseUrl(),
        tokenLabel: null,
        userLabel: null,
        message: "Part-DB credentials are not configured.",
        discoveredResources: emptyResources(),
      };
    }

    const normalizedBaseUrl = this.normalizedBaseUrl();
    const tokenHeaders = this.headers(activeToken);
    const docsHeaders = this.headers(activeToken, "application/vnd.openapi+json");

    const retryOptions = this.config.retry ?? defaultRetryOptions;

    try {
      const [tokenResponse, docsResponse] = await withRetry(
        () =>
          Promise.all([
            fetch(`${normalizedBaseUrl}/api/tokens/current`, { headers: tokenHeaders }),
            fetch(`${normalizedBaseUrl}/api/docs.json`, { headers: docsHeaders }),
          ]),
        retryOptions,
      );

      let tokenLabel: string | null = null;
      let userLabel: string | null = null;
      if (tokenResponse.ok) {
        const payload = (await tokenResponse.json()) as Record<string, unknown>;
        tokenLabel = extractTokenLabel(payload);
        userLabel = extractUsername(payload);
      }

      let discoveredResources = emptyResources();
      if (docsResponse.ok) {
        const openApi = (await docsResponse.json()) as OpenApiDocument;
        discoveredResources = discoverResources(openApi);
      }

      if (!tokenResponse.ok) {
        if (usingServiceToken) {
          return {
            configured: true,
            connected: false,
            baseUrl: this.publicBaseUrl(),
            tokenLabel: null,
            userLabel: null,
            message: `Part-DB service token was rejected (${tokenResponse.status}).`,
            discoveredResources,
          };
        }
        throw new UnauthenticatedApplicationError(
          `Part-DB rejected the token (${tokenResponse.status}).`,
        );
      }

      return {
        configured: true,
        connected: true,
        baseUrl: this.publicBaseUrl(),
        tokenLabel,
        userLabel,
        message: "Part-DB connection looks healthy.",
        discoveredResources,
      };
    } catch (error) {
      if (error instanceof UnauthenticatedApplicationError) {
        throw error;
      }
      return {
        configured: true,
        connected: false,
        baseUrl: this.publicBaseUrl(),
        tokenLabel: null,
        userLabel: null,
        message:
          error instanceof Error
            ? `Failed to reach Part-DB: ${error.message}`
            : "Failed to reach Part-DB.",
        discoveredResources: emptyResources(),
      };
    }
  }

  async getLookupSummary(apiToken: string | null = null): Promise<PartDbLookupSummary> {
    const status = await this.getConnectionStatus(apiToken);
    return {
      configured: status.configured,
      connected: status.connected,
      message: status.message,
    };
  }

  private async getTokenInfo(apiToken: string, retryOverride?: RetryOptions): Promise<TokenInfo> {
    if (!this.config.baseUrl) {
      throw new IntegrationError("Part-DB", "base URL is not configured.");
    }

    const retryOptions = retryOverride ?? this.config.retry ?? defaultRetryOptions;
    const response = await withRetry(
      () =>
        fetch(`${this.normalizedBaseUrl()}/api/tokens/current`, {
          headers: this.headers(apiToken),
        }),
      retryOptions,
    ).catch((error) => {
      throw new IntegrationError(
        "Part-DB",
        error instanceof Error ? error.message : "Failed to reach Part-DB.",
      );
    });

    if (!response.ok) {
      throw new UnauthenticatedApplicationError(
        `Part-DB rejected the token (${response.status}).`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const username = extractUsername(payload);
    if (!username) {
      throw new IntegrationError("Part-DB", "token owner could not be determined.");
    }

    return {
      tokenLabel: extractTokenLabel(payload),
      username,
      expiresAt: extractTokenExpiry(payload),
    };
  }

  private normalizedBaseUrl(): string {
    if (!this.config.baseUrl) {
      throw new IntegrationError("Part-DB", "base URL is not configured.");
    }

    return this.config.baseUrl.replace(/\/$/, "");
  }

  private publicBaseUrl(): string | null {
    const candidate = this.config.publicBaseUrl ?? this.config.baseUrl;
    return candidate ? candidate.replace(/\/$/, "") : null;
  }

  private activeToken(apiToken: string | null | undefined): string | null {
    return apiToken ?? this.config.apiToken ?? null;
  }

  private headers(apiToken: string, accept: string = "application/json"): Record<string, string> {
    return {
      Accept: accept,
      Authorization: `Bearer ${apiToken}`,
    };
  }
}

function emptyResources(): PartDbDiscoveredResources {
  return {
    tokenInfoPath: "/api/tokens/current",
    openApiPath: "/api/docs.json",
    partsPath: null,
    partLotsPath: null,
    storageLocationsPath: null,
  };
}

function discoverResources(document: OpenApiDocument): PartDbDiscoveredResources {
  const resources = emptyResources();
  const paths = Object.keys(document.paths ?? {});

  resources.partsPath = selectCollectionPath(paths, "/api/parts");
  resources.partLotsPath = selectCollectionPath(paths, "/api/part_lots");
  resources.storageLocationsPath = selectCollectionPath(paths, "/api/storage_locations");

  return resources;
}

function selectCollectionPath(paths: string[], collectionPath: string): string | null {
  const exact = paths.find((path) => path === collectionPath);
  if (exact) {
    return exact;
  }

  const matching = paths
    .filter((path) => path.startsWith(`${collectionPath}/`))
    .sort((left, right) => {
      const segmentDelta = left.split("/").length - right.split("/").length;
      return segmentDelta !== 0 ? segmentDelta : left.length - right.length;
    });

  return matching[0] ?? null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractTokenLabel(payload: Record<string, unknown>): string | null {
  return stringOrNull(payload.name) ?? stringOrNull(payload.tokenName);
}

function extractUsername(payload: Record<string, unknown>): string | null {
  const owner =
    (payload.owner as Record<string, unknown> | undefined) ??
    (payload.user as Record<string, unknown> | undefined);

  return owner
    ? stringOrNull(owner.username) ?? stringOrNull(owner.name)
    : null;
}

function extractTokenExpiry(payload: Record<string, unknown>): string | null {
  return (
    stringOrNull(payload.expiresAt) ??
    stringOrNull(payload.expires_at) ??
    stringOrNull(payload.expirationDate) ??
    stringOrNull(payload.expiration_date) ??
    stringOrNull(payload.validUntil)
  );
}
