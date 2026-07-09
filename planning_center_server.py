#!/usr/bin/env python3
"""
Planning Center MCP server.

Exposes a small set of Planning Center Online tools over MCP using the stable
FastMCP APIs from mcp==1.27.1. The server supports local stdio clients and
hosted Streamable HTTP clients at /mcp, with /health exposed as an SDK custom
route for platform health checks.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone
from typing import Annotated, Any, Literal, cast
from urllib.parse import parse_qs, urlencode

import httpx
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import Field
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

Transport = Literal["stdio", "streamable-http"]
ServiceName = Literal["groups", "people", "services", "calendar"]
GroupRole = Literal["member", "leader"]
PlanTimeFilter = Literal["future", "past"]
ConflictStatus = Literal["resolved", "unresolved", "future"]
JsonObject = dict[str, Any]

LOGGER = logging.getLogger("planning_center_mcp")

VALID_LOG_LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
VALID_TRANSPORTS: set[str] = {"stdio", "streamable-http"}

PCO_API_ROOT = os.getenv("PCO_API_ROOT", "https://api.planningcenteronline.com").rstrip("/")
PCO_GROUPS_API_BASE = os.getenv("PCO_GROUPS_API_BASE", f"{PCO_API_ROOT}/groups/v2").rstrip("/")
PCO_PEOPLE_API_BASE = os.getenv("PCO_PEOPLE_API_BASE", f"{PCO_API_ROOT}/people/v2").rstrip("/")
PCO_SERVICES_API_BASE = os.getenv("PCO_SERVICES_API_BASE", f"{PCO_API_ROOT}/services/v2").rstrip("/")
PCO_CALENDAR_API_BASE = os.getenv("PCO_CALENDAR_API_BASE", f"{PCO_API_ROOT}/calendar/v2").rstrip("/")
PCO_SERVICE_BASE_URLS: dict[ServiceName, str] = {
    "groups": PCO_GROUPS_API_BASE,
    "people": PCO_PEOPLE_API_BASE,
    "services": PCO_SERVICES_API_BASE,
    "calendar": PCO_CALENDAR_API_BASE,
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
        "Groups, People, and Services (service plans, teams, and scheduling) records."
    ),
    host=_server_host(),
    port=_server_port(),
    log_level=_log_level(),
    streamable_http_path="/mcp",
    stateless_http=True,
    json_response=True,
    # Built-in auth is intentionally disabled so FastMCP's OAuth resource-server
    # routes do not collide with the connector OAuth handshake defined below.
    # Access to /mcp is enforced by _guard_mcp_endpoint() at serve time, which
    # accepts the tokens that handshake issues (and MCP_BEARER_TOKEN if set).
    token_verifier=None,
    auth=None,
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


# ---------------------------------------------------------------------------
# OAuth compatibility layer
#
# Cowork's custom-connector sign-in performs OAuth 2.0 dynamic client
# registration followed by an authorization-code exchange before it will
# connect to an MCP server. FastMCP does not expose those endpoints on its own,
# so we provide a lightweight in-memory implementation here to satisfy the
# connector handshake. The /mcp endpoint is already open, so these routes exist
# to complete the sign-in flow rather than to gate access. State is in-memory
# and intentionally resets on redeploy.
# ---------------------------------------------------------------------------
_oauth_codes: dict[str, dict[str, Any]] = {}
_oauth_tokens: dict[str, dict[str, Any]] = {}
_oauth_clients: dict[str, dict[str, Any]] = {}


def _oauth_base_url(request: Request) -> str:
    """Public base URL for OAuth metadata, honoring the Railway TLS proxy."""
    scheme = request.headers.get("x-forwarded-proto", "https")
    host = request.headers.get("host", "localhost:8000")
    return f"{scheme}://{host}"


@mcp.custom_route(
    "/.well-known/oauth-authorization-server", methods=["GET"], include_in_schema=False
)
async def oauth_authorization_server_metadata(request: Request) -> Response:
    base_url = _oauth_base_url(request)
    return JSONResponse(
        {
            "issuer": base_url,
            "authorization_endpoint": f"{base_url}/authorize",
            "token_endpoint": f"{base_url}/token",
            "registration_endpoint": f"{base_url}/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": [
                "client_secret_basic",
                "client_secret_post",
                "none",
            ],
        }
    )


@mcp.custom_route(
    "/.well-known/oauth-protected-resource", methods=["GET"], include_in_schema=False
)
async def oauth_protected_resource_metadata(request: Request) -> Response:
    base_url = _oauth_base_url(request)
    return JSONResponse(
        {
            "resource": base_url,
            "authorization_servers": [base_url],
        }
    )


@mcp.custom_route("/register", methods=["POST"], include_in_schema=False)
async def oauth_register(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - tolerate any malformed/empty body
        body = {}
    if not isinstance(body, dict):
        body = {}

    client_id = secrets.token_urlsafe(16)
    client_secret = secrets.token_urlsafe(32)
    _oauth_clients[client_id] = {
        "client_secret": client_secret,
        "registered_at": time.time(),
        "redirect_uris": body.get("redirect_uris", []),
    }
    return JSONResponse(
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "client_id_issued_at": int(time.time()),
            "client_secret_expires_at": 0,
            "redirect_uris": body.get("redirect_uris", []),
            "token_endpoint_auth_method": body.get(
                "token_endpoint_auth_method", "client_secret_post"
            ),
        },
        status_code=201,
    )


@mcp.custom_route("/authorize", methods=["GET"], include_in_schema=False)
async def oauth_authorize(request: Request) -> Response:
    params = request.query_params
    redirect_uri = params.get("redirect_uri", "")
    state = params.get("state", "")
    code_challenge = params.get("code_challenge", "")

    if not redirect_uri:
        return JSONResponse(
            {"error": "invalid_request", "error_description": "redirect_uri is required"},
            status_code=400,
        )

    auth_code = secrets.token_urlsafe(32)
    _oauth_codes[auth_code] = {
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
        "created_at": time.time(),
    }

    redirect_params = {"code": auth_code}
    if state:
        redirect_params["state"] = state
    separator = "&" if "?" in redirect_uri else "?"
    location = f"{redirect_uri}{separator}{urlencode(redirect_params)}"
    return RedirectResponse(url=location, status_code=302)


@mcp.custom_route("/token", methods=["POST"], include_in_schema=False)
async def oauth_token(request: Request) -> Response:
    raw_body = (await request.body()).decode("utf-8", errors="ignore")
    form = parse_qs(raw_body)
    code = form.get("code", [""])[0]

    if not code or code not in _oauth_codes:
        return JSONResponse({"error": "invalid_grant"}, status_code=400)

    _oauth_codes.pop(code, None)
    access_token = secrets.token_urlsafe(32)
    _oauth_tokens[access_token] = {"created_at": time.time()}
    return JSONResponse(
        {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
        }
    )


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


def _service_type_summary(service_type: JsonObject) -> JsonObject:
    attrs = _attributes(service_type)
    return {
        "id": service_type.get("id"),
        "type": service_type.get("type"),
        "name": attrs.get("name"),
        "frequency": attrs.get("frequency"),
        "sequence": attrs.get("sequence"),
        "attributes": attrs,
    }


def _plan_summary(plan: JsonObject) -> JsonObject:
    attrs = _attributes(plan)
    return {
        "id": plan.get("id"),
        "type": plan.get("type"),
        "title": attrs.get("title"),
        "dates": attrs.get("dates"),
        "short_dates": attrs.get("short_dates"),
        "sort_date": attrs.get("sort_date"),
        "series_title": attrs.get("series_title"),
        "plan_people_count": attrs.get("plan_people_count"),
        "needed_positions_count": attrs.get("needed_positions_count"),
        "service_type_id": _relationship_id(plan, "service_type"),
        "attributes": attrs,
    }


def _team_summary(team: JsonObject) -> JsonObject:
    attrs = _attributes(team)
    return {
        "id": team.get("id"),
        "type": team.get("type"),
        "name": attrs.get("name"),
        "schedule_to": attrs.get("schedule_to"),
        "sequence": attrs.get("sequence"),
        "default_status": attrs.get("default_status"),
        "service_type_id": _relationship_id(team, "service_type"),
        "attributes": attrs,
    }


def _team_position_summary(position: JsonObject) -> JsonObject:
    attrs = _attributes(position)
    return {
        "id": position.get("id"),
        "type": position.get("type"),
        "name": attrs.get("name"),
        "sequence": attrs.get("sequence"),
        "team_id": _relationship_id(position, "team"),
        "attributes": attrs,
    }


# Planning Center encodes a scheduled person's response as a single letter.
_SCHEDULE_STATUS_LABELS: dict[str, str] = {
    "C": "Confirmed",
    "U": "Unconfirmed",
    "D": "Declined",
}


def _scheduled_person_summary(plan_person: JsonObject) -> JsonObject:
    attrs = _attributes(plan_person)
    status = attrs.get("status")
    status_label = _SCHEDULE_STATUS_LABELS.get(status, status) if isinstance(status, str) else status
    return {
        "id": plan_person.get("id"),
        "type": plan_person.get("type"),
        "name": attrs.get("name"),
        "status": status,
        "status_label": status_label,
        "team_position_name": attrs.get("team_position_name"),
        "decline_reason": attrs.get("decline_reason"),
        "notes": attrs.get("notes"),
        "person_id": _relationship_id(plan_person, "person"),
        "team_id": _relationship_id(plan_person, "team"),
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


@mcp.tool(title="List Service Types", annotations=READ_ONLY, structured_output=True)
async def pco_list_service_types(
    per_page: Annotated[
        int,
        Field(description="Number of service types to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List Planning Center Services service types.

    Service types are the top-level categories that contain plans (for example
    "Sunday Mornings" or "Youth Service"). Use the returned id with pco_list_plans
    and pco_list_teams.
    """
    data = await _api_request("services", "service_types", params={"per_page": per_page})
    service_types = [
        _service_type_summary(service_type)
        for service_type in data.get("data", [])
        if isinstance(service_type, dict)
    ]
    return _collection_response(data, "service_types", service_types)


@mcp.tool(title="List Plans", annotations=READ_ONLY, structured_output=True)
async def pco_list_plans(
    service_type_id: Annotated[
        str,
        Field(description="Planning Center service type ID (from pco_list_service_types)", min_length=1),
    ],
    time_filter: Annotated[
        PlanTimeFilter | None,
        Field(description="Restrict to 'future' or 'past' plans; omit for all plans"),
    ] = None,
    per_page: Annotated[
        int,
        Field(description="Number of plans to return from Planning Center (1-100)", ge=1, le=100),
    ] = 25,
    order: Annotated[
        str,
        Field(description="Sort order, e.g. 'sort_date' (oldest first) or '-sort_date' (newest first)"),
    ] = "sort_date",
) -> dict[str, Any]:
    """List plans (individual service dates) within a Planning Center service type.

    Use time_filter='future' to find upcoming plans. The returned plan id is used by
    pco_list_scheduled_people to see who is scheduled to serve.
    """
    data = await _api_request(
        "services",
        f"service_types/{service_type_id}/plans",
        params={"per_page": per_page, "order": order, "filter": time_filter},
    )
    plans = [_plan_summary(plan) for plan in data.get("data", []) if isinstance(plan, dict)]
    response = _collection_response(data, "plans", plans)
    response["service_type_id"] = service_type_id
    return response


@mcp.tool(title="List Teams", annotations=READ_ONLY, structured_output=True)
async def pco_list_teams(
    service_type_id: Annotated[
        str | None,
        Field(
            description="Optional service type ID to list only that service type's teams; omit for all teams",
            min_length=1,
        ),
    ] = None,
    per_page: Annotated[
        int,
        Field(description="Number of teams to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List Planning Center Services teams (for example Band, Vocals, or Tech).

    Pass a service_type_id to scope teams to a single service type, or omit it to
    list every team in the organization.
    """
    endpoint = f"service_types/{service_type_id}/teams" if service_type_id else "teams"
    data = await _api_request("services", endpoint, params={"per_page": per_page})
    teams = [_team_summary(team) for team in data.get("data", []) if isinstance(team, dict)]
    response = _collection_response(data, "teams", teams)
    if service_type_id:
        response["service_type_id"] = service_type_id
    return response


@mcp.tool(title="List Team Positions", annotations=READ_ONLY, structured_output=True)
async def pco_list_team_positions(
    team_id: Annotated[
        str,
        Field(description="Planning Center Services team ID (from pco_list_teams)", min_length=1),
    ],
    per_page: Annotated[
        int,
        Field(description="Number of team positions to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List the positions within a Planning Center Services team (for example Lead Vocal or Drums)."""
    data = await _api_request(
        "services",
        f"teams/{team_id}/team_positions",
        params={"per_page": per_page},
    )
    positions = [
        _team_position_summary(position)
        for position in data.get("data", [])
        if isinstance(position, dict)
    ]
    response = _collection_response(data, "team_positions", positions)
    response["team_id"] = team_id
    return response


@mcp.tool(title="List Scheduled People", annotations=READ_ONLY, structured_output=True)
async def pco_list_scheduled_people(
    service_type_id: Annotated[
        str,
        Field(description="Planning Center service type ID (from pco_list_service_types)", min_length=1),
    ],
    plan_id: Annotated[
        str,
        Field(description="Planning Center plan ID (from pco_list_plans)", min_length=1),
    ],
    per_page: Annotated[
        int,
        Field(description="Number of scheduled people to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List the people scheduled to serve on a Planning Center plan.

    Each entry includes the person's team position and confirmation status, where
    status is 'C' (Confirmed), 'U' (Unconfirmed), or 'D' (Declined); status_label
    gives the human-readable form.
    """
    data = await _api_request(
        "services",
        f"service_types/{service_type_id}/plans/{plan_id}/team_members",
        params={"per_page": per_page},
    )
    scheduled_people = [
        _scheduled_person_summary(plan_person)
        for plan_person in data.get("data", [])
        if isinstance(plan_person, dict)
    ]
    response = _collection_response(data, "scheduled_people", scheduled_people)
    response["service_type_id"] = service_type_id
    response["plan_id"] = plan_id
    return response


# ---------------------------------------------------------------------------
# Mobile roster web page
#
# A PIN-protected, mobile-friendly HTML page at /roster that shows everyone on a
# Planning Center Services team and the teams they serve on. Data is fetched
# live from Planning Center server-side (credentials never reach the browser).
# Access is gated by a short PIN (ROSTER_PIN) verified server-side; a signed,
# HttpOnly cookie keeps the viewer logged in for 12 hours.
# ---------------------------------------------------------------------------
ROSTER_COOKIE = "pco_roster_auth"
ROSTER_COOKIE_TTL = 12 * 60 * 60  # 12 hours


def _roster_pin() -> str:
    return os.getenv("ROSTER_PIN", "").strip()


def _roster_secret() -> bytes:
    explicit = os.getenv("ROSTER_COOKIE_SECRET", "").strip()
    if explicit:
        return explicit.encode("utf-8")
    # Stable per-deployment secret derived from server-only values, so cookies
    # survive restarts without requiring an extra env var.
    base = f"roster|{_roster_pin()}|{os.getenv('PCO_CLIENT_SECRET', '')}"
    return hashlib.sha256(base.encode("utf-8")).digest()


def _make_roster_cookie(ttl: int = ROSTER_COOKIE_TTL) -> str:
    expires = str(int(time.time()) + ttl)
    signature = hmac.new(_roster_secret(), expires.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{expires}.{signature}"


def _valid_roster_cookie(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    expires, signature = value.rsplit(".", 1)
    expected = hmac.new(_roster_secret(), expires.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        return False
    try:
        return int(expires) > int(time.time())
    except ValueError:
        return False


def _request_is_https(request: Request) -> bool:
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return proto == "https" or request.url.scheme == "https"


ROSTER_WINDOW_DAYS = 60


def _parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


async def _fetch_teams() -> tuple[list[JsonObject], dict[str, JsonObject]]:
    """Return (teams, people_by_id) from the Services teams endpoint."""
    teams_raw: list[JsonObject] = []
    included: dict[str, JsonObject] = {}
    offset = 0
    for _ in range(50):  # safety bound
        page = await _api_request(
            "services",
            "teams",
            params={"include": "people", "per_page": 100, "offset": offset},
        )
        data = [t for t in page.get("data", []) if isinstance(t, dict)]
        teams_raw.extend(data)
        for record in page.get("included", []):
            if isinstance(record, dict) and record.get("id") is not None:
                included[str(record["id"])] = record
        meta = page.get("meta", {}) if isinstance(page.get("meta"), dict) else {}
        total = meta.get("total_count", len(teams_raw))
        offset += len(data)
        if not data or offset >= total:
            break
    return teams_raw, included


async def _fetch_partners() -> list[JsonObject]:
    """Return active people whose membership is 'Partner'."""
    partners: list[JsonObject] = []
    offset = 0
    for _ in range(50):
        page = await _api_request(
            "people",
            "people",
            params={
                "where[membership]": "Partner",
                "where[status]": "active",
                "per_page": 100,
                "offset": offset,
            },
        )
        data = [p for p in page.get("data", []) if isinstance(p, dict)]
        for record in data:
            attrs = _attributes(record)
            pid = str(record.get("id"))
            name = attrs.get("name") or " ".join(
                part for part in (attrs.get("first_name"), attrs.get("last_name")) if part
            ) or f"Person {pid}"
            partners.append(
                {
                    "id": pid,
                    "name": name,
                    "last": attrs.get("last_name") or "",
                    "url": f"https://people.planningcenteronline.com/people/AC{pid}",
                }
            )
        meta = page.get("meta", {}) if isinstance(page.get("meta"), dict) else {}
        offset += len(data)
        if not data or offset >= meta.get("total_count", offset):
            break
    return partners


def _lead_group_name() -> str:
    return os.getenv("ROSTER_LEAD_GROUP", "Lead Partners").strip() or "Lead Partners"


async def _find_group_id(name: str) -> str | None:
    """Resolve a Groups group id by name (exact match preferred)."""
    target = name.strip().lower()
    try:
        page = await _api_request("groups", "groups", params={"where[name]": name, "per_page": 100})
        candidates = [g for g in page.get("data", []) if isinstance(g, dict)]
        for group in candidates:
            if (_attributes(group).get("name") or "").strip().lower() == target:
                return str(group.get("id"))
        if candidates:
            return str(candidates[0].get("id"))
    except Exception:  # noqa: BLE001 - fall back to listing all groups
        pass
    offset = 0
    for _ in range(30):
        page = await _api_request("groups", "groups", params={"per_page": 100, "offset": offset})
        rows = [g for g in page.get("data", []) if isinstance(g, dict)]
        for group in rows:
            if (_attributes(group).get("name") or "").strip().lower() == target:
                return str(group.get("id"))
        meta = page.get("meta", {}) if isinstance(page.get("meta"), dict) else {}
        offset += len(rows)
        if not rows or offset >= meta.get("total_count", offset):
            break
    return None


async def _fetch_lead_partner_ids() -> set[str]:
    """Return the person IDs belonging to the configured 'Lead Partners' group."""
    group_id = await _find_group_id(_lead_group_name())
    if not group_id:
        return set()
    ids: set[str] = set()
    offset = 0
    for _ in range(60):
        page = await _api_request(
            "groups",
            f"groups/{group_id}/memberships",
            params={"per_page": 100, "offset": offset},
        )
        rows = [m for m in page.get("data", []) if isinstance(m, dict)]
        for row in rows:
            rel = row.get("relationships", {}) if isinstance(row.get("relationships"), dict) else {}
            person_rel = rel.get("person", {}) if isinstance(rel.get("person"), dict) else {}
            ref = person_rel.get("data") if isinstance(person_rel.get("data"), dict) else None
            if ref and ref.get("id") is not None:
                ids.add(str(ref["id"]))
        meta = page.get("meta", {}) if isinstance(page.get("meta"), dict) else {}
        offset += len(rows)
        if not rows or offset >= meta.get("total_count", offset):
            break
    return ids


# Elders and deacons, by Planning Center person ID, for the role-exclusion filter.
ROSTER_ELDER_IDS = frozenset({
    "89892975",  # Bryan Purtle
    "87899362",  # Curt Schampers
    "88547242",  # Jordan Vaughan
    "87899240",  # Josh Christophersen
    "88546412",  # Micah Schmidt
})
ROSTER_DEACON_IDS = frozenset({
    "88547391",  # John Clinton
    "102716821",  # Cameron Kline
    "88837041",  # Lory Olla
    "88462936",  # Molly Becker
    "88546769",  # Stuart Becker
    "88837038",  # Jon (John) Olla
    "88843218",  # Daniel Durgin
    "88547337",  # Jon Munyan
    "88547032",  # Ben Clinton
    "99160400",  # Tim Longobardo
    "88545253",  # Josh Ruff
    "88462759",  # Rebekah Clinton
    "118245006",  # Zach Lewis
})

ROSTER_WINDOWS = (30, 60, 90)


def _empty_serves() -> dict[str, int]:
    return {f"d{d}": 0 for d in ROSTER_WINDOWS}


async def _fetch_serve_counts() -> dict[str, dict[str, int]]:
    """Count non-declined serving slots per person for each rolling window.

    Walks every active service type's plans back to the widest window (90 days)
    once, and tallies each assignment into every window it falls within, so one
    pass yields the 30/60/90-day counts. Returns {person_id: {d30, d60, d90}}.
    """
    now = datetime.now(timezone.utc).timestamp()
    cutoffs = {f"d{d}": now - d * 86400 for d in ROSTER_WINDOWS}
    widest = now - max(ROSTER_WINDOWS) * 86400
    counts: dict[str, dict[str, int]] = {}

    st_page = await _api_request("services", "service_types", params={"per_page": 100})
    service_type_ids = [
        str(s.get("id")) for s in st_page.get("data", []) if isinstance(s, dict) and s.get("id") is not None
    ]

    for stid in service_type_ids:
        plans: list[tuple[str, float]] = []  # (plan_id, sort_timestamp)
        offset = 0
        done = False
        for _ in range(40):
            page = await _api_request(
                "services",
                f"service_types/{stid}/plans",
                params={"filter": "past", "order": "-sort_date", "per_page": 100, "offset": offset},
            )
            data = [p for p in page.get("data", []) if isinstance(p, dict)]
            if not data:
                break
            for plan in data:
                sort_dt = _parse_iso(_attributes(plan).get("sort_date"))
                if sort_dt is not None and sort_dt.timestamp() >= widest:
                    plans.append((str(plan.get("id")), sort_dt.timestamp()))
                else:
                    done = True
                    break
            if done:
                break
            offset += len(data)
            meta = page.get("meta", {}) if isinstance(page.get("meta"), dict) else {}
            if offset >= meta.get("total_count", offset):
                break

        for plan_id, sort_ts in plans:
            windows_hit = [key for key, cut in cutoffs.items() if sort_ts >= cut]
            if not windows_hit:
                continue
            p_offset = 0
            for _ in range(40):
                pp = await _api_request(
                    "services",
                    f"service_types/{stid}/plans/{plan_id}/team_members",
                    params={"filter": "not_declined", "per_page": 100, "offset": p_offset},
                )
                rows = [r for r in pp.get("data", []) if isinstance(r, dict)]
                if not rows:
                    break
                for row in rows:
                    rel = row.get("relationships", {}) if isinstance(row.get("relationships"), dict) else {}
                    person_rel = rel.get("person", {}) if isinstance(rel.get("person"), dict) else {}
                    person_ref = person_rel.get("data") if isinstance(person_rel.get("data"), dict) else None
                    if person_ref and person_ref.get("id") is not None:
                        person_id = str(person_ref["id"])
                        bucket = counts.setdefault(person_id, _empty_serves())
                        for key in windows_hit:
                            bucket[key] += 1
                p_offset += len(rows)
                meta = pp.get("meta", {}) if isinstance(pp.get("meta"), dict) else {}
                if p_offset >= meta.get("total_count", p_offset):
                    break

    return counts


async def _build_roster_payload() -> dict[str, Any]:
    """Build the full roster model: teams, people, partners, and serve stats.

    Teams are replicated per service type in Planning Center (e.g. many separate
    "Band" records), so we collapse them by trimmed name and union the members.
    Each person is annotated with how many non-declined serving slots they filled
    in the last ROSTER_WINDOW_DAYS across all teams.
    """
    teams_raw, included = await _fetch_teams()
    serve_counts = await _fetch_serve_counts()
    partners = await _fetch_partners()
    lead_ids = await _fetch_lead_partner_ids()
    # The whole dashboard is scoped to people whose membership is "Partner".
    partner_ids = {p["id"] for p in partners}

    people: dict[str, JsonObject] = {}
    for pid, record in included.items():
        if record.get("type") != "Person":
            continue
        attrs = _attributes(record)
        name = attrs.get("full_name") or " ".join(
            part for part in (attrs.get("first_name"), attrs.get("last_name")) if part
        ) or f"Person {pid}"
        links = record.get("links") if isinstance(record.get("links"), dict) else {}
        people[pid] = {
            "id": pid,
            "name": name,
            "last": attrs.get("last_name") or "",
            "url": links.get("html"),
            "teams": set(),
        }

    by_name: dict[str, JsonObject] = {}
    for team in teams_raw:
        attrs = _attributes(team)
        team_name = (attrs.get("name") or "").strip() or "(Unnamed team)"
        rel = team.get("relationships", {}) if isinstance(team.get("relationships"), dict) else {}
        rel_people = rel.get("people", {}) if isinstance(rel.get("people"), dict) else {}
        member_refs = rel_people.get("data", []) if isinstance(rel_people.get("data"), list) else []
        entry = by_name.setdefault(team_name, {"name": team_name, "ids": set(), "instances": 0})
        entry["instances"] += 1
        for ref in member_refs:
            if not isinstance(ref, dict):
                continue
            pid = str(ref.get("id"))
            if pid not in people:
                people[pid] = {"id": pid, "name": f"Person {pid}", "last": "", "url": None, "teams": set()}
            entry["ids"].add(pid)
            people[pid]["teams"].add(team_name)

    def serves(pid: str) -> dict[str, int]:
        return serve_counts.get(pid, _empty_serves())

    teams_out = []
    for entry in by_name.values():
        members = [
            {
                "name": people[pid]["name"],
                "last": people[pid]["last"],
                "url": people[pid]["url"],
                "serves": serves(pid),
                "lead": pid in lead_ids,
                "elder": pid in ROSTER_ELDER_IDS,
                "deacon": pid in ROSTER_DEACON_IDS,
            }
            for pid in entry["ids"]
            if pid in partner_ids
        ]
        if not members:  # skip teams with no Partner members
            continue
        members.sort(key=lambda m: ((m["last"] or m["name"]).lower(), m["name"].lower()))
        teams_out.append({"name": entry["name"], "instances": entry["instances"], "members": members})
    teams_out.sort(key=lambda t: t["name"].lower())

    people_out = []
    for person in people.values():
        if not person["teams"] or person["id"] not in partner_ids:
            continue
        people_out.append(
            {
                "name": person["name"],
                "last": person["last"],
                "url": person["url"],
                "teams": sorted(person["teams"], key=str.lower),
                "serves": serves(person["id"]),
                "lead": person["id"] in lead_ids,
                "elder": person["id"] in ROSTER_ELDER_IDS,
                "deacon": person["id"] in ROSTER_DEACON_IDS,
            }
        )
    people_out.sort(key=lambda p: ((p["last"] or p["name"]).lower(), p["name"].lower()))

    team_member_ids = {pid for entry in by_name.values() for pid in entry["ids"]}
    partners_no_team = []
    for partner in partners:
        if partner["id"] in team_member_ids:
            continue
        partners_no_team.append(
            {
                "name": partner["name"],
                "last": partner["last"],
                "url": partner["url"],
                "serves": serves(partner["id"]),
                "lead": partner["id"] in lead_ids,
                "elder": partner["id"] in ROSTER_ELDER_IDS,
                "deacon": partner["id"] in ROSTER_DEACON_IDS,
            }
        )
    partners_no_team.sort(key=lambda p: ((p["last"] or p["name"]).lower(), p["name"].lower()))

    # Burnout / inactivity cards are derived client-side per selected window from
    # people_out + partners_no_team, so we only ship the raw per-window counts.
    return {
        "people": people_out,
        "teams": teams_out,
        "partners_no_team": partners_no_team,
        "windows": list(ROSTER_WINDOWS),
        "lead_group": _lead_group_name(),
        "generated_at": int(time.time()),
    }


_ROSTER_CACHE: dict[str, Any] = {"ts": 0.0, "data": None}


def _roster_cache_ttl() -> int:
    try:
        return max(0, int(os.getenv("ROSTER_CACHE_TTL", "600")))
    except ValueError:
        return 600


async def _get_roster_payload() -> dict[str, Any]:
    """Return a cached roster payload, rebuilding when the cache is stale."""
    now = time.time()
    cached = _ROSTER_CACHE.get("data")
    if cached is not None and (now - _ROSTER_CACHE.get("ts", 0.0)) < _roster_cache_ttl():
        return cached
    payload = await _build_roster_payload()
    _ROSTER_CACHE["ts"] = now
    _ROSTER_CACHE["data"] = payload
    return payload


_ROSTER_LOGIN_HTML = """<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Team Roster</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;color:#1c2430;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.box{background:#fff;border:1px solid #e6e9ee;border-radius:16px;padding:28px 24px;max-width:340px;width:100%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.05)}
h1{font-size:19px;margin:0 0 4px}
p{color:#667085;font-size:13px;margin:0 0 20px}
input{width:100%;font-size:26px;text-align:center;letter-spacing:10px;padding:14px;border:1px solid #d7dce3;border-radius:12px;background:#fafbfc}
input:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
button{margin-top:16px;width:100%;padding:14px;font-size:15px;font-weight:600;color:#fff;background:#2563eb;border:0;border-radius:12px;cursor:pointer}
button:active{background:#1d4ed8}
.err{color:#b42318;font-size:13px;margin-top:14px;min-height:18px}
</style></head><body>
<form class="box" method="post" action="/roster/login">
<h1>Team Roster</h1>
<p>Enter the access PIN to view.</p>
<input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" autofocus placeholder="••••" aria-label="PIN">
<button type="submit">View roster</button>
<div class="err">__ERROR__</div>
</form></body></html>"""


def _roster_login_html(error: bool = False) -> str:
    return _ROSTER_LOGIN_HTML.replace(
        "__ERROR__", "Incorrect PIN. Try again." if error else ""
    )


def _roster_message_html(title: str, message: str) -> str:
    safe_title = title.replace("<", "&lt;")
    safe_message = message.replace("<", "&lt;")
    return (
        "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        "<title>Team Roster</title><style>:root{color-scheme:light}"
        "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;"
        "background:#f6f7f9;color:#1c2430;display:flex;min-height:100vh;align-items:center;"
        "justify-content:center;margin:0;padding:24px}.b{max-width:380px;text-align:center}"
        "h1{font-size:18px}p{color:#667085;font-size:14px;line-height:1.5}</style></head>"
        f"<body><div class=\"b\"><h1>{safe_title}</h1><p>{safe_message}</p></div></body></html>"
    )


_ROSTER_PAGE_HTML = """<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Services Team Roster</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f6f7f9;color:#1c2430;font-size:15px}
.wrap{max-width:860px;margin:0 auto;padding:16px 14px 60px}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:2px}
h1{font-size:19px;margin:0}
.logout{font-size:12px;color:#667085;text-decoration:none}
.sub{color:#667085;font-size:12px;margin:0 0 14px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.card{background:#fff;border:1px solid #e6e9ee;border-radius:10px;padding:12px}
.card .n{font-size:20px;font-weight:650}
.card .l{color:#667085;font-size:11px;margin-top:2px}
.risk{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.panel{background:#fff;border:1px solid #e6e9ee;border-radius:12px;padding:12px 12px 6px}
.panel.burn{border-color:#fed7aa;background:#fff8f1}
.panel.inact{border-color:#c7d7fe;background:#f5f8ff}
.pt{font-size:12px;font-weight:700;margin-bottom:8px}
.pr{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px solid rgba(0,0,0,.05)}
.pr:first-of-type{border-top:0}
.pi{width:18px;height:18px;flex:none;border-radius:50%;background:#eceef2;color:#48505c;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.pn{flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pn a{color:#1c2430;text-decoration:none}
.pv{font-size:12px;font-weight:700;color:#48505c;white-space:nowrap}
.controls{position:sticky;top:0;background:#f6f7f9;padding:8px 0;z-index:10}
.winbar{display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap}
.winlabel{font-size:12px;color:#667085;font-weight:600}
.seg{display:inline-flex;background:#eceef2;border-radius:9px;padding:3px}
.seg button{border:0;background:transparent;padding:7px 14px;border-radius:7px;font-size:13px;font-weight:600;color:#48505c;cursor:pointer}
.seg button.active{background:#fff;color:#1c2430;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.toggle{display:flex;background:#eceef2;border-radius:10px;padding:3px;margin-bottom:8px}
.toggle button{flex:1;border:0;background:transparent;padding:10px 6px;border-radius:8px;font-size:13px;font-weight:600;color:#48505c;cursor:pointer;white-space:nowrap}
.toggle button.active{background:#fff;color:#1c2430;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.row2{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.search{flex:1;min-width:150px;padding:11px 12px;border:1px solid #d7dce3;border-radius:10px;font-size:15px;background:#fff}
.search:focus{outline:none;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
.dd{position:relative}
.ddbtn{padding:11px 12px;border:1px solid #d7dce3;border-radius:10px;background:#fff;font-size:13px;color:#48505c;white-space:nowrap;cursor:pointer}
.ddpanel{position:absolute;right:0;top:46px;width:250px;max-height:320px;overflow:auto;background:#fff;border:1px solid #d7dce3;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.14);padding:8px;z-index:30}
.ddhead{display:flex;gap:6px;margin-bottom:6px}
.ddhead button{flex:1;border:1px solid #d7dce3;background:#fafbfc;border-radius:8px;padding:7px;font-size:12px;color:#48505c;cursor:pointer}
.ddrow{display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:8px;font-size:13px;cursor:pointer}
.ddrow:hover{background:#f6f7f9}
.ddrow input{width:16px;height:16px}
.ddrow span:nth-child(2){flex:1}
.ddn{color:#98a2b3;font-size:12px}
.sortsel{padding:11px 10px;border:1px solid #d7dce3;border-radius:10px;background:#fff;font-size:13px;color:#48505c}
.minibtn{padding:11px 12px;border:1px solid #d7dce3;border-radius:10px;background:#fff;font-size:13px;color:#48505c;cursor:pointer;white-space:nowrap}
.minibtn.active{background:#eef2ff;border-color:#c7d2fe;color:#3730a3;font-weight:600}
.hint{color:#98a2b3;font-size:12px;margin:8px 2px}
.item{background:#fff;border:1px solid #e6e9ee;border-radius:12px;padding:12px 14px;margin-bottom:8px}
.item .h{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nm{font-weight:650}
.nm a{color:#1c2430;text-decoration:none}
.badges{display:flex;gap:6px;flex:none}
.badge{background:#eef2ff;color:#3730a3;font-weight:650;border-radius:8px;padding:3px 9px;font-size:12px;white-space:nowrap}
.badge.b2{background:#f1f5f0;color:#3f6212}
.badge.z{background:#fef2f2;color:#b42318}
.badge.lead{background:#fef9c3;color:#854d0e}
.svc{color:#98a2b3;font-weight:400;font-size:12px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.chip{background:#f1f3f7;color:#3a4250;border-radius:999px;padding:4px 11px;font-size:13px;border:1px solid #e6e9ee}
.chip.off{opacity:.4}
.chip.none{background:#fff;color:#98a2b3;font-style:italic}
.chip a{color:#3a4250;text-decoration:none}
.chip .cx{color:#98a2b3;margin-left:6px;font-size:11px}
.empty{text-align:center;color:#98a2b3;padding:40px}
@media (max-width:640px){.cards{grid-template-columns:repeat(2,1fr)}.risk{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
<div class="top"><h1>Services Team Roster</h1><a class="logout" id="logout" href="/roster/logout">Log out</a></div>
<p class="sub" id="sub">Loading…</p>
<div class="cards" id="cards"></div>
<div class="risk" id="risk"></div>
<div class="controls">
<div class="winbar"><span class="winlabel">Serving window</span>
<div class="seg" id="seg">
<button type="button" data-win="30">Last 30d</button>
<button type="button" data-win="60" class="active">Last 60d</button>
<button type="button" data-win="90">Last 90d</button>
</div></div>
<div class="toggle" id="toggle">
<button type="button" data-view="people" class="active">By Person</button>
<button type="button" data-view="teams">By Team</button>
<button type="button" data-view="partners">Partners · no team</button>
</div>
<div class="row2">
<input class="search" id="search" type="text" placeholder="Search…" autocomplete="off">
<div class="dd" id="teamdd">
<button type="button" class="ddbtn" id="ddbtn">Teams</button>
<div class="ddpanel" id="ddpanel" hidden>
<div class="ddhead"><button type="button" id="selall">Select all</button><button type="button" id="selnone">Clear</button></div>
<div id="ddlist"></div>
</div>
</div>
<select class="sortsel" id="leadsel">
<option value="all">Role filter: none</option>
<option value="exelder">Exclude Elders</option>
<option value="exdeacon">Exclude Elders &amp; Deacons</option>
<option value="exclude">Exclude Elders, Deacons, &amp; Lead Partners</option>
</select>
<select class="sortsel" id="sortsel">
<option value="serves">Sort: Serves</option>
<option value="count">Sort: Count</option>
<option value="name">Sort: Name</option>
</select>
<button type="button" class="minibtn" id="sortdir" title="Toggle ascending / descending">↓ Desc</button>
<button type="button" class="minibtn" id="zerobtn" title="Show only people with no serves in the window">0 serves</button>
</div>
</div>
<div class="hint" id="hint"></div>
<div id="list"></div>
<div id="loading" class="empty"></div>
</div>
<script>
function initRoster(DATA){
  const $=id=>document.getElementById(id);
  const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  let view="people", query="", sortMode="serves", sortDir="desc", win=60, zeroOnly=false, leadMode="all";
  const leadOK=p=>{ switch(leadMode){ case "exclude": return !(p.lead||p.elder||p.deacon); case "exelder": return !p.elder; case "exdeacon": return !(p.elder||p.deacon); default: return true; } };
  const selected=new Set(DATA.teams.map(t=>t.name));
  const byName=(a,b)=>String(a.last||a.name).toLowerCase().localeCompare(String(b.last||b.name).toLowerCase());
  const SV=o=>{const s=o&&o.serves; if(typeof s==="number")return s; return (s&&s["d"+win])||0;};
  const dir=()=>sortDir==="asc"?1:-1;
  // Main roster = partners on a team + partners with no team assignment.
  const noTeamPeople=()=>(DATA.partners_no_team||[]).map(p=>({name:p.name,last:p.last,url:p.url,serves:p.serves,teams:[],lead:p.lead,elder:p.elder,deacon:p.deacon}));
  const teamOK=p=>p.teams.length?p.teams.some(t=>selected.has(t)):selected.size===DATA.teams.length;
  const popOK=p=>teamOK(p)&&leadOK(p);
  const mainList=()=>DATA.people.concat(noTeamPeople());

  function cmpPeople(a,b){
    let d=0;
    if(sortMode==="name") d=byName(a,b);
    else if(sortMode==="count") d=a.teams.length-b.teams.length;
    else d=SV(a)-SV(b);
    return dir()*d || byName(a,b);
  }

  // Cards reflect the active team + role filters (the "who is included" filters).
  function riskPool(){
    return mainList().filter(popOK).map(p=>({name:p.name,url:p.url,serves:SV(p),teams:p.teams.length}));
  }
  function summary(){
    const total=DATA.people.length+(DATA.partners_no_team||[]).length;
    const c=[["Partners",total],["Teams",DATA.teams.length],["On a team",DATA.people.length],["No team",(DATA.partners_no_team||[]).length]];
    $("cards").innerHTML=c.map(x=>`<div class="card"><div class="n">${esc(x[1])}</div><div class="l">${esc(x[0])}</div></div>`).join("");
    const pool=riskPool();
    const burnout=pool.slice().sort((a,b)=>(b.serves-a.serves)||a.name.localeCompare(b.name)).slice(0,5);
    const inactivity=pool.slice().sort((a,b)=>(a.serves-b.serves)||(b.teams-a.teams)||a.name.localeCompare(b.name)).slice(0,5);
    const panel=(title,cls,rows)=>`<div class="panel ${cls}"><div class="pt">${title}</div>`+
      ((rows&&rows.length)?rows.map((r,i)=>`<div class="pr"><span class="pi">${i+1}</span><span class="pn">${r.url?`<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>`:esc(r.name)}</span><span class="pv">${r.serves}×</span></div>`).join(""):`<div class="pr"><span class="pn" style="color:#98a2b3">No data</span></div>`)+`</div>`;
    $("risk").innerHTML=panel(`🔥 Burnout risk · most serves (${win}d)`,"burn",burnout)+panel(`💤 Inactivity risk · fewest serves (${win}d)`,"inact",inactivity);
    const d=new Date((DATA.generated_at||0)*1000);
    $("sub").textContent=`Partners on Services teams · serving counts over the last ${win} days · updated `+d.toLocaleString();
  }

  function renderPeople(){
    const q=query.toLowerCase();
    let rows=mainList().filter(p=> popOK(p) && (!zeroOnly||SV(p)===0) && (!q || p.name.toLowerCase().includes(q) || p.teams.some(t=>t.toLowerCase().includes(q))) );
    rows.sort(cmpPeople);
    $("hint").textContent=rows.length+" of "+(DATA.people.length+(DATA.partners_no_team||[]).length)+" partners"+(zeroOnly?" · 0 serves in "+win+"d":"");
    $("list").innerHTML=rows.length?rows.map(p=>{
      const nm=p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`:esc(p.name);
      const chips=p.teams.length?p.teams.map(t=>`<span class="chip${selected.has(t)?"":" off"}">${esc(t)}</span>`).join(""):'<span class="chip none">No team assignment</span>';
      const sv=SV(p);
      const lead=p.lead?'<span class="badge lead" title="Lead Partners group">★ Lead</span>':'';
      return `<div class="item"><div class="h"><span class="nm">${nm}</span><span class="badges">${lead}<span class="badge b2${sv===0?" z":""}" title="Serves in last ${win} days">${sv}× ${win}d</span><span class="badge">${p.teams.length} team${p.teams.length!=1?"s":""}</span></span></div><div class="chips">${chips}</div></div>`;
    }).join(""):'<div class="empty">No matches.</div>';
  }

  function renderTeams(){
    const q=query.toLowerCase();
    let rows=DATA.teams.filter(t=>selected.has(t.name)).map(t=>({name:t.name,instances:t.instances,members:t.members.filter(m=>(!q||m.name.toLowerCase().includes(q)||t.name.toLowerCase().includes(q))&&(!zeroOnly||SV(m)===0)&&leadOK(m))}));
    if(q||zeroOnly||leadMode!=="all") rows=rows.filter(t=>(q&&t.name.toLowerCase().includes(q))||t.members.length);
    rows.sort((a,b)=>{ const d = sortMode==="name" ? a.name.localeCompare(b.name) : (a.members.length-b.members.length); return dir()*d || a.name.localeCompare(b.name); });
    $("hint").textContent=rows.length+" of "+DATA.teams.length+" teams"+(zeroOnly?" · members with 0 serves in "+win+"d":"");
    $("list").innerHTML=rows.length?rows.map(t=>{
      const svc=t.instances>1?` <span class="svc">· ${t.instances} service types</span>`:"";
      const mem=t.members.slice().sort(sortMode==="serves"?((a,b)=>(SV(b)-SV(a))||byName(a,b)):byName);
      const chips=mem.map(m=>{const nm=m.url?`<a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a>`:esc(m.name);return `<span class="chip">${m.lead?"★ ":""}${nm}<span class="cx">${SV(m)}×</span></span>`;}).join("");
      return `<div class="item"><div class="h"><span class="nm">${esc(t.name)}${svc}</span><span class="badge">${t.members.length}</span></div><div class="chips">${chips||'<span class="svc">No one assigned</span>'}</div></div>`;
    }).join(""):'<div class="empty">No matches.</div>';
  }

  function renderPartners(){
    const q=query.toLowerCase();
    let rows=(DATA.partners_no_team||[]).filter(p=>(!q||p.name.toLowerCase().includes(q))&&(!zeroOnly||SV(p)===0)&&leadOK(p));
    rows.sort(cmpPeople);
    $("hint").textContent=rows.length+" partners with no team assignment"+(zeroOnly?" · 0 serves in "+win+"d":"");
    $("list").innerHTML=rows.length?rows.map(p=>{
      const nm=p.url?`<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`:esc(p.name);
      const sv=SV(p);
      const lead=p.lead?'<span class="badge lead" title="Lead Partners group">★ Lead</span>':'';
      return `<div class="item"><div class="h"><span class="nm">${nm}</span><span class="badges">${lead}<span class="badge b2${sv===0?" z":""}">${sv}× ${win}d</span></span></div></div>`;
    }).join(""):'<div class="empty">Every Partner is on a team. 🎉</div>';
  }

  function render(){
    $("teamdd").style.display = view==="partners" ? "none" : "";
    if(view==="people")renderPeople(); else if(view==="teams")renderTeams(); else renderPartners();
  }

  function updateDDbtn(){ $("ddbtn").textContent = selected.size===DATA.teams.length ? "Teams: all" : `Teams: ${selected.size}/${DATA.teams.length}`; }
  function buildDD(){
    $("ddlist").innerHTML=DATA.teams.map(t=>`<label class="ddrow"><input type="checkbox" value="${esc(t.name)}" ${selected.has(t.name)?"checked":""}><span>${esc(t.name)}</span><span class="ddn">${t.members.length}</span></label>`).join("");
    $("ddlist").querySelectorAll("input").forEach(cb=>cb.addEventListener("change",()=>{cb.checked?selected.add(cb.value):selected.delete(cb.value);updateDDbtn();summary();render();}));
    updateDDbtn();
  }

  $("seg").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;win=parseInt(b.dataset.win,10);[...$("seg").children].forEach(x=>x.classList.toggle("active",x.dataset.win==String(win)));summary();render();});
  $("ddbtn").addEventListener("click",()=>{$("ddpanel").hidden=!$("ddpanel").hidden;});
  document.addEventListener("click",e=>{ if(!$("teamdd").contains(e.target)) $("ddpanel").hidden=true; });
  $("selall").addEventListener("click",()=>{DATA.teams.forEach(t=>selected.add(t.name));buildDD();summary();render();});
  $("selnone").addEventListener("click",()=>{selected.clear();buildDD();summary();render();});
  $("toggle").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;view=b.dataset.view;[...$("toggle").children].forEach(x=>x.classList.toggle("active",x.dataset.view===view));render();});
  $("search").addEventListener("input",e=>{query=e.target.value.trim();render();});
  $("sortsel").addEventListener("change",e=>{sortMode=e.target.value;sortDir=(sortMode==="name")?"asc":"desc";updateDir();render();});
  $("sortdir").addEventListener("click",()=>{sortDir=sortDir==="asc"?"desc":"asc";updateDir();render();});
  function updateDir(){ $("sortdir").textContent = sortDir==="asc" ? "↑ Asc" : "↓ Desc"; }
  $("zerobtn").addEventListener("click",()=>{zeroOnly=!zeroOnly;$("zerobtn").classList.toggle("active",zeroOnly);render();});
  $("leadsel").addEventListener("change",e=>{leadMode=e.target.value;summary();render();});

  const ld=$("loading"); if(ld) ld.style.display="none";
  updateDir(); buildDD(); summary(); render();
}
initRoster(__DATA__);
</script></body></html>
"""


@mcp.custom_route("/roster", methods=["GET"], include_in_schema=False)
async def roster_page(request: Request) -> Response:
    if not _roster_pin():
        return HTMLResponse(
            _roster_message_html(
                "Roster not enabled",
                "Set the ROSTER_PIN environment variable on the server to enable this page.",
            ),
            status_code=503,
        )
    if not _valid_roster_cookie(request.cookies.get(ROSTER_COOKIE)):
        return HTMLResponse(_roster_login_html(error=False))
    try:
        payload = await _get_roster_payload()
    except Exception as exc:  # noqa: BLE001 - surface a friendly page
        LOGGER.exception("Failed to build roster page")
        return HTMLResponse(
            _roster_message_html("Couldn't load the roster", str(exc)),
            status_code=502,
        )
    data_json = json.dumps(payload).replace("</", "<\\/")
    html = _ROSTER_PAGE_HTML.replace("__DATA__", data_json)
    return HTMLResponse(html)


@mcp.custom_route("/roster/login", methods=["POST"], include_in_schema=False)
async def roster_login(request: Request) -> Response:
    pin = _roster_pin()
    if not pin:
        return HTMLResponse(
            _roster_message_html(
                "Roster not enabled",
                "Set the ROSTER_PIN environment variable on the server to enable this page.",
            ),
            status_code=503,
        )
    # Parse the urlencoded body directly to avoid a python-multipart dependency.
    body = (await request.body()).decode("utf-8", "ignore")
    submitted = (parse_qs(body).get("pin", [""])[0]).strip()
    if submitted and secrets.compare_digest(submitted, pin):
        response = RedirectResponse("/roster", status_code=303)
        response.set_cookie(
            ROSTER_COOKIE,
            _make_roster_cookie(),
            max_age=ROSTER_COOKIE_TTL,
            httponly=True,
            secure=_request_is_https(request),
            samesite="lax",
            path="/roster",
        )
        return response
    return HTMLResponse(_roster_login_html(error=True), status_code=401)


@mcp.custom_route("/roster/logout", methods=["GET"], include_in_schema=False)
async def roster_logout(request: Request) -> Response:
    response = RedirectResponse("/roster", status_code=303)
    response.delete_cookie(ROSTER_COOKIE, path="/roster")
    return response


# ---------------------------------------------------------------------------
# Planning Center Calendar (calendar/v2) read-only tools
# ---------------------------------------------------------------------------
def _event_summary(event: JsonObject) -> JsonObject:
    attrs = _attributes(event)
    return {
        "id": event.get("id"),
        "type": event.get("type"),
        "name": attrs.get("name"),
        "summary": attrs.get("summary"),
        "approval_status": attrs.get("approval_status"),
        "featured": attrs.get("featured"),
        "visible_in_church_center": attrs.get("visible_in_church_center"),
        "registration_url": attrs.get("registration_url"),
        "attributes": attrs,
    }


def _event_instance_summary(instance: JsonObject) -> JsonObject:
    attrs = _attributes(instance)
    return {
        "id": instance.get("id"),
        "type": instance.get("type"),
        "name": attrs.get("name"),
        "starts_at": attrs.get("starts_at"),
        "ends_at": attrs.get("ends_at"),
        "all_day_event": attrs.get("all_day_event"),
        "location": attrs.get("location"),
        "recurrence_description": attrs.get("recurrence_description"),
        "church_center_url": attrs.get("church_center_url"),
        "event_id": _relationship_id(instance, "event"),
        "attributes": attrs,
    }


def _resource_summary(resource: JsonObject) -> JsonObject:
    attrs = _attributes(resource)
    return {
        "id": resource.get("id"),
        "type": resource.get("type"),
        "name": attrs.get("name"),
        "kind": attrs.get("kind"),
        "description": attrs.get("description"),
        "quantity": attrs.get("quantity"),
        "home_location": attrs.get("home_location"),
        "path_name": attrs.get("path_name"),
        "expires_at": attrs.get("expires_at"),
        "attributes": attrs,
    }


def _resource_booking_summary(booking: JsonObject) -> JsonObject:
    attrs = _attributes(booking)
    return {
        "id": booking.get("id"),
        "type": booking.get("type"),
        "starts_at": attrs.get("starts_at"),
        "ends_at": attrs.get("ends_at"),
        "quantity": attrs.get("quantity"),
        "event_id": _relationship_id(booking, "event"),
        "event_instance_id": _relationship_id(booking, "event_instance"),
        "resource_id": _relationship_id(booking, "resource"),
        "attributes": attrs,
    }


def _conflict_summary(conflict: JsonObject) -> JsonObject:
    attrs = _attributes(conflict)
    return {
        "id": conflict.get("id"),
        "type": conflict.get("type"),
        "note": attrs.get("note"),
        "resolved_at": attrs.get("resolved_at"),
        "resource_id": _relationship_id(conflict, "resource"),
        "winner_event_id": _relationship_id(conflict, "winner"),
        "resolved_by_person_id": _relationship_id(conflict, "resolved_by"),
        "attributes": attrs,
    }


@mcp.tool(title="List Calendar Events", annotations=READ_ONLY, structured_output=True)
async def pco_list_events(
    per_page: Annotated[
        int,
        Field(description="Number of events to return from Planning Center (1-100)", ge=1, le=100),
    ] = 25,
) -> dict[str, Any]:
    """List Planning Center Calendar events (the event definitions on the calendar)."""
    data = await _api_request("calendar", "events", params={"per_page": per_page})
    events = [_event_summary(event) for event in data.get("data", []) if isinstance(event, dict)]
    return _collection_response(data, "events", events)


@mcp.tool(title="List Calendar Event Instances", annotations=READ_ONLY, structured_output=True)
async def pco_list_event_instances(
    event_id: Annotated[
        str | None,
        Field(
            description="Optional event ID (from pco_list_events) to list only that event's instances",
            min_length=1,
        ),
    ] = None,
    upcoming_only: Annotated[
        bool,
        Field(description="If true, return only future instances"),
    ] = False,
    per_page: Annotated[
        int,
        Field(description="Number of instances to return from Planning Center (1-100)", ge=1, le=100),
    ] = 25,
    order: Annotated[
        str,
        Field(description="Sort order, e.g. 'starts_at' (soonest first) or '-starts_at' (latest first)"),
    ] = "starts_at",
) -> dict[str, Any]:
    """List calendar event instances (specific dated occurrences) with start/end time and location."""
    endpoint = f"events/{event_id}/event_instances" if event_id else "event_instances"
    params: dict[str, Any] = {"per_page": per_page, "order": order}
    if upcoming_only:
        params["filter"] = "future"
    data = await _api_request("calendar", endpoint, params=params)
    instances = [
        _event_instance_summary(instance)
        for instance in data.get("data", [])
        if isinstance(instance, dict)
    ]
    response = _collection_response(data, "event_instances", instances)
    if event_id:
        response["event_id"] = event_id
    return response


@mcp.tool(title="List Calendar Resources", annotations=READ_ONLY, structured_output=True)
async def pco_list_resources(
    per_page: Annotated[
        int,
        Field(description="Number of resources to return from Planning Center (1-100)", ge=1, le=100),
    ] = 100,
) -> dict[str, Any]:
    """List Planning Center Calendar resources — bookable rooms and equipment (see the 'kind' field)."""
    data = await _api_request("calendar", "resources", params={"per_page": per_page})
    resources = [
        _resource_summary(resource) for resource in data.get("data", []) if isinstance(resource, dict)
    ]
    return _collection_response(data, "resources", resources)


@mcp.tool(title="List Resource Bookings", annotations=READ_ONLY, structured_output=True)
async def pco_list_resource_bookings(
    event_id: Annotated[
        str | None,
        Field(description="Optional event ID to list only that event's resource bookings", min_length=1),
    ] = None,
    event_instance_id: Annotated[
        str | None,
        Field(
            description="Optional event instance ID to list only that instance's resource bookings",
            min_length=1,
        ),
    ] = None,
    resource_id: Annotated[
        str | None,
        Field(description="Optional resource ID to list only that room/equipment's bookings", min_length=1),
    ] = None,
    upcoming_only: Annotated[
        bool,
        Field(description="If true, return only future bookings"),
    ] = False,
    per_page: Annotated[
        int,
        Field(description="Number of bookings to return from Planning Center (1-100)", ge=1, le=100),
    ] = 25,
    order: Annotated[
        str,
        Field(description="Sort order, e.g. 'starts_at' or '-starts_at'"),
    ] = "starts_at",
) -> dict[str, Any]:
    """List resource bookings — which room or equipment is reserved for an event/instance, and when.

    Provide at most one of event_instance_id, event_id, or resource_id to scope the results.
    """
    if event_instance_id:
        endpoint = f"event_instances/{event_instance_id}/resource_bookings"
    elif event_id:
        endpoint = f"events/{event_id}/resource_bookings"
    elif resource_id:
        endpoint = f"resources/{resource_id}/resource_bookings"
    else:
        endpoint = "resource_bookings"
    params: dict[str, Any] = {"per_page": per_page, "order": order}
    if upcoming_only:
        params["filter"] = "future"
    data = await _api_request("calendar", endpoint, params=params)
    bookings = [
        _resource_booking_summary(booking)
        for booking in data.get("data", [])
        if isinstance(booking, dict)
    ]
    response = _collection_response(data, "resource_bookings", bookings)
    for key, value in (
        ("event_id", event_id),
        ("event_instance_id", event_instance_id),
        ("resource_id", resource_id),
    ):
        if value:
            response[key] = value
    return response


@mcp.tool(title="List Calendar Conflicts", annotations=READ_ONLY, structured_output=True)
async def pco_list_conflicts(
    status: Annotated[
        ConflictStatus | None,
        Field(description="Filter by 'unresolved', 'resolved', or 'future'; omit for all conflicts"),
    ] = None,
    per_page: Annotated[
        int,
        Field(description="Number of conflicts to return from Planning Center (1-100)", ge=1, le=100),
    ] = 25,
) -> dict[str, Any]:
    """List Planning Center Calendar conflicts (e.g. double-booked resources); resolved_at is set once resolved."""
    data = await _api_request(
        "calendar", "conflicts", params={"per_page": per_page, "filter": status}
    )
    conflicts = [
        _conflict_summary(conflict) for conflict in data.get("data", []) if isinstance(conflict, dict)
    ]
    return _collection_response(data, "conflicts", conflicts)


def _is_valid_mcp_token(token: str) -> bool:
    """A token is accepted if our OAuth handshake issued it, or if it matches
    the optional static MCP_BEARER_TOKEN (handy for direct/API clients)."""
    if not token:
        return False
    if token in _oauth_tokens:
        return True
    static_token = os.getenv("MCP_BEARER_TOKEN", "").strip()
    if static_token and secrets.compare_digest(token, static_token):
        return True
    return False


def _guard_mcp_endpoint(app):
    """Wrap the ASGI app to require a valid bearer token on the /mcp endpoint.

    FastMCP's built-in auth is disabled so it cannot collide with the OAuth
    connector handshake; access control lives here instead. Every other route
    (/health, /roster, /register, /authorize, /token, /.well-known/*) stays
    public so the sign-in flow and the roster page keep working. Lifespan and
    other non-HTTP events pass straight through to the wrapped app.
    """
    mcp_path = getattr(mcp.settings, "streamable_http_path", "/mcp") or "/mcp"

    async def guarded(scope, receive, send):
        if scope.get("type") == "http":
            path = scope.get("path", "")
            if path == mcp_path or path.startswith(mcp_path + "/"):
                headers = {
                    key.decode("latin-1").lower(): value.decode("latin-1")
                    for key, value in scope.get("headers", [])
                }
                authorization = headers.get("authorization", "")
                token = (
                    authorization[7:].strip()
                    if authorization[:7].lower() == "bearer "
                    else ""
                )
                if not _is_valid_mcp_token(token):
                    await send({
                        "type": "http.response.start",
                        "status": 401,
                        "headers": [
                            (b"content-type", b"application/json"),
                            (b"www-authenticate", b"Bearer"),
                        ],
                    })
                    await send({
                        "type": "http.response.body",
                        "body": (
                            b'{"error":"invalid_token","error_description":'
                            b'"Missing or invalid access token"}'
                        ),
                    })
                    return
        await app(scope, receive, send)

    return guarded


def main() -> None:
    logging.basicConfig(
        level=_log_level(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    transport = _select_transport()
    LOGGER.info(
        "Starting Planning Center MCP server transport=%s host=%s port=%s pco_configured=%s static_token=%s",
        transport,
        mcp.settings.host,
        mcp.settings.port,
        bool(os.getenv("PCO_CLIENT_ID") and os.getenv("PCO_CLIENT_SECRET")),
        bool(os.getenv("MCP_BEARER_TOKEN", "").strip()),
    )

    if transport == "streamable-http":
        import uvicorn

        app = _guard_mcp_endpoint(mcp.streamable_http_app())
        uvicorn.run(
            app,
            host=mcp.settings.host,
            port=mcp.settings.port,
            log_level=_log_level().lower(),
        )
    else:
        mcp.run(transport=transport)


if __name__ == "__main__":
    main()
