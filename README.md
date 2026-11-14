# Bellicose Roster

A PIN-protected, mobile-friendly Services roster for Bellicose Church, served by a
Cloudflare Worker at **https://pco.bellicosechurch.org/roster** (Ember Digital account).

It shows every Planning Center person whose People membership is **Partner**, the
Services teams they serve on, and how often they were scheduled (non-declined) in
the last 30, 60 and 90 days, with burnout/inactivity cards and filters for team,
Lead Partners, elders and deacons.

- **People / No team:** last served, declines and pending requests per Partner; sort by
  serves, team count, name, longest gap or declines; filter to flagged people.
- **Flags ("Heads up"):** on two teams at the same time, 4+ weeks in a row, or 2+ declines
  in the selected window.
- **Teams:** average serves, inactive members, and how much the top 3 carry.
- **This week:** every plan in the next 7 days with confirmed/pending/declined people and
  open positions.
- **Profile** (tap a name): roles, counts, 17-week serving chart, upcoming 4 weeks,
  90-day history including declines and their reasons, and a link to Planning Center.

## How it works

- A cron trigger (every 15 minutes) pulls teams, plans, team members, Partners,
  the Lead Partners group, and the Elders/Deacons lists from the Planning Center
  API and stores the computed roster in KV (`ROSTER_KV`, key `roster:v1`).
- `GET /roster` checks the PIN cookie and renders the page from KV, so loads are
  instant. If KV is empty (first deploy) it builds once inline.
- `POST /roster/login` checks the PIN and sets a signed, HttpOnly cookie valid
  for 12 hours; `/roster/logout` clears it. `/health` returns `{"status":"ok"}`.

```
src/index.ts          routes + cron entry
src/roster/build.ts   Planning Center → roster payload (team merge, 30/60/90 counts, flags)
src/roster/routes.ts  PIN login, cookie signing, KV cache, page rendering
src/roster/*.html     login and roster pages (the page's JS reads the injected data)
src/pco/client.ts     Planning Center API client (pagination, rate limiting, retries)
```

## Configuration

Vars live in `wrangler.jsonc`:

| Var | Purpose |
|---|---|
| `ROSTER_LEAD_GROUP` | Groups group whose members get the ★ Lead Partner badge |
| `ROSTER_ELDERS_LIST` / `ROSTER_DEACONS_LIST` | People List names for the elder/deacon filters. If a list isn't found, a built-in ID list in `build.ts` is used |
| `ROSTER_EXCLUDED_TEAMS` | JSON array of Services team names hidden from the roster and all counts |

Secrets (`wrangler secret put <NAME>`):

| Secret | Purpose |
|---|---|
| `PCO_CLIENT_ID` / `PCO_CLIENT_SECRET` | Planning Center Personal Access Token (Application ID / Secret) |
| `ROSTER_PIN` | PIN viewers enter |
| `ROSTER_COOKIE_SECRET` | Signs the login cookie; changing it signs everyone out |

## Development

Requires Node 22+ (`.nvmrc`). Copy `.dev.vars.example` to `.dev.vars` and fill it in.

```bash
npm install
npm run dev        # http://localhost:8787/roster
npm test           # roster logic, API client, cookie tests
npm run typecheck
npm run deploy     # deploys to pco.bellicosechurch.org
```

Trigger the cron locally with `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.
Tail production logs with `npx wrangler tail`.
