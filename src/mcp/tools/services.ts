import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type PcoResource, asArray, mapPool, relId } from "../../pco/client";
import { getRoster } from "../../roster/routes";
import {
  READ_ONLY,
  SCHEDULE_STATUS,
  type ToolContext,
  collection,
  daysFromToday,
  id,
  includedMap,
  isoDate,
  paging,
  slim,
  tool,
} from "../util";

const PLAN_FIELDS = ["title", "dates", "short_dates", "sort_date", "series_title", "plan_people_count", "needed_positions_count"];

export function registerServicesTools(server: McpServer, { pco, env }: ToolContext) {
  tool(
    server,
    "list_service_types",
    {
      title: "List Service Types",
      description: "List Services service types (e.g. 'Sunday Gathering'). Their IDs scope list_plans and list_teams.",
      annotations: READ_ONLY,
      input: paging(100),
    },
    async ({ per_page, offset }) => {
      const doc = await pco.get("services", "service_types", { per_page, offset });
      return collection(doc, "service_types", asArray(doc.data).map((s) => slim(s, ["name", "frequency", "sequence"])), offset);
    },
  );

  tool(
    server,
    "list_plans",
    {
      title: "List Plans",
      description:
        "List plans (dated services) in a service type. Use after/before (YYYY-MM-DD) for a date range, or " +
        "time_filter for all future/past plans.",
      annotations: READ_ONLY,
      input: {
        service_type_id: id("service type"),
        time_filter: z.enum(["future", "past"]).optional(),
        after: isoDate("Only plans on or after this date").optional(),
        before: isoDate("Only plans before this date").optional(),
        order: z.enum(["sort_date", "-sort_date"]).default("sort_date"),
        ...paging(25),
      },
    },
    async ({ service_type_id, time_filter, after, before, order, per_page, offset }) => {
      const filter = after ? "after" : before ? "before" : time_filter;
      const doc = await pco.get("services", `service_types/${service_type_id}/plans`, {
        filter,
        after,
        before: filter === "before" ? before : undefined,
        order,
        per_page,
        offset,
      });
      let plans = asArray(doc.data);
      if (after && before) plans = plans.filter((p) => String(p.attributes?.sort_date ?? "") < before);
      return {
        service_type_id,
        ...collection(doc, "plans", plans.map((p) => slim(p, PLAN_FIELDS)), offset),
      };
    },
  );

  tool(
    server,
    "list_teams",
    {
      title: "List Teams",
      description: "List Services teams (e.g. Band, Tech). Pass service_type_id to scope to one service type.",
      annotations: READ_ONLY,
      input: { service_type_id: id("service type").optional(), ...paging(100) },
    },
    async ({ service_type_id, per_page, offset }) => {
      const path = service_type_id ? `service_types/${service_type_id}/teams` : "teams";
      const doc = await pco.get("services", path, { per_page, offset });
      const teams = asArray(doc.data).map((t) => slim(t, ["name", "schedule_to", "sequence", "default_status"], ["service_type"]));
      return { ...(service_type_id ? { service_type_id } : {}), ...collection(doc, "teams", teams, offset) };
    },
  );

  tool(
    server,
    "list_team_positions",
    {
      title: "List Team Positions",
      description: "List the positions within a Services team (e.g. Lead Vocal, Drums).",
      annotations: READ_ONLY,
      input: { team_id: id("team"), ...paging(100) },
    },
    async ({ team_id, per_page, offset }) => {
      const doc = await pco.get("services", `teams/${team_id}/team_positions`, { per_page, offset });
      return { team_id, ...collection(doc, "team_positions", asArray(doc.data).map((p) => slim(p, ["name", "sequence"], ["team"])), offset) };
    },
  );

  tool(
    server,
    "plan_team_members",
    {
      title: "Plan Team Members",
      description: "List the people scheduled on one plan, with team, position, and status (Confirmed/Unconfirmed/Declined).",
      annotations: READ_ONLY,
      input: { service_type_id: id("service type"), plan_id: id("plan"), ...paging(100) },
    },
    async ({ service_type_id, plan_id, per_page, offset }) => {
      const doc = await pco.get("services", `service_types/${service_type_id}/plans/${plan_id}/team_members`, {
        include: "team",
        per_page,
        offset,
      });
      const inc = includedMap(doc);
      const members = asArray(doc.data).map((m) => planPerson(m, inc));
      return { service_type_id, plan_id, ...collection(doc, "scheduled_people", members, offset) };
    },
  );

  tool(
    server,
    "whos_serving",
    {
      title: "Who's Serving",
      description:
        "Everyone scheduled across ALL service types for a date range (default: the next 7 days), grouped by " +
        "plan and team with confirmation status, plus unfilled (needed) positions.",
      annotations: READ_ONLY,
      input: {
        start_date: isoDate("First date (default today)").optional(),
        end_date: isoDate("Last date, inclusive (default start + 6 days)").optional(),
        include_declined: z.boolean().default(false),
      },
    },
    async ({ start_date, end_date, include_declined }) => {
      const start = start_date ?? daysFromToday(0);
      const end = end_date ?? new Date(Date.parse(start) + 6 * 86400_000).toISOString().slice(0, 10);
      const serviceTypes = asArray((await pco.get("services", "service_types", { per_page: 100 })).data);

      const plansByType = await mapPool(serviceTypes, 4, async (st) => {
        const doc = await pco.get("services", `service_types/${st.id}/plans`, {
          filter: "after",
          after: start,
          order: "sort_date",
          per_page: 25,
        });
        return asArray(doc.data)
          .filter((p) => String(p.attributes?.sort_date ?? "").slice(0, 10) <= end)
          .map((plan) => ({ st, plan }));
      });
      const plans = plansByType.flat().slice(0, 30);

      const results = await mapPool(plans, 4, async ({ st, plan }) => {
        const base = `service_types/${st.id}/plans/${plan.id}`;
        const [members, needed] = await Promise.all([
          pco.getAll("services", `${base}/team_members`, { include: "team" }, 500),
          pco.get("services", `${base}/needed_positions`, { include: "team", per_page: 100 }),
        ]);
        const inc = includedMap(members);
        const teams: Record<string, ReturnType<typeof planPerson>[]> = {};
        for (const m of members.data) {
          const person = planPerson(m, inc);
          if (!include_declined && person.status === "D") continue;
          (teams[person.team ?? "(No team)"] ??= []).push(person);
        }
        const neededInc = includedMap(needed);
        return {
          service_type: st.attributes?.name,
          ...slim(plan, ["title", "dates", "series_title"]),
          sort_date: String(plan.attributes?.sort_date ?? ""),
          plan_id: plan.id,
          service_type_id: st.id,
          teams,
          needed_positions: asArray(needed.data).map((n) => ({
            team: teamName(n, neededInc),
            position: n.attributes?.team_position_name,
            quantity: n.attributes?.quantity,
          })),
        };
      });

      results.sort((a, b) => a.sort_date.localeCompare(b.sort_date));
      return { start_date: start, end_date: end, plan_count: results.length, plans: results };
    },
  );

  tool(
    server,
    "serving_history",
    {
      title: "Serving History",
      description:
        "One person's Services schedule history since a date (default 90 days ago): each slot with team, " +
        "position and status, plus totals per team.",
      annotations: READ_ONLY,
      input: {
        person_id: id("person"),
        since: isoDate("Start date (default 90 days ago)").optional(),
        include_declined: z.boolean().default(false),
      },
    },
    async ({ person_id, since, include_declined }) => {
      const after = since ?? daysFromToday(-90);
      const { data } = await pco.getAll(
        "services",
        `people/${person_id}/schedules`,
        { filter: include_declined ? "after,with_declined" : "after", after, order: "starts_at" },
        1000,
      );
      const today = daysFromToday(0);
      const slots = data
        .map((s) => slim(s, ["sort_date", "dates", "service_type_name", "team_name", "team_position_name", "status", "decline_reason"], ["plan"]))
        .filter((s) => String(s.sort_date ?? "").slice(0, 10) <= today);
      const byTeam: Record<string, number> = {};
      for (const s of slots) if (s.status !== "D") byTeam[String(s.team_name)] = (byTeam[String(s.team_name)] ?? 0) + 1;
      return { person_id, since: after, total_served: Object.values(byTeam).reduce((a, b) => a + b, 0), by_team: byTeam, slots };
    },
  );

  tool(
    server,
    "serving_insights",
    {
      title: "Serving Insights",
      description:
        "Partner serving health from the roster snapshot (refreshed every 15 minutes): who is serving the most " +
        "(burnout risk), the least, and not at all over a 30/60/90-day window. Optionally limit to one team.",
      annotations: READ_ONLY,
      input: {
        window_days: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(60),
        team: z.string().min(1).optional().describe("Team name, e.g. 'Band'"),
        top: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ window_days, team, top }) => {
      const roster = await getRoster(env);
      const key = `d${window_days}` as const;
      const pool = team
        ? (roster.teams.find((t) => t.name.toLowerCase() === team.toLowerCase())?.members ?? [])
        : [...roster.people, ...roster.partners_no_team.map((p) => ({ ...p, teams: [] as string[] }))];
      if (team && !pool.length) throw new Error(`No team named "${team}" with Partner members. Teams: ${roster.teams.map((t) => t.name).join(", ")}`);
      const rows = pool.map((p) => ({
        name: p.name,
        serves: p.serves[key],
        teams: "teams" in p ? p.teams : undefined,
        lead: p.lead,
        elder: p.elder,
        deacon: p.deacon,
      }));
      const sorted = [...rows].sort((a, b) => b.serves - a.serves);
      return {
        window_days,
        team: team ?? null,
        snapshot_generated_at: new Date(roster.generated_at * 1000).toISOString(),
        partners: rows.length,
        average_serves: rows.length ? +(rows.reduce((a, r) => a + r.serves, 0) / rows.length).toFixed(2) : 0,
        most_serving: sorted.slice(0, top),
        least_serving: sorted.filter((r) => r.serves > 0).slice(-top).reverse(),
        not_serving: rows.filter((r) => r.serves === 0).map((r) => r.name),
      };
    },
  );
}

function teamName(record: PcoResource, inc: Map<string, PcoResource>) {
  const teamId = relId(record, "team");
  return teamId ? (inc.get(`Team:${teamId}`)?.attributes?.name ?? null) : null;
}

function planPerson(m: PcoResource, inc: Map<string, PcoResource>) {
  const status = m.attributes?.status as string | undefined;
  return {
    name: m.attributes?.name as string,
    person_id: relId(m, "person"),
    team: teamName(m, inc) as string | null,
    position: m.attributes?.team_position_name ?? null,
    status: status ?? null,
    status_label: status ? (SCHEDULE_STATUS[status] ?? status) : null,
    decline_reason: m.attributes?.decline_reason ?? null,
    notes: m.attributes?.notes ?? null,
  };
}
