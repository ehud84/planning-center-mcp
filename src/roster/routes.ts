import { PcoClient } from "../pco/client";
import { type RosterPayload, buildRosterPayload, rosterConfig } from "./build";
import loginHtml from "./login.html";
import pageHtml from "./page.html";

const COOKIE = "pco_roster_auth";
const COOKIE_TTL = 12 * 60 * 60;
const KV_KEY = "roster:v1";

export async function refreshRoster(env: Env): Promise<RosterPayload> {
  const pco = new PcoClient(env.PCO_CLIENT_ID, env.PCO_CLIENT_SECRET);
  const payload = await buildRosterPayload(pco, rosterConfig(env));
  await env.ROSTER_KV.put(KV_KEY, JSON.stringify(payload));
  return payload;
}

async function getRoster(env: Env): Promise<RosterPayload> {
  return (await env.ROSTER_KV.get<RosterPayload>(KV_KEY, "json")) ?? refreshRoster(env);
}

export async function handleRoster(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const pin = env.ROSTER_PIN?.trim();
  if (!pin) {
    return html(messagePage("Roster not enabled", "Set the ROSTER_PIN secret on the server to enable this page."), 503);
  }

  if (pathname === "/roster/logout") {
    return redirect("/roster", `${COOKIE}=; Max-Age=0; Path=/roster; HttpOnly; Secure; SameSite=Lax`);
  }

  if (pathname === "/roster/login" && request.method === "POST") {
    const submitted = String((await request.formData()).get("pin") ?? "").trim();
    if (submitted && (await timingSafeEqual(submitted, pin))) {
      const cookie = await makeCookie(env);
      return redirect("/roster", `${COOKIE}=${cookie}; Max-Age=${COOKIE_TTL}; Path=/roster; HttpOnly; Secure; SameSite=Lax`);
    }
    return html(loginPage(true), 401);
  }

  if (pathname !== "/roster" || request.method !== "GET") return new Response("Not found", { status: 404 });
  if (!(await validCookie(env, readCookie(request, COOKIE)))) return html(loginPage(false));

  try {
    const payload = await getRoster(env);
    return html(pageHtml.replace("__DATA__", () => JSON.stringify(payload).replace(/<\//g, "<\\/")));
  } catch (error) {
    console.error("Failed to build roster page", error);
    return html(messagePage("Couldn't load the roster", String((error as Error).message ?? error)), 502);
  }
}

function loginPage(error: boolean) {
  return loginHtml.replace("__ERROR__", error ? "Incorrect PIN. Try again." : "");
}

function messagePage(title: string, message: string) {
  const esc = (s: string) => s.replace(/</g, "&lt;");
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Team Roster</title><style>:root{color-scheme:light}" +
    "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;" +
    "background:#f6f7f9;color:#1c2430;display:flex;min-height:100vh;align-items:center;" +
    "justify-content:center;margin:0;padding:24px}.b{max-width:380px;text-align:center}" +
    "h1{font-size:18px}p{color:#667085;font-size:14px;line-height:1.5}</style></head>" +
    `<body><div class="b"><h1>${esc(title)}</h1><p>${esc(message)}</p></div></body></html>`
  );
}

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const redirect = (location: string, cookie: string) =>
  new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": cookie } });

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Without an explicit secret, derive one from server-only values so cookies survive deploys.
const cookieSecret = (env: Env) => env.ROSTER_COOKIE_SECRET?.trim() || `roster|${env.ROSTER_PIN}|${env.PCO_CLIENT_SECRET}`;

export async function makeCookie(env: Env, now = Date.now()): Promise<string> {
  const expires = String(Math.floor(now / 1000) + COOKIE_TTL);
  return `${expires}.${await hmacHex(cookieSecret(env), expires)}`;
}

export async function validCookie(env: Env, value: string | null, now = Date.now()): Promise<boolean> {
  if (!value?.includes(".")) return false;
  const index = value.lastIndexOf(".");
  const expires = value.slice(0, index);
  const signature = value.slice(index + 1);
  if (!(await timingSafeEqual(signature, await hmacHex(cookieSecret(env), expires)))) return false;
  return Number(expires) > Math.floor(now / 1000);
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
