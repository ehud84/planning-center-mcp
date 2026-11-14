import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { asArray } from "../../pco/client";
import { READ_ONLY, type ToolContext, collection, id, includedMap, paging, slim, tool } from "../util";

const PERSON_FIELDS = ["name", "first_name", "last_name", "status", "membership", "child", "avatar", "created_at"];

export function registerPeopleTools(server: McpServer, { pco }: ToolContext) {
  tool(
    server,
    "find_people",
    {
      title: "Find People",
      description:
        "Search or list Planning Center People. Matches name or email (partial), and can filter by membership " +
        "(e.g. 'Partner'), status, or a People List name. Omit all filters to list everyone.",
      annotations: READ_ONLY,
      input: {
        query: z.string().min(1).optional().describe("Name or email, full or partial"),
        membership: z.string().min(1).optional().describe("Membership type, e.g. 'Partner'"),
        status: z.enum(["active", "inactive"]).optional(),
        list: z.string().min(1).optional().describe("Only people in this Planning Center People List (by name)"),
        ...paging(25),
      },
    },
    async ({ query, membership, status, list, per_page, offset }) => {
      let path = "people";
      if (list) {
        const lists = await pco.get("people", "lists", { "where[name]": list, per_page: 1 });
        const match = asArray(lists.data)[0];
        if (!match) throw new Error(`No People List named "${list}" is visible to you`);
        path = `lists/${match.id}/people`;
      }
      const doc = await pco.get("people", path, {
        "where[search_name_or_email]": query,
        "where[membership]": membership,
        "where[status]": status,
        per_page,
        offset,
      });
      const people = asArray(doc.data).map((p) => slim(p, PERSON_FIELDS));
      return collection(doc, "people", people, offset);
    },
  );

  tool(
    server,
    "get_person",
    {
      title: "Get Person",
      description:
        "Full picture of one person: profile, contact info, Groups memberships, upcoming Services schedules " +
        "and blockouts. Sections you lack permission for come back as an error string.",
      annotations: READ_ONLY,
      input: { person_id: id("person") },
    },
    async ({ person_id }) => {
      const settle = async <T>(fn: () => Promise<T>): Promise<T | { error: string }> => {
        try {
          return await fn();
        } catch (error) {
          return { error: (error as Error).message };
        }
      };

      const [profile, groups, schedules, blockouts] = await Promise.all([
        settle(async () => {
          const doc = await pco.get("people", `people/${person_id}`, {
            include: "emails,phone_numbers,addresses,households",
          });
          const person = asArray(doc.data)[0];
          const inc = doc.included ?? [];
          const pick = (type: string, attrs: string[]) => inc.filter((r) => r.type === type).map((r) => slim(r, attrs));
          return {
            ...slim(person, [...PERSON_FIELDS, "birthdate", "anniversary", "gender", "grade", "remote_id"]),
            url: `https://people.planningcenteronline.com/people/AC${person_id}`,
            emails: pick("Email", ["address", "location", "primary"]),
            phone_numbers: pick("PhoneNumber", ["number", "location", "primary"]),
            addresses: pick("Address", ["street", "city", "state", "zip", "location", "primary"]),
            households: pick("Household", ["name"]),
          };
        }),
        settle(async () => {
          const doc = await pco.get("groups", `people/${person_id}/memberships`, { include: "group", per_page: 100 });
          const inc = includedMap(doc);
          return asArray(doc.data).map((m) => {
            const groupId = m.relationships?.group?.data;
            const group = groupId && !Array.isArray(groupId) ? inc.get(`Group:${groupId.id}`) : undefined;
            return { membership_id: m.id, role: m.attributes?.role, joined_at: m.attributes?.joined_at, group: slim(group, ["name"]) };
          });
        }),
        settle(async () => {
          const doc = await pco.get("services", `people/${person_id}/schedules`, {
            filter: "future",
            order: "starts_at",
            per_page: 25,
          });
          return asArray(doc.data).map((s) =>
            slim(s, ["sort_date", "dates", "service_type_name", "team_name", "team_position_name", "status", "decline_reason"], ["plan"]),
          );
        }),
        settle(async () => {
          const doc = await pco.get("services", `people/${person_id}/blockouts`, { filter: "future", per_page: 25 });
          return asArray(doc.data).map((b) => slim(b, ["description", "reason", "starts_at", "ends_at", "repeat_frequency"]));
        }),
      ]);

      return { profile, groups, upcoming_schedules: schedules, upcoming_blockouts: blockouts };
    },
  );
}
