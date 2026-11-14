import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Params, asArray } from "../../pco/client";
import { READ_ONLY, type ToolContext, collection, id, isoDate, paging, slim, tool } from "../util";

const dateRange = {
  start_date: isoDate("Only items starting on or after this date").optional(),
  end_date: isoDate("Only items starting on or before this date").optional(),
  upcoming_only: z.boolean().default(false).describe("Only future items (ignored when start_date is set)"),
};

function rangeParams({ start_date, end_date, upcoming_only }: { start_date?: string; end_date?: string; upcoming_only: boolean }): Params {
  return {
    "where[starts_at][gte]": start_date ? `${start_date}T00:00:00Z` : undefined,
    "where[starts_at][lte]": end_date ? `${end_date}T23:59:59Z` : undefined,
    filter: upcoming_only && !start_date ? "future" : undefined,
  };
}

export function registerCalendarTools(server: McpServer, { pco }: ToolContext) {
  tool(
    server,
    "list_calendar_events",
    {
      title: "List Calendar Events",
      description: "List Calendar event definitions (name, approval status, visibility). Use calendar_agenda for dated occurrences.",
      annotations: READ_ONLY,
      input: { name: z.string().min(1).optional().describe("Partial event name"), ...paging(25) },
    },
    async ({ name, per_page, offset }) => {
      const doc = await pco.get("calendar", "events", { "where[name]": name ? `%${name}%` : undefined, per_page, offset });
      const events = asArray(doc.data).map((e) =>
        slim(e, ["name", "summary", "approval_status", "featured", "visible_in_church_center", "registration_url"]),
      );
      return collection(doc, "events", events, offset);
    },
  );

  tool(
    server,
    "calendar_agenda",
    {
      title: "Calendar Agenda",
      description:
        "Dated calendar occurrences (event instances) with start/end, location and Church Center link, for a date " +
        "range or one event.",
      annotations: READ_ONLY,
      input: {
        event_id: id("calendar event").optional(),
        ...dateRange,
        order: z.enum(["starts_at", "-starts_at"]).default("starts_at"),
        ...paging(25),
      },
    },
    async ({ event_id, order, per_page, offset, ...range }) => {
      const path = event_id ? `events/${event_id}/event_instances` : "event_instances";
      const doc = await pco.get("calendar", path, { ...rangeParams(range), order, per_page, offset });
      const instances = asArray(doc.data).map((i) =>
        slim(i, ["name", "starts_at", "ends_at", "all_day_event", "location", "recurrence_description", "church_center_url"], ["event"]),
      );
      return collection(doc, "event_instances", instances, offset);
    },
  );

  tool(
    server,
    "list_calendar_resources",
    {
      title: "List Calendar Resources",
      description: "List bookable rooms and equipment (see 'kind').",
      annotations: READ_ONLY,
      input: paging(100),
    },
    async ({ per_page, offset }) => {
      const doc = await pco.get("calendar", "resources", { per_page, offset });
      const resources = asArray(doc.data).map((r) =>
        slim(r, ["name", "kind", "description", "quantity", "home_location", "path_name", "expires_at"]),
      );
      return collection(doc, "resources", resources, offset);
    },
  );

  tool(
    server,
    "list_resource_bookings",
    {
      title: "List Resource Bookings",
      description:
        "Which room or equipment is reserved, and when. Scope by at most one of event_instance_id, event_id, resource_id, plus an optional date range.",
      annotations: READ_ONLY,
      input: {
        event_id: id("calendar event").optional(),
        event_instance_id: id("event instance").optional(),
        resource_id: id("resource").optional(),
        ...dateRange,
        order: z.enum(["starts_at", "-starts_at"]).default("starts_at"),
        ...paging(25),
      },
    },
    async ({ event_id, event_instance_id, resource_id, order, per_page, offset, ...range }) => {
      const path = event_instance_id
        ? `event_instances/${event_instance_id}/resource_bookings`
        : event_id
          ? `events/${event_id}/resource_bookings`
          : resource_id
            ? `resources/${resource_id}/resource_bookings`
            : "resource_bookings";
      const doc = await pco.get("calendar", path, { ...rangeParams(range), order, per_page, offset });
      const bookings = asArray(doc.data).map((b) =>
        slim(b, ["starts_at", "ends_at", "quantity"], ["event", "event_instance", "resource"]),
      );
      return collection(doc, "resource_bookings", bookings, offset);
    },
  );

  tool(
    server,
    "list_calendar_conflicts",
    {
      title: "List Calendar Conflicts",
      description: "List resource conflicts (double bookings); resolved_at is set once resolved.",
      annotations: READ_ONLY,
      input: { status: z.enum(["resolved", "unresolved", "future"]).optional(), ...paging(25) },
    },
    async ({ status, per_page, offset }) => {
      const doc = await pco.get("calendar", "conflicts", { filter: status, per_page, offset });
      const conflicts = asArray(doc.data).map((c) => ({
        ...slim(c, ["note", "resolved_at"], ["resource", "resolved_by"]),
        winner_event_id: c.relationships?.winner?.data && !Array.isArray(c.relationships.winner.data) ? c.relationships.winner.data.id : null,
      }));
      return collection(doc, "conflicts", conflicts, offset);
    },
  );
}
