#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_groups",
        description: "List all groups in Planning Center",
        inputSchema: {
          type: "object",
          properties: {
            per_page: {
              type: "number",
              description: "Results per page (default: 100)",
            },
          },
        },
      },
      {
        name: "get_group",
        description: "Get a specific group by ID",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Group ID",
            },
          },
          required: ["group_id"],
        },
      },
      {
        name: "get_group_types",
        description: "Get all available group types",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "create_group",
        description: "Create a new group",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Group name",
            },
            group_type_id: {
              type: "string",
              description: "Group type ID (optional)",
            },
            members_confidential: {
              type: "boolean",
              description: "Members confidential (default: true)",
            },
            listed: {
              type: "boolean",
              description: "Listed (default: false)",
            },
          },
          required: ["name"],
        },
      },
      {
        name: "list_people",
        description: "List all people",
        inputSchema: {
          type: "object",
          properties: {
            per_page: {
              type: "number",
              description: "Results per page (default: 100)",
            },
          },
        },
      },
      {
        name: "search_people",
        description: "Search people by name",
        inputSchema: {
          type: "object",
          properties: {
            first_name: {
              type: "string",
              description: "First name",
            },
            last_name: {
              type: "string",
              description: "Last name",
            },
          },
        },
      },
      {
        name: "get_group_memberships",
        description: "Get members of a group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Group ID",
            },
            per_page: {
              type: "number",
              description: "Results per page (default: 100)",
            },
          },
          required: ["group_id"],
        },
      },
      {
        name: "add_person_to_group",
        description: "Add person to group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Group ID",
            },
            person_id: {
              type: "string",
              description: "Person ID",
            },
            role: {
              type: "string",
              description: "Role (member or leader, default: member)",
            },
          },
          required: ["group_id", "person_id"],
        },
      },
      {
        name: "remove_person_from_group",
        description: "Remove person from group",
        inputSchema: {
          type: "object",
          properties: {
            group_id: {
              type: "string",
              description: "Group ID",
            },
            membership_id: {
              type: "string",
              description: "Membership ID",
            },
          },
          required: ["group_id", "membership_id"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params?.name;
  const toolArgs = (request.params?.arguments || {}) as Record<string, any>;

  try {
    let result: any;

    switch (toolName) {
      case "list_groups":
        result = await api.listGroups((toolArgs.per_page as number) || 100);
        break;
      case "get_group":
        result = await api.getGroup(toolArgs.group_id as string);
        break;
      case "get_group_types":
        result = await api.getGroupTypes();
        break;
      case "create_group":
        result = await api.createGroup(
          toolArgs.name as string,
          toolArgs.group_type_id as string | undefined,
          (toolArgs.members_confidential as boolean | undefined) !== false,
          (toolArgs.listed as boolean | undefined) === true
        );
        break;
      case "list_people":
        result = await api.listPeople((toolArgs.per_page as number) || 100);
        break;
      case "search_people":
        result = await api.searchPeopleByName(
          toolArgs.first_name as string | undefined,
          toolArgs.last_name as string | undefined
        );
        break;
      case "get_group_memberships":
        result = await api.getGroupMemberships(
          toolArgs.group_id as string,
          (toolArgs.per_page as number) || 100
        );
        break;
      case "add_person_to_group":
        result = await api.addPersonToGroup(
          toolArgs.group_id as string,
          toolArgs.person_id as string,
          (toolArgs.role as string) || "member"
        );
        break;
      case "remove_person_from_group":
        result = await api.removePersonFromGroup(
          toolArgs.group_id as string,
          toolArgs.membership_id as string
        );
        break;
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

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
      // Enable CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.url === "/messages" && req.method === "GET") {
        const transport = new SSEServerTransport(req as any, res as any);
        await server.connect(transport);
        return;
      }

      // Health check
      if (req.url === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // OAuth discovery endpoints
      if (req.url === "/.well-known/oauth-protected-resource" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ protected_resources: [] }));
        return;
      }

      if (req.url === "/.well-known/oauth-authorization-server" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ issuer: "planning-center-mcp" }));
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error: any) {
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
