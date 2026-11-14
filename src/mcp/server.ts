import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { AuthProps } from "../auth/pco-oauth";
import { PcoClient } from "../pco/client";
import { patClient } from "../roster/routes";
import { registerCalendarTools } from "./tools/calendar";
import { registerGenericTools } from "./tools/generic";
import { registerGroupTools } from "./tools/groups";
import { registerPeopleTools } from "./tools/people";
import { registerServicesTools } from "./tools/services";
import type { ToolContext } from "./util";

const INSTRUCTIONS =
  "Tools for Bellicose Church's Planning Center: People, Groups, Services (plans, teams, scheduling, serving " +
  "health) and Calendar. Prefer the purpose-built tools (whos_serving, get_person, serving_insights, " +
  "calendar_agenda); use pco_get for anything else in the Planning Center API. Calls run with the signed-in " +
  "user's Planning Center permissions.";

export function createServer(ctx: ToolContext) {
  const server = new McpServer({ name: "planning_center_mcp", version: "2.0.0" }, { instructions: INSTRUCTIONS });
  registerPeopleTools(server, ctx);
  registerGroupTools(server, ctx);
  registerServicesTools(server, ctx);
  registerCalendarTools(server, ctx);
  registerGenericTools(server, ctx);
  return server;
}

export function handleMcp(request: Request, env: Env, props: AuthProps) {
  const pco = props.kind === "pco" ? new PcoClient({ kind: "bearer", token: props.accessToken }) : patClient(env);
  return createMcpHandler(() => createServer({ pco, env }), { legacy: "stateless" }).fetch(request);
}
