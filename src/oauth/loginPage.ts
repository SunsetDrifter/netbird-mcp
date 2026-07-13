import { DEFAULT_NETBIRD_API_URL } from "../config.js";

export interface LoginPageParams {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scope: string;
  resource: string;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal, dependency-free consent/login page for binding a NetBird PAT. */
export function renderLoginPage(p: LoginPageParams, error?: string): string {
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${esc(value)}" />`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect NetBird to Claude</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0;
    display: grid; place-items: center; min-height: 100vh; background: #f4f5f7; }
  @media (prefers-color-scheme: dark) { body { background: #14161a; color: #e6e6e6; } }
  .card { width: min(440px, 92vw); background: canvas; padding: 28px 26px; border-radius: 14px;
    box-shadow: 0 6px 30px rgba(0,0,0,.12); }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #6b7280; font-size: .9rem; }
  label { display: block; font-weight: 600; font-size: .85rem; margin: 14px 0 6px; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px;
    border: 1px solid #cbd0d8; border-radius: 8px; font-size: .95rem; background: field; color: fieldtext; }
  button { margin-top: 22px; width: 100%; padding: 11px; border: 0; border-radius: 8px;
    background: #f26522; color: #fff; font-size: .98rem; font-weight: 600; cursor: pointer; }
  .err { background: #fdecec; color: #b3261e; padding: 10px 12px; border-radius: 8px;
    font-size: .85rem; margin-bottom: 14px; }
  .hint { font-size: .78rem; color: #6b7280; margin-top: 6px; }
  a { color: #f26522; }
</style>
</head>
<body>
  <form class="card" method="post" action="/oauth/netbird-login">
    <h1>Connect NetBird</h1>
    <p class="sub">Authorize Claude to manage your NetBird network.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ""}

    <label for="netbird_token">NetBird Personal Access Token</label>
    <input id="netbird_token" name="netbird_token" type="password" autocomplete="off"
      placeholder="nb_pat_…" required />
    <div class="hint">Create a service user in the NetBird dashboard and issue a PAT for it.</div>

    <label for="netbird_api_url">NetBird API URL</label>
    <input id="netbird_api_url" name="netbird_api_url" type="text"
      value="${esc(DEFAULT_NETBIRD_API_URL)}" />
    <div class="hint">Change only if you self-host NetBird.</div>

    ${hidden("client_id", p.clientId)}
    ${hidden("redirect_uri", p.redirectUri)}
    ${hidden("state", p.state)}
    ${hidden("code_challenge", p.codeChallenge)}
    ${hidden("scope", p.scope)}
    ${hidden("resource", p.resource)}

    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}
