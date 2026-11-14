import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  OAuthError,
  type OAuthHelpers,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import { PCO_API_ROOT } from "../pco/client";

/** Props stored (encrypted) with each grant and handed to the MCP handler as ctx.props. */
export type AuthProps =
  | { kind: "pco"; accessToken: string; refreshToken: string; expiresAt: number; personId: string; name: string }
  | { kind: "pat" };

interface PcoTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

const CONSENT_REMEMBER_DAYS = 30;

export async function handleAuthorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const remember = { secret: env.CONSENT_SECRET, maxAgeSeconds: CONSENT_REMEMBER_DAYS * 86400 };
  try {
    if (request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { remember });
      return startUpstream(request, env, oauth, approved.request, approved.headers);
    }

    const authRequest = await oauth.parseAuthRequest(request);
    if (await oauth.isConsentRemembered(request, authRequest, remember)) {
      return startUpstream(request, env, oauth, authRequest);
    }
    const details = await oauth.describeConsent(authRequest);
    const consent = await oauth.beginConsent(authRequest);
    consent.headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(consentPage(details, consent.handle), { headers: consent.headers });
  } catch (error) {
    return authErrorResponse(error);
  }
}

async function startUpstream(
  request: Request,
  env: Env,
  oauth: OAuthHelpers,
  authRequest: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>>,
  headers?: Headers,
) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const upstream = await oauth.beginUpstream(authRequest, { data: { verifier }, headers });
  const url = new URL(`${PCO_API_ROOT}/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: env.PCO_OAUTH_CLIENT_ID,
    redirect_uri: new URL("/callback", request.url).toString(),
    response_type: "code",
    scope: env.PCO_OAUTH_SCOPES,
    state: upstream.state,
    code_challenge: base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
    code_challenge_method: "S256",
  }).toString();
  upstream.headers.set("Location", url.toString());
  return new Response(null, { status: 302, headers: upstream.headers });
}

export async function handleCallback(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  try {
    const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    if (params.get("error") || !code) {
      headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
      return new Response(null, { status: 302, headers });
    }

    const tokens = await pcoToken(env, {
      grant_type: "authorization_code",
      code,
      redirect_uri: new URL("/callback", request.url).toString(),
      code_verifier: data.verifier,
    });
    const claims = decodeJwtPayload(tokens.id_token);
    const orgId = String(claims.organization_id ?? "");
    if (!env.PCO_ORG_ID || orgId !== env.PCO_ORG_ID) {
      console.warn("Rejected sign-in from organization", orgId, claims.organization_name);
      return textPage(
        env.PCO_ORG_ID
          ? "This server only accepts Planning Center accounts from Bellicose Church."
          : `Server not configured: set PCO_ORG_ID (your organization is ${orgId}).`,
        403,
      );
    }

    const personId = String(claims.sub);
    const props: AuthProps = {
      kind: "pco",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      personId,
      name: String(claims.name ?? ""),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: personId,
      metadata: { name: props.name },
      scope: original.scope,
      props,
    });
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authErrorResponse(error);
  }
}

/** Refresh the user's Planning Center token whenever the MCP client refreshes its own. */
export async function tokenExchangeCallback({
  grantType,
  props,
  env,
}: {
  grantType: string;
  props: AuthProps;
  env: Env;
}) {
  if (props.kind !== "pco") return;
  if (grantType === "authorization_code") {
    return { accessTokenTTL: ttlFor(props.expiresAt) };
  }
  if (grantType !== "refresh_token") return;

  let tokens: PcoTokenResponse;
  try {
    tokens = await pcoToken(env, { grant_type: "refresh_token", refresh_token: props.refreshToken });
  } catch (error) {
    if ((error as PcoOAuthError).oauthError === "invalid_grant") {
      throw new OAuthError("invalid_grant", { description: "Planning Center access was revoked; sign in again" });
    }
    throw new OAuthError("temporarily_unavailable", { description: "Planning Center is unavailable", statusCode: 503 });
  }
  const newProps: AuthProps = {
    ...props,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  return { newProps, accessTokenTTL: ttlFor(newProps.expiresAt) };
}

// Expire our token a little before Planning Center's so clients refresh first.
const ttlFor = (expiresAt: number) => Math.max(60, Math.min(3600, Math.floor((expiresAt - Date.now()) / 1000) - 120));

class PcoOAuthError extends Error {
  constructor(readonly oauthError: string) {
    super(`Planning Center token request failed: ${oauthError}`);
  }
}

async function pcoToken(env: Env, body: Record<string, string>): Promise<PcoTokenResponse> {
  const response = await fetch(`${PCO_API_ROOT}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "planning-center-mcp/2.0" },
    body: new URLSearchParams({ ...body, client_id: env.PCO_OAUTH_CLIENT_ID, client_secret: env.PCO_OAUTH_CLIENT_SECRET }),
  });
  const json = (await response.json().catch(() => ({}))) as Partial<PcoTokenResponse> & { error?: string };
  if (!response.ok || !json.access_token) throw new PcoOAuthError(json.error ?? `http_${response.status}`);
  return json as PcoTokenResponse;
}

// The id_token comes straight from PCO's token endpoint over TLS, so its claims are trusted as-is.
function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> {
  if (!jwt) throw new Error("Planning Center did not return an id_token; ensure the 'openid' scope is enabled");
  const payload = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))));
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
    return textPage(`${message} Please start the connection again from your app.`, 400);
  }
  throw error;
}

function textPage(message: string, status: number) {
  return new Response(page("Planning Center", `<p>${escape(message)}</p>`), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function consentPage(details: ConsentDescription, handle: string) {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? "<p class=warn><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>"
    : "";
  return page(
    `Connect ${name}`,
    `<h1>Allow ${name} to use Planning Center as you?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${loopback}
<p>Next you'll sign in to Planning Center. The app can then read and update what your Planning Center account can.</p>
<form method="post"><input type="hidden" name="handle" value="${escape(handle)}">
<button name="decision" value="approve">Continue to Planning Center</button>
<button name="decision" value="deny" class="secondary">Cancel</button></form>`,
  );
}

function page(title: string, body: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>:root{color-scheme:light}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f7f9;color:#1c2430;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
main{background:#fff;border:1px solid #e6e9ee;border-radius:16px;padding:28px 24px;max-width:420px;width:100%}
h1{font-size:19px;margin:0 0 12px}p{color:#475467;font-size:14px;line-height:1.5}.warn{color:#b42318}
button{width:100%;margin-top:10px;padding:13px;font-size:15px;font-weight:600;border-radius:12px;border:0;cursor:pointer;color:#fff;background:#2563eb}
button.secondary{background:#fff;color:#344054;border:1px solid #d0d5dd}</style></head>
<body><main>${body}</main></body></html>`;
}
