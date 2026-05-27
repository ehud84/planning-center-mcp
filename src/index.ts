#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
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

// Create MCP server
const server = new Server(
  {
    name: "planning-center-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tool schemas
const ListGroupsSchema = z.object({
  per_page: z.number().optional().describe("Results per page (default: 100)"),
});

const GetGroupSchema = z.object({
  group_id: z.string().describe("Group ID"),
});

const CreateGroupSchema = z.object({
  name: z.string().describe("Group name"),
  group_type_id: z.string().optional().describe("Group type ID (optional)"),
  members_confidential: z.boolean().optional().describe("Members confidential (default: true)"),
  listed: z.boolean().optional().describe("Listed (default: false)"),
});

const ListPeopleSchema = z.object({
  per_page: z.number().optional().describe("Results per page (default: 100)"),
});

const SearchPeopleSchema = z.object({
  first_name: z.string().optional().describe("First name"),
  last_name: z.string().optional().describe("Last name"),
});

const GetGroupMembershipsSchema = z.object({
  group_id: z.string().describe("Group ID"),
  per_page: z.number().optional().describe("Results per page (default: 100)"),
});

const AddPersonToGroupSchema = z.object({
  group_id: z.string().describe("Group ID"),
  person_id: z.string().describe("Person ID"),
  role: z.string().optional().describe("Role (member or leader, default: member)"),
});

const RemovePersonFromGroupSchema = z.object({
  group_id: z.string().describe("Group ID"),
  membership_id: z.string().describe("Membership ID"),
});

// Register tools
server.registerTool(
  {
    name: "list_groups",
    description: "List all groups in Planning Center",
    inputSchema: ListGroupsSchema,
  },
  async (input) => {
    const result = await api.listGroups(input.per_page || 100);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "get_group",
    description: "Get a specific group by ID",
    inputSchema: GetGroupSchema,
  },
  async (input) => {
    const result = await api.getGroup(input.group_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "get_group_types",
    description: "Get all available group types",
    inputSchema: z.object({}),
  },
  async () => {
    const result = await api.getGroupTypes();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "create_group",
    description: "Create a new group",
    inputSchema: CreateGroupSchema,
  },
  async (input) => {
    const result = await api.createGroup(
      input.name,
      input.group_type_id,
      input.members_confidential !== false,
      input.listed === true
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "list_people",
    description: "List all people",
    inputSchema: ListPeopleSchema,
  },
  async (input) => {
    const result = await api.listPeople(input.per_page || 100);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "search_people",
    description: "Search people by name",
    inputSchema: SearchPeopleSchema,
  },
  async (input) => {
    const result = await api.searchPeopleByName(input.first_name, input.last_name);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "get_group_memberships",
    description: "Get members of a group",
    inputSchema: GetGroupMembershipsSchema,
  },
  async (input) => {
    const result = await api.getGroupMemberships(
      input.group_id,
      input.per_page || 100
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "add_person_to_group",
    description: "Add person to group",
    inputSchema: AddPersonToGroupSchema,
  },
  async (input) => {
    const result = await api.addPersonToGroup(
      input.group_id,
      input.person_id,
      input.role || "member"
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.registerTool(
  {
    name: "remove_person_from_group",
    description: "Remove person from group",
    inputSchema: RemovePersonFromGroupSchema,
  },
  async (input) => {
    const result = await api.removePersonFromGroup(
      input.group_id,
      input.membership_id
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result ? "Success" : "Failed"),
        },
      ],
    };
  }
);

// Start server with proper HTTP transport
async function main() {
  try {
    const groups = await api.listGroups(1);
    console.error(`✓ Connected to Planning Center. Found groups.`);
  } catch (error) {
    console.error(`✗ Connection failed: ${error}`);
    process.exit(1);
  }

  const port = parseInt(process.env.PORT || "3000", 10);

  const httpServer = http.createServer(async (req, res) => {
    try {
      // Only handle SSE connections on /messages endpoint
      if (req.url === "/messages" && req.method === "GET") {
        const transport = new SSEServerTransport(req, res);
        await server.connect(transport);
      } else {
        // Return 404 for other routes
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      console.error("Error handling request:", error);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });

  httpServer.on("error", (error) => {
    console.error("Server error:", error);
  });

  httpServer.listen(port, () => {
    console.error(`✓ Planning Center MCP server running on port ${port}`);
  });

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    console.error("SIGTERM received, shutting down gracefully");
    httpServer.close(() => {
      process.exit(0);
    });
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
