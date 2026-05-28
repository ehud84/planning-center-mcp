#!/usr/bin/env python3
"""
MCP Server for Planning Center Online API.

Provides tools to interact with Planning Center, including group management,
people search, and membership operations.
"""

import os
import json
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict
from mcp.server.fastmcp import FastMCP
import httpx

# Initialize the MCP server
mcp = FastMCP("planning_center_mcp")

# Configuration from environment
PCO_CLIENT_ID = os.getenv("PCO_CLIENT_ID", "")
PCO_CLIENT_SECRET = os.getenv("PCO_CLIENT_SECRET", "")
PCO_API_BASE = "https://api.planningcenteronline.com/v2"

# Validate credentials on startup
if not PCO_CLIENT_ID or not PCO_CLIENT_SECRET:
    raise ValueError("PCO_CLIENT_ID and PCO_CLIENT_SECRET environment variables are required")


# Pydantic Models for Input Validation
class ListGroupsInput(BaseModel):
    """Input for listing groups."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    per_page: Optional[int] = Field(
        default=100,
        description="Number of results per page",
        ge=1,
        le=100
    )


class GetGroupInput(BaseModel):
    """Input for getting a specific group."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    group_id: str = Field(..., description="The Planning Center group ID", min_length=1)


class CreateGroupInput(BaseModel):
    """Input for creating a new group."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    name: str = Field(..., description="Name of the group", min_length=1, max_length=100)
    group_type_id: Optional[str] = Field(
        default=None,
        description="Group type ID (optional)"
    )
    members_confidential: Optional[bool] = Field(
        default=True,
        description="Whether group members are confidential"
    )
    listed: Optional[bool] = Field(
        default=False,
        description="Whether the group is listed"
    )


class ListPeopleInput(BaseModel):
    """Input for listing people."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    per_page: Optional[int] = Field(
        default=100,
        description="Number of results per page",
        ge=1,
        le=100
    )


class SearchPeopleInput(BaseModel):
    """Input for searching people by name."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    first_name: Optional[str] = Field(
        default=None,
        description="First name to search for"
    )
    last_name: Optional[str] = Field(
        default=None,
        description="Last name to search for"
    )


class GetGroupMembershipsInput(BaseModel):
    """Input for getting group members."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    group_id: str = Field(..., description="The Planning Center group ID", min_length=1)
    per_page: Optional[int] = Field(
        default=100,
        description="Number of results per page",
        ge=1,
        le=100
    )


class AddPersonToGroupInput(BaseModel):
    """Input for adding a person to a group."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    group_id: str = Field(..., description="The Planning Center group ID", min_length=1)
    person_id: str = Field(..., description="The Planning Center person ID", min_length=1)
    role: Optional[str] = Field(
        default="member",
        description="Role in the group (member or leader)"
    )


class RemovePersonFromGroupInput(BaseModel):
    """Input for removing a person from a group."""
    model_config = ConfigDict(str_strip_whitespace=True, validate_assignment=True)

    group_id: str = Field(..., description="The Planning Center group ID", min_length=1)
    membership_id: str = Field(..., description="The membership ID to remove", min_length=1)


# Shared API client
async def _api_request(
    endpoint: str,
    method: str = "GET",
    json_data: Optional[Dict[str, Any]] = None,
    params: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Make an authenticated request to the Planning Center API."""
    async with httpx.AsyncClient(auth=(PCO_CLIENT_ID, PCO_CLIENT_SECRET)) as client:
        response = await client.request(
            method,
            f"{PCO_API_BASE}/{endpoint}",
            json=json_data,
            params=params,
            timeout=30.0,
            headers={"User-Agent": "Planning Center MCP"}
        )
        response.raise_for_status()
        return response.json()


def _handle_error(error: Exception) -> str:
    """Format error messages consistently."""
    if isinstance(error, httpx.HTTPStatusError):
        if error.response.status_code == 404:
            return "Error: Resource not found. Please check the ID is correct."
        elif error.response.status_code == 403:
            return "Error: Permission denied. You don't have access to this resource."
        elif error.response.status_code == 401:
            return "Error: Authentication failed. Please check your Planning Center credentials."
        elif error.response.status_code == 429:
            return "Error: Rate limit exceeded. Please wait before making more requests."
        return f"Error: API request failed with status {error.response.status_code}"
    elif isinstance(error, httpx.TimeoutException):
        return "Error: Request timed out. Please try again."
    return f"Error: {str(error)}"


# Tool definitions
@mcp.tool(
    name="pco_list_groups",
    annotations={
        "title": "List Groups",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def list_groups(params: ListGroupsInput) -> str:
    """List all groups in Planning Center.

    This tool retrieves a list of all groups in your Planning Center account.

    Args:
        params (ListGroupsInput): Request parameters including:
            - per_page (Optional[int]): Number of results per page (1-100, default: 100)

    Returns:
        str: JSON-formatted string containing group list with schema:
        {
            "groups": [
                {
                    "id": str,
                    "name": str,
                    "members_are_confidential": bool,
                    "listed": bool
                }
            ],
            "total": int,
            "count": int
        }
    """
    try:
        data = await _api_request(
            "groups",
            params={"per_page": params.per_page}
        )

        groups = data.get("data", [])
        response = {
            "groups": [
                {
                    "id": g.get("id"),
                    "name": g.get("attributes", {}).get("name"),
                    "members_are_confidential": g.get("attributes", {}).get("members_are_confidential"),
                    "listed": g.get("attributes", {}).get("listed")
                }
                for g in groups
            ],
            "total": len(groups),
            "count": len(groups)
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_get_group",
    annotations={
        "title": "Get Group",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def get_group(params: GetGroupInput) -> str:
    """Get details of a specific group.

    Args:
        params (GetGroupInput): Request parameters including:
            - group_id (str): The Planning Center group ID

    Returns:
        str: JSON-formatted group details
    """
    try:
        data = await _api_request(f"groups/{params.group_id}")
        group = data.get("data", {})

        response = {
            "id": group.get("id"),
            "name": group.get("attributes", {}).get("name"),
            "members_are_confidential": group.get("attributes", {}).get("members_are_confidential"),
            "listed": group.get("attributes", {}).get("listed")
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_get_group_types",
    annotations={
        "title": "Get Group Types",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def get_group_types() -> str:
    """Get all available group types in Planning Center.

    Returns:
        str: JSON-formatted list of group types
    """
    try:
        data = await _api_request("group_types")
        group_types = data.get("data", [])

        response = {
            "group_types": [
                {
                    "id": gt.get("id"),
                    "name": gt.get("attributes", {}).get("name")
                }
                for gt in group_types
            ],
            "total": len(group_types)
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_create_group",
    annotations={
        "title": "Create Group",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False
    }
)
async def create_group(params: CreateGroupInput) -> str:
    """Create a new group in Planning Center.

    Args:
        params (CreateGroupInput): Group creation parameters

    Returns:
        str: JSON-formatted response with created group details
    """
    try:
        payload = {
            "data": {
                "type": "Group",
                "attributes": {
                    "name": params.name,
                    "members_are_confidential": params.members_confidential,
                    "listed": params.listed
                }
            }
        }

        if params.group_type_id:
            payload["data"]["relationships"] = {
                "group_type": {
                    "data": {
                        "type": "GroupType",
                        "id": params.group_type_id
                    }
                }
            }

        data = await _api_request("groups", method="POST", json_data=payload)
        group = data.get("data", {})

        response = {
            "id": group.get("id"),
            "name": group.get("attributes", {}).get("name"),
            "created": True
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_list_people",
    annotations={
        "title": "List People",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def list_people(params: ListPeopleInput) -> str:
    """List all people in Planning Center.

    Args:
        params (ListPeopleInput): Request parameters

    Returns:
        str: JSON-formatted list of people
    """
    try:
        data = await _api_request(
            "people",
            params={"per_page": params.per_page}
        )

        people = data.get("data", [])
        response = {
            "people": [
                {
                    "id": p.get("id"),
                    "first_name": p.get("attributes", {}).get("first_name"),
                    "last_name": p.get("attributes", {}).get("last_name")
                }
                for p in people
            ],
            "total": len(people),
            "count": len(people)
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_search_people",
    annotations={
        "title": "Search People",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def search_people(params: SearchPeopleInput) -> str:
    """Search for people by name in Planning Center.

    Args:
        params (SearchPeopleInput): Search parameters

    Returns:
        str: JSON-formatted search results
    """
    try:
        data = await _api_request("people", params={"per_page": 1000})
        all_people = data.get("data", [])

        # Filter results
        results = []
        for person in all_people:
            attrs = person.get("attributes", {})
            first = (attrs.get("first_name") or "").lower()
            last = (attrs.get("last_name") or "").lower()

            match = True
            if params.first_name and params.first_name.lower() not in first:
                match = False
            if params.last_name and params.last_name.lower() not in last:
                match = False

            if match:
                results.append({
                    "id": person.get("id"),
                    "first_name": attrs.get("first_name"),
                    "last_name": attrs.get("last_name")
                })

        response = {
            "results": results,
            "total": len(results),
            "count": len(results)
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_get_group_memberships",
    annotations={
        "title": "Get Group Memberships",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False
    }
)
async def get_group_memberships(params: GetGroupMembershipsInput) -> str:
    """Get all members of a specific group.

    Args:
        params (GetGroupMembershipsInput): Request parameters

    Returns:
        str: JSON-formatted list of group members
    """
    try:
        data = await _api_request(
            f"groups/{params.group_id}/memberships",
            params={"per_page": params.per_page}
        )

        memberships = data.get("data", [])
        response = {
            "memberships": [
                {
                    "id": m.get("id"),
                    "role": m.get("attributes", {}).get("role"),
                    "person_id": m.get("relationships", {}).get("person", {}).get("data", {}).get("id")
                }
                for m in memberships
            ],
            "total": len(memberships),
            "count": len(memberships)
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_add_person_to_group",
    annotations={
        "title": "Add Person to Group",
        "readOnlyHint": False,
        "destructiveHint": False,
        "idempotentHint": False,
        "openWorldHint": False
    }
)
async def add_person_to_group(params: AddPersonToGroupInput) -> str:
    """Add a person to a group in Planning Center.

    Args:
        params (AddPersonToGroupInput): Parameters for adding person to group

    Returns:
        str: JSON-formatted response confirming the addition
    """
    try:
        payload = {
            "data": {
                "type": "Membership",
                "attributes": {
                    "role": params.role
                },
                "relationships": {
                    "person": {
                        "data": {
                            "type": "Person",
                            "id": params.person_id
                        }
                    }
                }
            }
        }

        data = await _api_request(
            f"groups/{params.group_id}/memberships",
            method="POST",
            json_data=payload
        )

        membership = data.get("data", {})
        response = {
            "membership_id": membership.get("id"),
            "person_id": params.person_id,
            "group_id": params.group_id,
            "role": params.role,
            "added": True
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


@mcp.tool(
    name="pco_remove_person_from_group",
    annotations={
        "title": "Remove Person from Group",
        "readOnlyHint": False,
        "destructiveHint": True,
        "idempotentHint": False,
        "openWorldHint": False
    }
)
async def remove_person_from_group(params: RemovePersonFromGroupInput) -> str:
    """Remove a person from a group in Planning Center.

    Args:
        params (RemovePersonFromGroupInput): Parameters for removing person from group

    Returns:
        str: JSON-formatted response confirming the removal
    """
    try:
        await _api_request(
            f"groups/{params.group_id}/memberships/{params.membership_id}",
            method="DELETE"
        )

        response = {
            "membership_id": params.membership_id,
            "group_id": params.group_id,
            "removed": True
        }
        return json.dumps(response, indent=2)
    except Exception as e:
        return _handle_error(e)


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    mcp.run(transport="sse", host="0.0.0.0", port=port)
