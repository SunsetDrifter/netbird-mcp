import { normalizeBaseUrl } from "../config.js";
import { AuthContext, AuthError } from "./context.js";

/**
 * Local (stdio) auth: a single tenant configured via environment variables.
 * Fails fast with an actionable message if the token is missing.
 */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env): AuthContext {
  const token = env.NETBIRD_API_TOKEN?.trim();
  if (!token) {
    throw new AuthError(
      "NETBIRD_API_TOKEN is not set. Create a service user in the NetBird dashboard, " +
        "issue a Personal Access Token for it, and set NETBIRD_API_TOKEN.",
    );
  }
  return { token, baseUrl: normalizeBaseUrl(env.NETBIRD_API_URL) };
}
