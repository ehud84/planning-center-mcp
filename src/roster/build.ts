import { type PcoClient, type PcoResource, asArray, mapPool, relId, relIds } from "../pco/client";

export const ROSTER_WINDOWS = [30, 60, 90] as const;
export type Serves = Record<`d${(typeof ROSTER_WINDOWS)[number]}`, number>;

interface RosterMember {
  id: string;
  name: string;
  last: string;
  url: string | null;
  serves: Serves;
  lead: boolean;
  elder: boolean;
  deacon: boolean;
}

/** One scheduled serving slot: plan date, service type, team, position, status (C/U). */
export interface Slot {
  date: string;
  service: string;
  team: string | null;
  position: string | null;
  status: string | null;
}

export interface RosterPayload {
  people: (RosterMember & { teams: string[] })[];
  teams: { name: string; instances: number; members: RosterMember[] }[];
  partners_no_team: RosterMember[];
  /** Per Partner: non-declined slots in the last 90 days and the next UPCOMING_DAYS, newest/soonest first. */
  schedules: Record<string, { past: Slot[]; upcoming: Slot[] }>;
  windows: number[];
  lead_group: string;
  generated_at: number;
}

export interface RosterConfig {
  leadGroup: string;
  eldersList: string;
  deaconsList: string;
  excludedTeams: Set<string>;
}

// Used until PCO Lists with the configured names exist and are visible to the API token's user.
const FALLBACK_ELDER_IDS = ["89892975", "87899362", "88547242", "87899240", "88546412"];
const FALLBACK_DEACON_IDS = [
  "88547391", "102716821", "88837041", "88462936", "88546769", "88837038", "88843218",
  "88547337", "88547032", "99160400", "88545253", "88462759", "118245006",
];

const UPCOMING_DAYS = 28;

const emptyServes = (): Serves => ({ d30: 0, d60: 0, d90: 0 });

// Python's str.lower() ordering (code points), so sort order matches the original server.
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byLastThenName = (a: { last: string; name: string }, b: { last: string; name: string }) =>
  cmp((a.last || a.name).toLowerCase(), (b.last || b.name).toLowerCase()) ||
  cmp(a.name.toLowerCase(), b.name.toLowerCase());

export async function buildRosterPayload(pco: PcoClient, config: RosterConfig, now = Date.now()): Promise<RosterPayload> {
  const [teamsResult, serving, partners, leadIds, elderIds, deaconIds] = await Promise.all([
    pco.getAll("services", "teams", { include: "people" }),
    fetchServing(pco, now),
    fetchPartners(pco),
    fetchGroupMemberIds(pco, config.leadGroup),
    fetchListPersonIds(pco, config.eldersList, FALLBACK_ELDER_IDS),
    fetchListPersonIds(pco, config.deaconsList, FALLBACK_DEACON_IDS),
  ]);
  const partnerIds = new Set(partners.map((p) => p.id));
  const serves = (id: string) => serving.counts.get(id) ?? emptyServes();
  const flags = (id: string) => ({ lead: leadIds.has(id), elder: elderIds.has(id), deacon: deaconIds.has(id) });

  const people = new Map<string, { id: string; name: string; last: string; url: string | null; teams: Set<string> }>();
  for (const record of teamsResult.included) {
    if (record.type !== "Person") continue;
    const attrs = record.attributes ?? {};
    const id = String(record.id);
    people.set(id, {
      id,
      name: attrs.full_name || [attrs.first_name, attrs.last_name].filter(Boolean).join(" ") || `Person ${id}`,
      last: attrs.last_name || "",
      url: record.links?.html ?? null,
      teams: new Set(),
    });
  }

  const byName = new Map<string, { name: string; ids: Set<string>; instances: number }>();
  for (const team of teamsResult.data) {
    const teamName = String(team.attributes?.name ?? "").trim() || "(Unnamed team)";
    if (config.excludedTeams.has(teamName)) continue;
    const entry = byName.get(teamName) ?? { name: teamName, ids: new Set<string>(), instances: 0 };
    byName.set(teamName, entry);
    entry.instances += 1;
    for (const id of relIds(team, "people")) {
      if (!people.has(id)) people.set(id, { id, name: `Person ${id}`, last: "", url: null, teams: new Set() });
      entry.ids.add(id);
      people.get(id)!.teams.add(teamName);
    }
  }

  const member = (p: { id: string; name: string; last: string; url: string | null }): RosterMember => ({
    id: p.id,
    name: p.name,
    last: p.last,
    url: p.url,
    serves: serves(p.id),
    ...flags(p.id),
  });

  const teams = [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      instances: entry.instances,
      members: [...entry.ids].filter((id) => partnerIds.has(id)).map((id) => member(people.get(id)!)).sort(byLastThenName),
    }))
    .filter((team) => team.members.length)
    .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()));

  const peopleOut = [...people.values()]
    .filter((p) => p.teams.size && partnerIds.has(p.id))
    .map((p) => ({ ...member(p), teams: [...p.teams].sort((a, b) => cmp(a.toLowerCase(), b.toLowerCase())) }))
    .sort(byLastThenName);

  const teamMemberIds = new Set([...byName.values()].flatMap((entry) => [...entry.ids]));
  const partnersNoTeam = partners.filter((p) => !teamMemberIds.has(p.id)).map(member).sort(byLastThenName);

  return {
    people: peopleOut,
    teams,
    partners_no_team: partnersNoTeam,
    schedules: Object.fromEntries(
      [...partnerIds]
        .filter((id) => serving.past.has(id) || serving.upcoming.has(id))
        .map((id) => [
          id,
          {
            past: (serving.past.get(id) ?? []).sort((a, b) => cmp(b.date, a.date)),
            upcoming: (serving.upcoming.get(id) ?? []).sort((a, b) => cmp(a.date, b.date)),
          },
        ]),
    ),
    windows: [...ROSTER_WINDOWS],
    lead_group: config.leadGroup,
    generated_at: Math.floor(now / 1000),
  };
}

async function fetchPartners(pco: PcoClient) {
  const { data } = await pco.getAll("people", "people", { "where[membership]": "Partner", "where[status]": "active" });
  return data.map((record) => {
    const attrs = record.attributes ?? {};
    const id = String(record.id);
    return {
      id,
      name: attrs.name || [attrs.first_name, attrs.last_name].filter(Boolean).join(" ") || `Person ${id}`,
      last: attrs.last_name || "",
      url: `https://people.planningcenteronline.com/people/AC${id}`,
    };
  });
}

/**
 * Walk every service type's plans from 90 days ago through the next UPCOMING_DAYS and collect each
 * person's non-declined slots. Past slots also feed the 30/60/90-day counts, in one pass.
 */
async function fetchServing(pco: PcoClient, now: number) {
  const nowSec = now / 1000;
  const cutoffs = ROSTER_WINDOWS.map((d) => [`d${d}` as keyof Serves, nowSec - d * 86400] as const);
  const widest = nowSec - Math.max(...ROSTER_WINDOWS) * 86400;
  const horizon = nowSec + UPCOMING_DAYS * 86400;
  const counts = new Map<string, Serves>();
  const past = new Map<string, Slot[]>();
  const upcoming = new Map<string, Slot[]>();

  const serviceTypes = asArray((await pco.get("services", "service_types", { per_page: 100 })).data);
  const plans: { serviceTypeId: string; service: string; planId: string; date: string; sortTs: number; future: boolean }[] = [];

  // Past plans newest-first until the widest window, and future plans soonest-first until the horizon.
  const walk = (st: PcoResource, filter: "past" | "future") => async () => {
    for (let offset = 0; ; ) {
      const page = await pco.get("services", `service_types/${st.id}/plans`, {
        filter,
        order: filter === "past" ? "-sort_date" : "sort_date",
        per_page: filter === "past" ? 100 : 25,
        offset,
      });
      const rows = asArray(page.data);
      let done = !rows.length;
      for (const plan of rows) {
        const date = String(plan.attributes?.sort_date ?? "");
        const sortTs = Date.parse(date) / 1000;
        if (Number.isNaN(sortTs) || (filter === "past" ? sortTs < widest : sortTs > horizon)) {
          done = true;
          break;
        }
        const service = String(st.attributes?.name ?? "");
        plans.push({ serviceTypeId: String(st.id), service, planId: String(plan.id), date, sortTs, future: filter === "future" });
      }
      offset += rows.length;
      if (done || offset >= (page.meta?.total_count ?? offset)) break;
    }
  };
  await mapPool(serviceTypes.flatMap((st) => [walk(st, "past"), walk(st, "future")]), 4, (run) => run());

  await mapPool(plans, 4, async (plan) => {
    const windowsHit = cutoffs.filter(([, cut]) => plan.sortTs >= cut).map(([key]) => key);
    if (!plan.future && !windowsHit.length) return;
    const { data, included } = await pco.getAll(
      "services",
      `service_types/${plan.serviceTypeId}/plans/${plan.planId}/team_members`,
      { filter: "not_declined", include: "team" },
    );
    const teamNames = new Map(included.filter((r) => r.type === "Team").map((t) => [t.id, String(t.attributes?.name ?? "").trim()]));
    for (const row of data) {
      const personId = relId(row, "person");
      if (!personId) continue;
      const teamId = relId(row, "team");
      const slot: Slot = {
        date: plan.date,
        service: plan.service,
        team: (teamId && teamNames.get(teamId)) || null,
        position: row.attributes?.team_position_name ?? null,
        status: row.attributes?.status ?? null,
      };
      const target = plan.future ? upcoming : past;
      target.set(personId, [...(target.get(personId) ?? []), slot]);
      if (plan.future) continue;
      const bucket = counts.get(personId) ?? emptyServes();
      counts.set(personId, bucket);
      for (const key of windowsHit) bucket[key] += 1;
    }
  });

  return { counts, past, upcoming };
}

async function findByName(pco: PcoClient, product: "groups" | "people", path: string, name: string) {
  const target = name.trim().toLowerCase();
  const page = await pco.get(product, path, { "where[name]": name, per_page: 100 });
  const candidates: PcoResource[] = Array.isArray(page.data) ? page.data : [];
  return (
    candidates.find((c) => String(c.attributes?.name ?? "").trim().toLowerCase() === target) ?? candidates[0] ?? null
  );
}

async function fetchGroupMemberIds(pco: PcoClient, groupName: string): Promise<Set<string>> {
  const group = await findByName(pco, "groups", "groups", groupName);
  if (!group) return new Set();
  const { data } = await pco.getAll("groups", `groups/${group.id}/memberships`);
  return new Set(data.map((m) => relId(m, "person")).filter((id): id is string => !!id));
}

async function fetchListPersonIds(pco: PcoClient, listName: string, fallback: string[]): Promise<Set<string>> {
  const list = listName ? await findByName(pco, "people", "lists", listName).catch(() => null) : null;
  if (!list) return new Set(fallback);
  const { data } = await pco.getAll("people", `lists/${list.id}/people`);
  return new Set(data.map((p) => String(p.id)));
}

export function rosterConfig(env: Env): RosterConfig {
  let excluded: string[] = [];
  try {
    excluded = JSON.parse(env.ROSTER_EXCLUDED_TEAMS || "[]");
  } catch {
    console.warn("ROSTER_EXCLUDED_TEAMS is not valid JSON; ignoring");
  }
  return {
    leadGroup: env.ROSTER_LEAD_GROUP?.trim() || "Lead Partners",
    eldersList: env.ROSTER_ELDERS_LIST?.trim() ?? "",
    deaconsList: env.ROSTER_DEACONS_LIST?.trim() ?? "",
    excludedTeams: new Set(excluded),
  };
}
