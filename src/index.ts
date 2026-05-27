import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from "axios";

const PCO_API_BASE = "https://api.planningcenteronline.com";
const PCO_API_VERSION = "v2";

class PlanningCenterMCP {
  private client: AxiosInstance;
  private clientId: string;
  private clientSecret: string;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;

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
    try {
      const response = await this.client.get(`/groups/${PCO_API_VERSION}/groups`, {
        params: { per_page: perPage },
      });
      return response.data.data || [];
    } catch (error) {
      throw new Error(`Failed to list groups: ${error}`);
    }
  }

  async getGroup(groupId: string): Promise<any> {
    try {
      const response = await this.client.get(
        `/groups/${PCO_API_VERSION}/groups/${groupId}`
      );
      return response.data.data || {};
    } catch (error) {
      throw new Error(`Failed to get group: ${error}`);
    }
  }

  async createGroup(
    name: string,
    groupTypeId?: string,
    membersConfidential: boolean = true,
    listed: boolean = false
  ): Promise<any> {
    try {
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
    } catch (error) {
      throw new Error(`Failed to create group: ${error}`);
    }
  }

  async getGroupTypes(): Promise<any[]> {
    try {
      const response = await this.client.get(
        `/groups/${PCO_API_VERSION}/group_types`
      );
      return response.data.data || [];
    } catch (error) {
      throw new Error(`Failed to get group types: ${error}`);
    }
  }

  async getGroupTypeByName(name: string): Promise<any> {
    try {
      const types = await this.getGroupTypes();
      const found = types.find((t) => t.attributes?.name === name);
      if (!found) {
        throw new Error(`Group type '${name}' not found`);
      }
      return found;
    } catch (error) {
      throw new Error(`Failed to get group type by name: ${error}`);
    }
  }

  async listPeople(perPage: number = 100): Promise<any[]> {
    try {
      const response = await this.client.get(`/people/${PCO_API_VERSION}/people`, {
        params: { per_page: perPage },
      });
      return response.data.data || [];
    } catch (error) {
      throw new Error(`Failed to list people: ${error}`);
    }
  }

  async searchPeopleByName(
    firstName?: string,
    lastName?: string
  ): Promise<any[]> {
    try {
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
    } catch (error) {
      throw new Error(`Failed to search people: ${error}`);
    }
  }

  async getGroupMemberships(groupId: string, perPage: number = 100): Promise<any[]> {
    try {
      const response = await this.client.get(
        `/groups/${PCO_API_VERSION}/groups/${groupId}/memberships`,
        { params: { per_page: perPage } }
      );
      return response.data.data || [];
    } catch (error) {
      throw new Error(`Failed to get group memberships: ${error}`);
    }
  }

  async addPersonToGroup(
    groupId: string,
    personId: string,
    role: string = "member"
  ): Promise<any> {
    try {
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
    } catch (error) {
      throw new Error(`Failed to add person to group: ${error}`);
    }
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
    } catch (error) {
      console.error(`Failed to remove person from group: ${error}`);
      return false;
    }
  }
}

// Initialize server
const clientId = process.env.PCO_CLIENT_ID;
const clientSecret = process.env.PCO_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Error: PCO_CLIENT_ID and PCO_CLIENT_SECRET environment variables must be set"
  );
  process.exit(1);
}

const pco = new PlanningCenterMCP(clientId, clientSecret);

// Define tools
const tools: Tool[] = [
  {
    name: "list_groups",
    description:
      "List all groups in Planning Center. Returns group name, ID, member count, and other details.",
    inputSchema: {
      type: "object",
      properties: {
        per_page: {
          type: "number",
          description: "Number of results per page (default: 100, max: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_group",
    description:
      "Get details for a specific group by ID. Returns all group attributes.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: {
          type: "string",
          description: "The Planning Center group ID",
        },
      },
      required: ["group_id"],
    },
  },
  {
    name: "get_group_types",
    description:
      "Get all available group types in Planning Center (e.g., 'Missional Communities', 'Life Groups', etc.)",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "create_group",
    description:
      "Create a new group in Planning Center with specified name and optional settings.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name of the group to create",
        },
        group_type_id: {
          type: "string",
          description:
            "Optional: The group type ID (get list from get_group_types)",
        },
        members_confidential: {
          type: "boolean",
          description: "Whether group members are confidential (default: true)",
        },
        listed: {
          type: "boolean",
          description: "Whether group is publicly listed (default: false)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_people",
    description: "List all people in the Planning Center organization.",
    inputSchema: {
      type: "object",
      properties: {
        per_page: {
          type: "number",
          description: "Number of results per page (default: 100, max: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "search_people",
    description:
      "Search for people by first name and/or last name. Returns matching people.",
    inputSchema: {
      type: "object",
      properties: {
        first_name: {
          type: "string",
          description: "First name (partial match supported)",
        },
        last_name: {
          type: "string",
          description: "Last name (partial match supported)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_group_memberships",
    description: "Get all members of a specific group with their roles.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: {
          type: "string",
          description: "The Planning Center group ID",
        },
        per_page: {
          type: "number",
          description: "Number of results per page (default: 100, max: 100)",
        },
      },
      required: ["group_id"],
    },
  },
  {
    name: "add_person_to_group",
    description:
      "Add a person to a group with an optional role (member or leader).",
    inputSchema: {
      type: "object",
      properties: {
        group_id: {
          type: "string",
          description: "The Planning Center group ID",
        },
        person_id: {
          type: "string",
          description: "The Planning Center person ID",
        },
        role: {
          type: "string",
          description: "Role in group: 'member' or 'leader' (default: member)",
        },
      },
      required: ["group_id", "person_id"],
    },
  },
  {
    name: "remove_person_from_group",
    description: "Remove a person from a group.",
    inputSchema: {
      type: "object",
      properties: {
        group_id: {
          type: "string",
          description: "The Planning Center group ID",
        },
        membership_id: {
          type: "string",
          description: "The membership ID (obtained from get_group_memberships)",
        },
      },
      required: ["group_id", "membership_id"],
    },
  },
];

// Create server with tools
const server = new Server(
  {
    name: "planning-center-mcp",
    version: "1.0.0",
  },
  {
    tools: tools,
  }
);

// Handle tool calls
server.setRequestHandler("tools/call", async (request: any) => {
  const toolName = request.params.name;
  const toolArgs = request.params.arguments || {};

  try {
    let result: any;

    switch (toolName) {
      case "list_groups": {
        result = await pco.listGroups(toolArgs.per_page || 100);
        break;
      }
      case "get_group": {
        result = await pco.getGroup(toolArgs.group_id);
        break;
      }
      case "get_group_types": {
        result = await pco.getGroupTypes();
        break;
      }
      case "create_group": {
        result = await pco.createGroup(
          toolArgs.name,
          toolArgs.group_type_id,
          toolArgs.members_confidential !== false,
          toolArgs.listed === true
        );
        break;
      }
      case "list_people": {
        result = await pco.listPeople(toolArgs.per_page || 100);
        break;
      }
      case "search_people": {
        result = await pco.searchPeopleByName(
          toolArgs.first_name,
          toolArgs.last_name
        );
        break;
      }
      case "get_group_memberships": {
        result = await pco.getGroupMemberships(
          toolArgs.group_id,
          toolArgs.per_page || 100
        );
        break;
      }
      case "add_person_to_group": {
        result = await pco.addPersonToGroup(
          toolArgs.group_id,
          toolArgs.person_id,
          toolArgs.role || "member"
        );
        break;
      }
      case "remove_person_from_group": {
        result = await pco.removePersonFromGroup(
          toolArgs.group_id,
          toolArgs.membership_id
        );
        break;
      }
      default: {
        throw new Error(`Unknown tool: ${toolName}`);
      }
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
  // Test connection
  try {
    const groups = await pco.listGroups(1);
    console.error(`✓ Connected to Planning Center. Found groups.`);
  } catch (error) {
    console.error(`✗ Connection failed: ${error}`);
    process.exit(1);
  }

  // Start MCP server
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Planning Center MCP server running on stdio");
}

main().catch(console.error);
