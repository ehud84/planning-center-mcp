import type { CallToolResult, McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { PcoClient, PcoDocument, PcoResource } from "../pco/client";
import { asArray, relId } from "../pco/client";

export interface ToolContext {
  pco: PcoClient;
  env: Env;
}

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const id = (what: string) => z.string().min(1).describe(`Planning Center ${what} ID`);
export const isoDate = (description: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .describe(description);
export const paging = (defaultPerPage = 25) => ({
  per_page: z.number().int().min(1).max(100).default(defaultPerPage).describe("Results per page (1-100)"),
  offset: z.number().int().min(0).default(0).describe("Pagination offset; pass next_offset from a previous call"),
});

export function tool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; annotations: ToolAnnotations; input: S },
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
) {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      annotations: config.annotations,
      inputSchema: z.object(config.input),
    },
    async (args: unknown): Promise<CallToolResult> => {
      try {
        const result = (await handler(args as z.infer<z.ZodObject<S>>)) as Record<string, unknown>;
        return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: (error as Error).message ?? String(error) }] };
      }
    },
  );
}

/** Pick named attributes plus `<rel>_id` for each named to-one relationship. */
export function slim(record: PcoResource | undefined, attrs: string[], rels: string[] = []): Record<string, unknown> {
  if (!record) return {};
  const out: Record<string, unknown> = { id: record.id };
  for (const key of attrs) out[key] = record.attributes?.[key] ?? null;
  for (const rel of rels) out[`${rel}_id`] = relId(record, rel);
  return out;
}

export function collection(doc: PcoDocument, key: string, items: unknown[], offset = 0) {
  const total = doc.meta?.total_count ?? items.length;
  const nextOffset = offset + asArray(doc.data).length;
  return { [key]: items, count: items.length, total, next_offset: nextOffset < total ? nextOffset : null };
}

export function includedMap(doc: { included?: PcoResource[] }) {
  return new Map((doc.included ?? []).map((r) => [`${r.type}:${r.id}`, r]));
}

export function daysFromToday(days: number) {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

export const SCHEDULE_STATUS: Record<string, string> = { C: "Confirmed", U: "Unconfirmed", D: "Declined" };
