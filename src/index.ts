#!/usr/bin/env node
import axios, { AxiosInstance } from "axios";
import http from "http";

const PCO_API_BASE = "https://api.planningcenteronline.com";
const PCO_API_VERSION = "v2";

class PlanningCenterAPI {
  private client: AxiosInstance;

  constructor(clientId: string, clientSecret: string) {
    this.client = axios.create({
      baseURL: PCO_API_BASE,
      auth: {
        username: clientId,
        password: clientSecret,
      },
      headers: {
        "User-Agent": "Planning Center MCP Server",
      },
    });
  }

  async listGroups(perPage: number = 100): Promise<any[]> {
    const response = await this.client.get(`/groups/${PCO_API_VERSION}/groups`, {
      params: { per_page: perPage },
    });
    return response.data.data || [];
  }

  async getGroup(groupId: string): Promise<any> {
    const response = await this.client.get(
      `/groups/${PCO_API_VERSION}/groups/${groupId}`
    );
    return response.data.data || {};
  }

  async createGroup(
    name: string,
    groupTypeId?: string,
    membersConfidential: boolean = true,
    listed: boolean = false
  ): Promise<any> {
    const data: any = {
      data: {
        type: "Group",
        attributes: {
          name,
          members_are_confidential: membersConfidential,
          listed,
        },
      },
    };

    if (groupTypeId) {
      data.data.relationships = {
        group_type: {
          data: {
            type: "GroupType",
            id: groupTypeId,
          },
        },
      };
    }

    const response = await this.client.post(
      `/groups/${PCO_API_VERSION}/groups`,
      data
    );
    return response.data.data || {};
  }

  async getGroupTypes(): Promise<any[]> {
    const response = await this.client.get(
      `/groups/${PCO_API_VERSION}/group_types`
    );
    return response.data.data || [];
  }

  async listPeople(perPage: number = 100): Promise<any[]> {
    const response = await this.client.get(`/people/${PCO_API_VERSION}/people`, {
      params: { per_page: perPage },
    });
    return response.data.data || [];
  }

  async searchPeopleByName(
    firstName?: string,
    lastName?: string
  ): Promise<any[]> {
    const people = await this.listPeople(1000);
    return people.filter((person) => {
      const attrs = person.attributes || {};
      const first = (attrs.first_name || "").toLowerCase();
      const last = (attrs.last_name || "").toLowerCase();

      let match = true;
      if (firstName && !first.includes(firstName.toLowerCase())) {
        match = false;
      }
      if (lastName && !last.includes(lastName.toLowerCase())) {
        match = false;
      }

      return match;
    });
  }

  async getGroupMemberships(groupId: string, perPage: number = 100): Promise<any[]> {
    const response = await this.client.get(
      `/groups/${PCO_API_VERSION}/groups/${groupId}/memberships`,
      { params: { per_page: perPage } }
    );
    return response.data.data || [];
  }

  async addPersonToGroup(
    groupId: string,
    personId: string,
    role: string = "member"
  ): Promise<any> {
    const data = {
      data: {
        type: "Membership",
        attributes: {
          role,
        },
        relationships: {
          person: {
            data: {
              type: "Person",
              id: personId,
            },
          },
        },
      },
    };

    const response = await this.client.post(
      `/groups/${PCO_API_VERSION}/groups/${groupId}/memberships`,
      data
    );
    return response.data.data || {};
  }

  async removePersonFromGroup(
    groupId: string,
    membershipId: string
  ): Promise<boolean> {
    try {
      await this.client.delete(
        `/groups/${PCO_API_VERSION}/groups/${groupId}/memberships/${membershipId}`
      );
      return true;
    } catch {
      return false;
    }
  }
}

const clientId = process.env.PCO_CLIENT_ID;
const clientSecret = process.env.PCO_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Error: PCO_CLIENT_ID and PCO_CLIENT_SECRET environment variables required"
  );
  process.exit(1);
}

const api = new PlanningCenterAPI(clientId, clientSecret);

async function main() {
  try {
    const groups = await api.listGroups(1);
    console.error(`✓ Connected to Planning Center. Found groups.`);
  } catch (error) {
    console.error(`✗ Connection failed: ${error}`);
    process.exit(1);
  }

  const port = parseInt(process.env.PORT || "3000", 10);

  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const method = req.method || "";

    console.error(`[${method}] ${url}`);

    if (url === "/health") {
      console.error("  → Matched /health");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (url === "/tools") {
      console.error("  → Matched /tools");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        tools: [
          { name: "list_groups", description: "List all groups" },
          { name: "get_group", description: "Get a group" },
          { name: "get_group_types", description: "Get group types" },
          { name: "create_group", description: "Create a group" },
          { name: "list_people", description: "List people" },
          { name: "search_people", description: "Search people" },
          { name: "get_group_memberships", description: "Get group members" },
          { name: "add_person_to_group", description: "Add person to group" },
          { name: "remove_person_from_group", description: "Remove person from group" },
        ]
      }));
      return;
    }

    if (url === "/call_tool") {
      console.error("  → Matched /call_tool");
      let body = "";
      req.on("data", chunk => { body += chunk; });
      req.on("end", async () => {
        try {
          const request = JSON.parse(body);
          const toolName = request.name;
          const toolArgs = request.arguments || {};

          let result: any;
          switch (toolName) {
            case "list_groups": result = await api.listGroups(toolArgs.per_page || 100); break;
            case "get_group": result = await api.getGroup(toolArgs.group_id); break;
            case "get_group_types": result = await api.getGroupTypes(); break;
            case "create_group": result = await api.createGroup(toolArgs.name, toolArgs.group_type_id, toolArgs.members_confidential !== false, toolArgs.listed === true); break;
            case "list_people": result = await api.listPeople(toolArgs.per_page || 100); break;
            case "search_people": result = await api.searchPeopleByName(toolArgs.first_name, toolArgs.last_name); break;
            case "get_group_memberships": result = await api.getGroupMemberships(toolArgs.group_id, toolArgs.per_page || 100); break;
            case "add_person_to_group": result = await api.addPersonToGroup(toolArgs.group_id, toolArgs.person_id, toolArgs.role || "member"); break;
            case "remove_person_from_group": result = await api.removePersonFromGroup(toolArgs.group_id, toolArgs.membership_id); break;
            default: throw new Error(`Unknown tool: ${toolName}`);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (error: any) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    console.error("  → No match, returning 404");
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.error(`✓ Planning Center MCP server running on port ${port}`);
  });
}

main().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
