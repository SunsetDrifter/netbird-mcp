/**
 * AuthContext is the single seam that lets one server run locally and in the cloud.
 * Local resolves it once from env; the cloud entrypoint resolves it per request
 * from an inbound header. In v2 the request resolver can be swapped for an OAuth2
 * exchange without touching any tool code.
 */
export interface AuthContext {
  /** NetBird Personal Access Token — sent as `Authorization: Token <token>`. */
  token: string;
  /** Fully-qualified NetBird API base URL, no trailing slash. */
  baseUrl: string;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}
