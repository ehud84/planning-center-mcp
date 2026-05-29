#!/usr/bin/env python3
"""
Planning Center MCP server.

Exposes a small set of Planning Center Online tools over MCP using the stable
FastMCP APIs from mcp==1.27.1. The server supports local stdio clients and
hosted Streamable HTTP clients at /mcp, with /health exposed as an SDK custom
route for platform health checks.
"""

from __future__ import annotations

import logging
import os
import secrets
from typing import Annotated, Any, Literal, cast

import httpx
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

Transport = Literal["stdio", "streamable-http"]
ServiceName = Literal["groups", "people"]
GroupRole = Literal["member", "leader"]
JsonObject = dict[str, Any]

LOGGER = logging.getLogger("planning_center_mcp")

VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
VALID_TRANSPORTS: set[str] = {"stdio", "streamable-http"}

PCO_API_ROOT = os.getenv("PCO_API_ROOT", "https://api.planningcenteronline.com").rstrip("/")
PCO_GROUPS_API_BASE = os.getenv("PCO_GROUPS_API_BASE", f"{PCO_API_ROOT}/groups/v2").rstrip("/")
PCO_PEOPLE_API_BASE = os.getenv("PCO_PEOPLE_API_BASE", f"{PCO_API_ROOT}/people/v2").rstrip("/")
PCO_SERVICE_BASE_URLS: dict[ServiceName, str] = {
    "groups": PCO_GROUPS_API_BASE,
    "people": PCO_PEOPLE_API_BASE,
}


class StaticBearerTokenVerifier:
    """FastMCP token verifier for an optional shared bearer token."""

    def __init__(self, expected_token: str) -> None:
        self._expected_token = expected_token

    async def verify_token(self, token: str) -> AccessToken | None:
        if not secrets.compare_digest(token, self._expected_token):
            return None

        return AccessToken(
            token=token,
            client_id="static-bearer-token",
            scopes=["mcp"],
        )


def _server_host() -> str:
    return os.getenv("UVICORN_HOST", "0.0.0.0")


def _server_port() -> int:
    raw_port = os.getenv("PORT") or os.getenv("UVICORN_PORT") or "8000"
    try:
        return int(raw_port)
    except ValueError as exc:
        raise ValueError(f"Invalid port value: {raw_port!r}") from exc


def _log_level() -> Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]:
    level = (os.getenv("MCP_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "INFO").upper()
    if level not in VALID_LOG_LEVELS:
        LOGGER.warning("Invalid log level %r; defaulting to INFO", level)
        level = "INFO"
    return cast(Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"], level)


def _public_url() -> str:
    """Return the public base URL used in auth metadata when auth is enabled."""
    configured_url = (
        os.getenv("MCP_PUBLIC_URL")
        or os.getenv("RAILWAY_PUBLIC_DOMAIN")
        or os.getenv("RAILWAY_STATIC_URL")
    )
    if configured_url:
        configured_url = configured_url.strip().rstrip("/")
        if configured_url.endswith("/mcp"):
            configured_url = configured_url.removesuffix("/mcp")
        if "://" not in configured_url:
            configured_url = f"https://{configured_url}"
        return configured_url

    return f"http://localhost:{_server_port()}"


def _token_verifier() -> StaticBearerTokenVerifier | None:
    token = os.getenv("MCP_BEARER_TOKEN", "").strip()
    if not token:
        return None
    return StaticBearerTokenVerifier(token)


def _auth_settings(enabled: bool) -> AuthSettings | None:
    if not enabled:
        return None

    public_url = _public_url()
    return AuthSettings(
        issuer_url=public_url,
        resource_server_url=public_url,
        required_scopes=["mcp"],
    )


def _select_transport() -> Transport:
    transport = os.getenv("MCP_TRANSPORT", "").strip().lower()

    if not transport:
        # Prefer hosted HTTP when Railway-style env vars are present; otherwise
        # default to stdio for direct local MCP clients such as Claude Desktop.
        transport = (
            "streamable-http"
            if any(
                os.getenv(name)
                for name in (
                    "PORT",
                    "UVICORN_PORT",
                    "RAILWAY_ENVIRONMENT",
                    "RAILWAY_PUBLIC_DOMAIN",
                )
            )
            else "stdio"
        )

    aliases = {
        "http": "streamable-http",
        "streamable_http": "streamable-http",
        "streamable": "streamable-http",
    }
    transport = aliases.get(transport, transport)

    if transport not in VALID_TRANSPORTS:
        raise ValueError(
            f"Unsupported MCP_TRANSPORT={transport!r}; expected one of: "
            f"{', '.join(sorted(VALID_TRANSPORTS))}"
        )

    return cast(Transport, transport)


_TOKEN_VERIFIER = _token_verifier()

mcp = FastMCP(
    "planning_center_mcp",
    instructions=(
        "Tools for listing, searching, and managing Planning Center Online "
        "Groups and People records."
    ),
    host=_server_host(),
    port=_server_port(),
    log_level=_log_level(),
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
    token_verifier=_TOKEN_VERIFIER,
    auth=_auth_settings(_TOKEN_VERIFIER is not None),
)

READ_ONLY = ToolAnnotations(
    readOnlyHint=True,
    destructiveHint=False,
    idempotentHint=True,
    openWorldHint=True,
)
WRITE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=False,
    idempotentHint=False,
    openWorldHint=True,
)
DESTRUCTIVE = ToolAnnotations(
    readOnlyHint=False,
    destructiveHint=True,
    idempotentHint=False,
    openWorldHint=True,
)


@mcp.custom_route("/health", methods=["GET"], include_in_schema=False)
async def health_check(request: Request) -> Response:
    """Health check endpoint for hosted deployments."""
    return JSONResponse({"status": "ok"})


def _pco_credentials() -> tuple[str, str]:
    client_id = os.getenv("PCO_CLIENT_ID", "").strip()
    client_secret = os.getenv("PCO_CLIENT_SECRET", "").strip()

    if not client_id or not client_secret:
        raise RuntimeError(
            "Planning Center credentials are not configured. Set PCO_CLIENT_ID "
            "and PCO_CLIENT_SECRET in the server environment."
        )

    return client_id, client_secret


def _clean_params(params: dict[str, Any] | None) -> dict[str, Any] | None:
    if not params:
        return None
    return {key: value for key, value in params.items() if value is not None}


def _format_api_error(error: httpx.HTTPStatusError) -> str:
    status_code = error.response.status_code
    messages = {
        400: "Planning Center rejected the request",
        401: "Planning Center authentication failed; check PCO_CLIENT_ID and PCO_CLIENT_SECRET",
        403: "Planning Center denied access to this resource",
        404: "Planning Center resource not found; check the supplied ID",
        429: "Planning Center rate limit exceeded; wait before retrying",
    }
    message = messages.get(status_code, f"Planning Center API request failed with status {status_code}")

    details: list[str] = []
    try:
        payload = error.response.json()
    except ValueError:
        payload = None

    if isinstance(payload, dict):
        errors = payload.get("errors")
        if isinstance(errors, list):
            for item in errors[:3]:
                if isinstance(item, dict):
                    detail = item.get("detail") or item.get("title")
                    if detail:
                        details.append(str(detail))

    if details:
        return f"{message}: {'; '.join(details)}"
    return message


async def _api_request(
    service: ServiceName,
    endpoint: str,
    *,
    method: str = "GET",
    json_data: JsonObject | None = None,
    params: dict[str, Any] | None = None,
) -> JsonObject:
    """Make an authenticated Planning Center API request."""
    client_id, client_secret = _pco_credentials()
    base_url = PCO_SERVICE_BASE_URLS[service]

    async with httpx.AsyncClient(
        auth=(client_id, client_secret),
        base_url=base_url,
        timeout=httpx.Timeout(30.0),
        headers={"User-Agent": "planning-center-mcp/1.0"},
    ) as client:
        try:
            response = await client.request(
                method,
                endpoint.lstrip("/"),
                json=json_data,
                params=_clean_params(params),
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(_format_api_error(exc)) from exc
        except httpx.TimeoutException as exc:
            raise RuntimeError("Planning Center API request timed out") from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"Planning Center API request failed: {exc}") from exc

    if response.status_code == 204 or not response.content:
        return {}

    try:
        payload = response.json()
    except ValueError as exc:
        raise RuntimeError("Planning Center API returned a non-JSON response") from exc

    if not isinstance(payload, dict):
        raise RuntimeError("Planning Center API returned an unexpected JSON payload")

    return payload


def _attributes(record: JsonObject) -> JsonObject:
    attributes = record.get("attributes")
    return attributes if isinstance(attributes, dict) else {}


def _relationships(record: JsonObject) -> JsonObject:
    relationships = record.get("relationships")
    return relationships if isinstance(relationships, dict) else {}


def _relationship_id(record: JsonObject, relationship_name: str) -> str | None:
    relationship = _relationships(record).get(relationship_name)
    if not isinstance(relationship, dict):
        return None

    data = relationship.get("data")
    if isinstance(data, dict):
        value = data.get("id")
        return str(value) if value is not None else None
    return None


def _collection_response(source: JsonObject, key: str, items: list[JsonObject]) -> JsonObject:
    meta = source.get("meta") if isinstance(source.get("meta"), dict) else {}
    links = source.get("links") if isinstance(source.get("links"), dict) else {}

    return {
        key: items,
        "count": len(items),
        "total": meta.get("total_count", len(items)),
        "meta": meta,
        "links": links,
    }


def _group_summary(group: JsonObject) -> JsonObject:
    attrs = _attributes(group)
    return {
        "id": group.get("id"),
        "type": group.get("type"),
        "name": attrs.get("name"),
        "members_are_confidential": attrs.get("members_are_confidential"),
        "listed": attrs.get("listed"),
        "group_type_id": _relationship_id(group, "group_type"),
        "attributes": attrs,
    }


def _group_type_summary(group_type: JsonObject) -> JsonObject:
    attrs = _attributes(group_type)
    return {
        "id": group_type.get("id"),
        "type": group_type.get("type"),
        "name": attrs.get("name"),
        "attributes": attrs,
    }


def _person_summary(person: JsonObject) -> JsonObject:
    attrs = _attributes(person)
    first_name = attrs.get("first_name")
    last_name = attrs.get("last_name")
    name = attrs.get("name") or " ".join(part for part in (first_name, last_name) if part)

    return {
        "id": person.get("id"),
        "type": person.get("type"),
        "name": name or None,
        "first_name": first_name,
        "last_name": last_name,
        "attributes": attrs,
    }


def _membership_summary(membership: JsonObject) -> JsonObject:
    attrs = _attributes(membership)
    return {
        "id": membership.get("id"),
        "type": membership.get("type"),
        "role": attrs.get("role"),
        "person_id": _relationship_id(membership, "person"),
        "attributes": attrs,
    }


@mcp.tool(title="List Groups", annotations=READ_ONLY, structured_output=True)
async def pco_list_groups(
    per_page: Annotated[
        int,
        Field(description="Number of groups to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List Planning Center Groups."""
    data = await _api_request("groups", "groups", params={"per_page": per_page})
    groups = [_group_summary(group) for group in data.get("data", []) if isinstance(group, dict)]
    return _collection_response(data, "groups", groups)


@mcp.tool(title="Get Group", annotations=READ_ONLY, structured_output=True)
async def pco_get_group(
    group_id: Annotated[str, Field(description="Planning Center group ID", min_length=1)],
) -> dict[str, Any]:
    """Get one Planning Center Group by ID."""
    data = await _api_request("groups", f"groups/{group_id}")
    group = data.get("data") if isinstance(data.get("data"), dict) else {}
    return {
        "group": _group_summary(group),
        "included": data.get("included", []),
        "meta": data.get("meta", {}),
    }


@mcp.tool(title="List Group Types", annotations=READ_ONLY, structured_output=True)
async def pco_get_group_types(
    per_page: Annotated[
        int,
        Field(description="Number of group types to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List available Planning Center Group Types."""
    data = await _api_request("groups", "group_types", params={"per_page": per_page})
    group_types = [
        _group_type_summary(group_type)
        for group_type in data.get("data", [])
        if isinstance(group_type, dict)
    ]
    return _collection_response(data, "group_types", group_types)


@mcp.tool(title="Create Group", annotations=WRITE, structured_output=True)
async def pco_create_group(
    name: Annotated[str, Field(description="Name of the group to create", min_length=1, max_length=100)],
    group_type_id: Annotated[
        str | None,
        Field(description="Optional Planning Center Group Type ID", min_length=1),
    ] = None,
    members_confidential: Annotated[
        bool,
        Field(description="Whether group membership should be confidential"),
    ] = True,
    listed: Annotated[bool, Field(description="Whether the group should be publicly listed")] = False,
) -> dict[str, Any]:
    """Create a Planning Center Group."""
    payload: JsonObject = {
        "data": {
            "type": "Group",
            "attributes": {
                "name": name,
                "members_are_confidential": members_confidential,
                "listed": listed,
            },
        }
    }

    if group_type_id:
        payload["data"]["relationships"] = {
            "group_type": {
                "data": {
                    "type": "GroupType",
                    "id": group_type_id,
                }
            }
        }

    data = await _api_request("groups", "groups", method="POST", json_data=payload)
    group = data.get("data") if isinstance(data.get("data"), dict) else {}
    return {
        "created": True,
        "group": _group_summary(group),
        "meta": data.get("meta", {}),
    }


@mcp.tool(title="List People", annotations=READ_ONLY, structured_output=True)
async def pco_list_people(
    per_page: Annotated[
        int,
        Field(description="Number of people to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List Planning Center People."""
    data = await _api_request("people", "people", params={"per_page": per_page})
    people = [_person_summary(person) for person in data.get("data", []) if isinstance(person, dict)]
    return _collection_response(data, "people", people)


@mcp.tool(title="Search People", annotations=READ_ONLY, structured_output=True)
async def pco_search_people(
    first_name: Annotated[
        str | None,
        Field(description="First name or partial first name to search for", min_length=1),
    ] = None,
    last_name: Annotated[
        str | None,
        Field(description="Last name or partial last name to search for", min_length=1),
    ] = None,
    per_page: Annotated[
        int,
        Field(description="Maximum number of matching people to return (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """Search Planning Center People by name."""
    if not first_name and not last_name:
        raise ValueError("Provide at least one of first_name or last_name")

    search_name = " ".join(part for part in (first_name, last_name) if part)
    data = await _api_request(
        "people",
        "people",
        params={"where[search_name]": search_name, "per_page": per_page},
    )

    people = [_person_summary(person) for person in data.get("data", []) if isinstance(person, dict)]

    # Keep the tool semantics explicit even if Planning Center's search endpoint
    # returns broader matches for a given search_name query.
    filtered_people: list[JsonObject] = []
    for person in people:
        person_first_name = (person.get("first_name") or "").lower()
        person_last_name = (person.get("last_name") or "").lower()

        if first_name and first_name.lower() not in person_first_name:
            continue
        if last_name and last_name.lower() not in person_last_name:
            continue
        filtered_people.append(person)

    response = _collection_response(data, "people", filtered_people)
    response["query"] = {"first_name": first_name, "last_name": last_name}
    return response


@mcp.tool(title="Get Group Memberships", annotations=READ_ONLY, structured_output=True)
async def pco_get_group_memberships(
    group_id: Annotated[str, Field(description="Planning Center group ID", min_length=1)],
    per_page: Annotated[
        int,
        Field(description="Number of memberships to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List memberships for a Planning Center Group."""
    data = await _api_request(
        "groups",
        f"groups/{group_id}/memberships",
        params={"per_page": per_page},
    )
    memberships = [
        _membership_summary(membership)
        for membership in data.get("data", [])
        if isinstance(membership, dict)
    ]
    response = _collection_response(data, "memberships", memberships)
    response["group_id"] = group_id
    return response


@mcp.tool(title="Add Person to Group", annotations=WRITE, structured_output=True)
async def pco_add_person_to_group(
    group_id: Annotated[str, Field(description="Planning Center group ID", min_length=1)],
    person_id: Annotated[str, Field(description="Planning Center person ID", min_length=1)],
    role: Annotated[GroupRole, Field(description="Membership role to assign")] = "member",
) -> dict[str, Any]:
    """Add a Planning Center Person to a Group."""
    payload: JsonObject = {
        "data": {
            "type": "Membership",
            "attributes": {"role": role},
            "relationships": {
                "person": {
                    "data": {
                        "type": "Person",
                        "id": person_id,
                    }
                }
            },
        }
    }

    data = await _api_request(
        "groups",
        f"groups/{group_id}/memberships",
        method="POST",
        json_data=payload,
    )
    membership = data.get("data") if isinstance(data.get("data"), dict) else {}
    return {
        "added": True,
        "group_id": group_id,
        "person_id": person_id,
        "membership": _membership_summary(membership),
        "meta": data.get("meta", {}),
    }


@mcp.tool(title="Remove Person from Group", annotations=DESTRUCTIVE, structured_output=True)
async def pco_remove_person_from_group(
    group_id: Annotated[str, Field(description="Planning Center group ID", min_length=1)],
    membership_id: Annotated[str, Field(description="Planning Center membership ID", min_length=1)],
) -> dict[str, Any]:
    """Remove a membership from a Planning Center Group."""
    await _api_request(
        "groups",
        f"groups/{group_id}/memberships/{membership_id}",
        method="DELETE",
    )
    return {
        "removed": True,
        "group_id": group_id,
        "membership_id": membership_id,
    }


def main() -> None:
    logging.basicConfig(
        level=_log_level(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    transport = _select_transport()
    LOGGER.info(
        "Starting Planning Center MCP server transport=%s host=%s port=%s pco_configured=%s bearer_auth=%s",
        transport,
        mcp.settings.host,
        mcp.settings.port,
        bool(os.getenv("PCO_CLIENT_ID") and os.getenv("PCO_CLIENT_SECRET")),
        _TOKEN_VERIFIER is not None,
    )

    mcp.run(transport=transport)


if __name__ == "__main__":
    main()
