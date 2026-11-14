import { handleRoster, refreshRoster } from "./roster/routes";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ status: "ok" });
    if (pathname === "/roster" || pathname.startsWith("/roster/")) return handleRoster(request, env);
    if (pathname === "/") return Response.redirect(new URL("/roster", request.url).toString(), 302);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    await refreshRoster(env);
  },
} satisfies ExportedHandler<Env>;
