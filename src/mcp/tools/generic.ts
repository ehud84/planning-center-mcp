import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PRODUCTS } from "../../pco/client";
import { READ_ONLY, type ToolContext, tool } from "../util";

export function registerGenericTools(server: McpServer, { pco }: ToolContext) {
  tool(
    server,
    "pco_get",
    {
      title: "Planning Center API (read-only)",
      description:
        "Read any Planning Center API v2 endpoint not covered by another tool, e.g. check-ins 'events', giving " +
        "'donations', registrations 'signups', publishing 'episodes', services 'songs', people 'workflows'. " +
        "Path is relative to /{product}/v2/. Supports JSON:API params like include, where[...], filter, order, " +
        "per_page, offset, fields[Type]. Results respect your own Planning Center permissions.",
      annotations: READ_ONLY,
      input: {
        product: z.enum(PRODUCTS),
        path: z
          .string()
          .min(1)
          .regex(/^[A-Za-z0-9_\-/]+$/, "Path may contain only letters, digits, '_', '-' and '/'")
          .refine((p) => !p.split("/").includes(".."), "Path may not contain '..'")
          .describe("e.g. 'songs', 'people/123/workflow_cards', 'events/45/event_times'"),
        params: z.record(z.string(), z.string()).optional().describe("Query parameters"),
      },
    },
    async ({ product, path, params }) => {
      const doc = await pco.get(product, path, params);
      return { data: doc.data, included: doc.included, meta: doc.meta };
    },
  );
}
