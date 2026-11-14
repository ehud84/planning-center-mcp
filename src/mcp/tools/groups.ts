import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { asArray } from "../../pco/client";
import { DESTRUCTIVE, READ_ONLY, type ToolContext, WRITE, collection, id, includedMap, paging, slim, tool } from "../util";

const GROUP_FIELDS = [
  "name",
  "description",
  "schedule",
  "memberships_count",
  "members_are_confidential",
  "listed",
  "public_church_center_web_url",
  "archived_at",
];

export function registerGroupTools(server: McpServer, { pco }: ToolContext) {
  tool(
    server,
    "list_groups",
    {
      title: "List Groups",
      description: "List Planning Center Groups, optionally filtered by name (partial) or group type. Pass group_id for one group's details.",
      annotations: READ_ONLY,
      input: {
        group_id: id("group").optional(),
        name: z.string().min(1).optional().describe("Partial group name"),
        group_type_id: id("group type").optional(),
        ...paging(100),
      },
    },
    async ({ group_id, name, group_type_id, per_page, offset }) => {
      if (group_id) {
        const doc = await pco.get("groups", `groups/${group_id}`, { include: "group_type,location" });
        const inc = includedMap(doc);
        const group = asArray(doc.data)[0];
        const type = group.relationships?.group_type?.data;
        return {
          group: {
            ...slim(group, [...GROUP_FIELDS, "contact_email", "created_at"], ["group_type", "location"]),
            group_type: type && !Array.isArray(type) ? slim(inc.get(`GroupType:${type.id}`), ["name"]) : null,
          },
        };
      }
      const path = group_type_id ? `group_types/${group_type_id}/groups` : "groups";
      const doc = await pco.get("groups", path, { "where[name]": name ? `%${name}%` : undefined, per_page, offset });
      return collection(doc, "groups", asArray(doc.data).map((g) => slim(g, GROUP_FIELDS, ["group_type"])), offset);
    },
  );

  tool(
    server,
    "list_group_types",
    {
      title: "List Group Types",
      description: "List Planning Center Group Types (categories of groups).",
      annotations: READ_ONLY,
      input: paging(100),
    },
    async ({ per_page, offset }) => {
      const doc = await pco.get("groups", "group_types", { per_page, offset });
      return collection(doc, "group_types", asArray(doc.data).map((t) => slim(t, ["name", "description"])), offset);
    },
  );

  tool(
    server,
    "group_members",
    {
      title: "Group Members",
      description: "List a group's memberships with each person's name and role. membership_id is used by remove_group_member.",
      annotations: READ_ONLY,
      input: { group_id: id("group"), ...paging(100) },
    },
    async ({ group_id, per_page, offset }) => {
      const doc = await pco.get("groups", `groups/${group_id}/memberships`, { include: "person", per_page, offset });
      const inc = includedMap(doc);
      const members = asArray(doc.data).map((m) => {
        const ref = m.relationships?.person?.data;
        const personId = ref && !Array.isArray(ref) ? ref.id : null;
        const person = personId ? inc.get(`Person:${personId}`) : undefined;
        return {
          membership_id: m.id,
          role: m.attributes?.role,
          joined_at: m.attributes?.joined_at,
          person_id: personId,
          name: person?.attributes?.name ?? [person?.attributes?.first_name, person?.attributes?.last_name].filter(Boolean).join(" "),
          email: person?.attributes?.email_address ?? null,
        };
      });
      return { group_id, ...collection(doc, "members", members, offset) };
    },
  );

  tool(
    server,
    "create_group",
    {
      title: "Create Group",
      description: "Create a Planning Center Group.",
      annotations: WRITE,
      input: {
        name: z.string().min(1).max(100),
        group_type_id: id("group type").optional(),
        members_confidential: z.boolean().default(true).describe("Whether group membership is confidential"),
        listed: z.boolean().default(false).describe("Whether the group is publicly listed"),
      },
    },
    async ({ name, group_type_id, members_confidential, listed }) => {
      const doc = await pco.request("groups", "groups", {
        method: "POST",
        body: {
          data: {
            type: "Group",
            attributes: { name, members_are_confidential: members_confidential, listed },
            ...(group_type_id ? { relationships: { group_type: { data: { type: "GroupType", id: group_type_id } } } } : {}),
          },
        },
      });
      return { created: true, group: slim(asArray(doc?.data)[0], GROUP_FIELDS, ["group_type"]) };
    },
  );

  tool(
    server,
    "add_group_member",
    {
      title: "Add Person to Group",
      description: "Add a person to a Planning Center Group as a member or leader.",
      annotations: WRITE,
      input: { group_id: id("group"), person_id: id("person"), role: z.enum(["member", "leader"]).default("member") },
    },
    async ({ group_id, person_id, role }) => {
      const doc = await pco.request("groups", `groups/${group_id}/memberships`, {
        method: "POST",
        body: {
          data: {
            type: "Membership",
            attributes: { role },
            relationships: { person: { data: { type: "Person", id: person_id } } },
          },
        },
      });
      return { added: true, group_id, person_id, membership: slim(asArray(doc?.data)[0], ["role", "joined_at"], ["person"]) };
    },
  );

  tool(
    server,
    "remove_group_member",
    {
      title: "Remove Person from Group",
      description: "Remove a membership from a Planning Center Group (get membership_id from group_members).",
      annotations: DESTRUCTIVE,
      input: { group_id: id("group"), membership_id: id("membership") },
    },
    async ({ group_id, membership_id }) => {
      await pco.request("groups", `groups/${group_id}/memberships/${membership_id}`, { method: "DELETE" });
      return { removed: true, group_id, membership_id };
    },
  );
}
