import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PcoClient } from "../src/pco/client";
import { buildRosterPayload } from "../src/roster/build";
import { makeCookie, validCookie } from "../src/roster/routes";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();
const person = (id: string, last: string, first = "P") => ({
  type: "Person",
  id,
  attributes: { full_name: `${first} ${last}`, first_name: first, last_name: last },
  links: { html: `https://services/people/${id}` },
});
const team = (id: string, name: string, people: string[]) => ({
  type: "Team",
  id,
  attributes: { name },
  relationships: { people: { data: people.map((p) => ({ type: "Person", id: p })) } },
});
const member = (personId: string, status = "C", decline_reason?: string) => ({
  type: "PlanPerson",
  id: `pp${personId}`,
  attributes: { name: `Name ${personId}`, status, team_position_name: "Drums", decline_reason },
  relationships: { person: { data: { type: "Person", id: personId } }, team: { data: { type: "Team", id: "t1" } } },
});
const withTeam = (d: ReturnType<typeof doc>) => ({ ...d, included: [{ type: "Team", id: "t1", attributes: { name: "Band " } }] });
const doc = (data: unknown[], extra: Record<string, unknown> = {}) => ({ data, meta: { total_count: data.length }, ...extra });

// A tiny fake of the Planning Center API, keyed by path.
const ROUTES: Record<string, unknown> = {
  "/services/v2/teams": doc(
    [team("t1", "Band ", ["1", "2"]), team("t2", "Band", ["3"]), team("t3", "Teachers", ["1"]), team("t4", "Tech", ["4"])],
    { included: [person("1", "Adams"), person("2", "baker"), person("3", "Cole"), person("4", "Nonpartner")] },
  ),
  "/services/v2/service_types": doc([{ type: "ServiceType", id: "st1", attributes: { name: "Sunday" } }]),
  "/services/v2/service_types/st1/plans?future": doc([
    { type: "Plan", id: "f1", attributes: { sort_date: daysAgo(-7) } },
    { type: "Plan", id: "f2", attributes: { sort_date: daysAgo(-40) } },
  ]),
  "/services/v2/service_types/st1/plans/f1/team_members": withTeam(doc([member("1", "U")])),
  "/services/v2/service_types/st1/plans": doc([
    { type: "Plan", id: "p1", attributes: { sort_date: daysAgo(10) } },
    { type: "Plan", id: "p2", attributes: { sort_date: daysAgo(45) } },
    { type: "Plan", id: "p3", attributes: { sort_date: daysAgo(80) } },
    { type: "Plan", id: "p4", attributes: { sort_date: daysAgo(120) } },
  ]),
  "/services/v2/service_types/st1/plans/p1/team_members": withTeam(doc([member("1"), member("2")])),
  "/services/v2/service_types/st1/plans/p2/team_members": doc([member("1"), member("2", "D", "Out of town")]),
  "/services/v2/service_types/st1/plans/f1/needed_positions": withTeam(
    doc([{ type: "NeededPosition", id: "n1", attributes: { team_position_name: "Bass", quantity: 2 }, relationships: { team: { data: { type: "Team", id: "t1" } } } }]),
  ),
  "/services/v2/service_types/st1/plans/p3/team_members": doc([member("1"), member("5")]),
  "/services/v2/service_types/st1/plans/p4/team_members": doc([member("1")]),
  "/people/v2/people": doc(
    ["1", "2", "3", "5"].map((id) => ({ type: "Person", id, attributes: { name: `Partner ${id}`, last_name: `L${id}` } })),
  ),
  "/groups/v2/groups": doc([{ type: "Group", id: "g1", attributes: { name: "Lead Partners" } }]),
  "/groups/v2/groups/g1/memberships": doc([{ type: "Membership", id: "m1", relationships: { person: { data: { type: "Person", id: "3" } } } }]),
  "/people/v2/lists": doc([]),
};

function mockPco() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = ROUTES[url.pathname + (url.searchParams.get("filter") === "future" ? "?future" : "")];
    return body ? Response.json(body) : new Response("{}", { status: 404 });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("buildRosterPayload", () => {
  it("matches the Python roster semantics", async () => {
    mockPco();
    const payload = await buildRosterPayload(
      new PcoClient("x", "y"),
      { leadGroup: "Lead Partners", eldersList: "Elders", deaconsList: "Deacons", excludedTeams: new Set(["Teachers"]) },
      NOW,
    );

    // "Band " and "Band" merge; Teachers is excluded; Tech has no Partner members so it's hidden.
    expect(payload.teams.map((t) => [t.name, t.instances, t.members.map((m) => m.name)])).toEqual([
      ["Band", 2, ["P Adams", "P baker", "P Cole"]],
    ]);
    const adams = payload.people.find((p) => p.name === "P Adams")!;
    expect(adams.teams).toEqual(["Band"]);
    expect(adams.serves).toEqual({ d30: 1, d60: 2, d90: 3 });
    expect(payload.people.find((p) => p.name === "P Cole")).toMatchObject({ lead: true, serves: { d30: 0, d60: 0, d90: 0 } });
    // Partner 5 is on no team but served once (80 days ago).
    expect(payload.partners_no_team).toEqual([
      expect.objectContaining({ name: "Partner 5", serves: { d30: 0, d60: 0, d90: 1 }, lead: false }),
    ]);
    // Schedules: past slots match the d90 count; only the plan inside the 4-week horizon is upcoming.
    expect(payload.schedules["1"].past.map((s) => s.date)).toEqual([daysAgo(10), daysAgo(45), daysAgo(80)]);
    expect(payload.schedules["1"].past[0]).toEqual({ date: daysAgo(10), service: "Sunday", team: "Band", position: "Drums", status: "C" });
    expect(payload.schedules["1"].upcoming).toEqual([
      { date: daysAgo(-7), service: "Sunday", team: "Band", position: "Drums", status: "U" },
    ]);
    expect(payload.schedules["4"]).toBeUndefined(); // not a Partner
    // Declines are kept (with reason) but never counted as serves.
    expect(payload.schedules["2"].past).toContainEqual(expect.objectContaining({ status: "D", reason: "Out of town" }));
    expect(payload.people.find((p) => p.name === "P baker")!.serves).toEqual({ d30: 1, d60: 1, d90: 1 });
    // Plans in the next 7 days carry their full lineup and open positions.
    expect(payload.week).toEqual([
      {
        date: daysAgo(-7),
        service: "Sunday",
        title: null,
        members: [{ name: "Name 1", person_id: "1", team: "Band", position: "Drums", status: "U" }],
        needed: [{ team: "Band", position: "Bass", quantity: 2 }],
      },
    ]);
    expect(adams.id).toBe("1");
    expect(payload.windows).toEqual([30, 60, 90]);
    expect(payload.generated_at).toBe(NOW / 1000);
  });

  it("falls back to the built-in elder/deacon IDs when the PCO Lists are missing", async () => {
    ROUTES["/people/v2/people"] = doc([{ type: "Person", id: "88545253", attributes: { name: "Josh Ruff", last_name: "Ruff" } }]);
    mockPco();
    const payload = await buildRosterPayload(
      new PcoClient("x", "y"),
      { leadGroup: "Lead Partners", eldersList: "Elders", deaconsList: "Deacons", excludedTeams: new Set() },
      NOW,
    );
    expect(payload.partners_no_team[0]).toMatchObject({ name: "Josh Ruff", deacon: true, elder: false });
  });
});

describe("PcoClient", () => {
  it("follows pagination and retries after a 429", async () => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      calls++;
      if (calls === 1) return new Response("", { status: 429, headers: { "Retry-After": "1" } });
      const offset = Number(new URL(String(input instanceof Request ? input.url : input)).searchParams.get("offset"));
      const data = Array.from({ length: offset === 0 ? 100 : 30 }, (_, i) => ({ type: "Person", id: String(offset + i) }));
      return Response.json({ data, meta: { total_count: 130 } });
    });
    const { data } = await new PcoClient("x", "y").getAll("people", "people");
    expect(data).toHaveLength(130);
    expect(calls).toBe(3);
  });

  it("maps API errors to readable messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ errors: [{ detail: "nope" }] }, { status: 403 }));
    await expect(new PcoClient("x", "y").get("people", "people")).rejects.toThrow(/denied access.*nope/);
  });
});

describe("roster cookie", () => {
  it("accepts its own cookie and rejects tampered or expired ones", async () => {
    const cookie = await makeCookie(env, NOW);
    expect(await validCookie(env, cookie, NOW)).toBe(true);
    expect(await validCookie(env, cookie.replace(/.$/, (c) => (c === "0" ? "1" : "0")), NOW)).toBe(false);
    expect(await validCookie(env, cookie, NOW + 13 * 3600_000)).toBe(false);
    expect(await validCookie(env, null)).toBe(false);
  });
});
