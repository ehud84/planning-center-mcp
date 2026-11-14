import appleTouchIcon from "./assets/apple-touch-icon.png";
import favicon from "./assets/favicon.svg";
import { handleRoster, refreshRoster } from "./roster/routes";

const ICON_HEADERS = { "Cache-Control": "public, max-age=604800" };

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") return Response.json({ status: "ok" });
    if (pathname === "/favicon.svg") return new Response(favicon, { headers: { ...ICON_HEADERS, "Content-Type": "image/svg+xml" } });
    if (pathname === "/apple-touch-icon.png" || pathname === "/favicon.ico") {
      return new Response(appleTouchIcon, { headers: { ...ICON_HEADERS, "Content-Type": "image/png" } });
    }
    if (pathname === "/roster" || pathname.startsWith("/roster/")) return handleRoster(request, env);
    if (pathname === "/") return Response.redirect(new URL("/roster", request.url).toString(), 302);
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller, env) {
    await refreshRoster(env);
  },
} satisfies ExportedHandler<Env>;
