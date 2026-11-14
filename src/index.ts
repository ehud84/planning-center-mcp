import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { type AuthProps, handleAuthorize, handleCallback, tokenExchangeCallback } from "./auth/pco-oauth";
import { handleMcp } from "./mcp/server";
import { handleRoster, refreshRoster } from "./roster/routes";

const app: ExportedHandler<Env> = {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
    if (pathname === "/health") return Response.json({ status: "ok" });
    if (pathname === "/authorize") return handleAuthorize(request, env, oauth);
    if (pathname === "/callback") return handleCallback(request, env, oauth);
    if (pathname === "/roster" || pathname.startsWith("/roster/")) return handleRoster(request, env);
    if (pathname === "/") return Response.redirect(new URL("/roster", request.url).toString(), 302);
    return new Response("Not found", { status: 404 });
  },
};

const mcpApi = {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return handleMcp(request, env, (ctx as ExecutionContext & { props: AuthProps }).props);
  },
};

let provider: OAuthProvider<Env> | undefined;
let providerUrl: string | undefined;

function getProvider(env: Env) {
  const publicUrl = env.PUBLIC_URL.replace(/\/+$/, "");
  if (!provider || providerUrl !== publicUrl) {
    providerUrl = publicUrl;
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApi,
      defaultHandler: app,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: { resource: `${publicUrl}/mcp`, resource_name: "Bellicose Church Planning Center" },
      tokenExchangeCallback: (options) => tokenExchangeCallback({ ...options, props: options.props as AuthProps }),
      resolveExternalToken: async ({ token, env }) =>
        env.MCP_BEARER_TOKEN && (await sameSecret(token, env.MCP_BEARER_TOKEN))
          ? { props: { kind: "pat" } satisfies AuthProps, audience: `${publicUrl}/mcp` }
          : null,
    });
  }
  return provider;
}

async function sameSecret(a: string, b: string) {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(a)), crypto.subtle.digest("SHA-256", encoder.encode(b))]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },
  async scheduled(_controller, env) {
    await refreshRoster(env);
  },
} satisfies ExportedHandler<Env>;
