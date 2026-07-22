# 17 — MCP registry

← [16 Admin UI](16-admin-ui.md) · [Back to README](README.md)

> **Overview:** Turn LiteLLM into a shared Model Context Protocol (MCP) tool
> registry — one place to register MCP servers that both Open WebUI (browser
> chat) and IDE/TUI clients (Claude Code, Cursor, coding agents) can draw
> tools from, using the same virtual-key auth they already have.
>
> **Why:** Without a shared registry, "add a tool" means wiring it into every
> client separately. LiteLLM already sits in front of both surfaces (step 06)
> and ships a native MCP Gateway — reusing it means one registration, visible
> everywhere, with no new standalone infrastructure.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<domain.com>` | Your registered domain | From step 09 |
> | `<llm-admin.domain.com>` | New dedicated hostname for LiteLLM's own `/ui` | Pick one; not used elsewhere |

---

## Why a dedicated `llm-admin.` host, not the existing `api.` host

`api.domain.com` (LiteLLM's public inference endpoint) uses CF Access
**Bypass/Everyone** — no edge identity check, just the LiteLLM virtual key —
protected instead by a narrow WAF allowlist covering only the inference paths
(step 09 §4). LiteLLM's own `/ui` needs a much wider REST surface behind it
(see §3), and deliberately widening the bypass host's allowlist to cover an
admin dashboard would undo the reason that allowlist is narrow in the first
place. A second host, gated like `admin.domain.com` (CF Access **Allow**,
admin emails only), keeps the two risk profiles separate — and can be turned
off independently if it's ever not worth keeping public.

## Three ways an MCP server joins the registry

| | Native, no infra | Native, self-hosted backing service | Stdio-only server |
|---|---|---|---|
| Example | A hosted/vendor MCP endpoint already reachable over the network | A server whose own image runs a standalone HTTP/SSE server, but which talks to *another* self-hosted service (e.g. a web-search MCP wrapper backed by your own SearXNG instance) | Most community servers (`npx`/`uvx`-run) |
| What's needed | Nothing extra — LiteLLM can reach it directly | The wrapper's own Deployment + Service, plus whatever it's backed by (its own Deployment/Service/NetworkPolicy/Secrets) | A **Supergateway bridge** pod (§5) that speaks stdio to the process and streamable-HTTP to LiteLLM |
| k8s work per server | None | One Deployment+Service per backing component (typically 2–3) | One Deployment + Service |
| Where it's added | LiteLLM's Admin UI → MCP Servers → Add → URL | Same UI, once the wrapper + backing services exist | Same UI, once the bridge exists |

Check a server's own docs for its transport before assuming — `mcp remote`/SSE
support is increasingly common even for tools that started stdio-only, and
some servers (native-with-backing-service) run their own standalone
streamable-HTTP server directly, needing no Supergateway at all despite
having real infrastructure behind them.

**Registering with auth: use `auth_value`, not a type-named field.** The
`credentials` object's field for the actual secret is always `auth_value`
(check LiteLLM's own `/openapi.json` → `MCPCredentials` schema, not the
`auth_type` value) — `{"bearer_token": "..."}` is silently accepted and
silently does nothing, producing a real 401 from the upstream server rather
than an API-level error. Verify with an actual `tools/list` call after
registering, not just a 200 response from the registration POST.

**If a self-hosted wrapper crash-loops with a hardened-mode HTTP flag on**
(seen with `MCP_HTTP_HARDEN=true` specifically, but check any similar
"harden"/"production mode" flag on other wrappers): read the actual crash
log before assuming it's the same class of issue as anything else — it may
require *additional* settings (an origins allowlist, a hosts allowlist) that
are meaningless for pure server-to-server traffic but still mandatory to set
once hardening is on, and defaults tuned for local/browser use (e.g.
localhost-only host allowlists) will reject requests from a real Service DNS
name unless explicitly widened.

**A self-hosted backing service's own bot-detection/rate-limiting features
often assume an internet-facing deployment behind a real reverse proxy —
verify before enabling them for an internal-only service.** Hit this with
SearXNG specifically: its limiter requires an `X-Forwarded-For`/`X-Real-IP`
header (normally set by a reverse proxy fronting public traffic) to identify
a source IP; pod-to-pod cluster traffic never has one, so enabling the
limiter didn't just add unneeded overhead, it 429'd every request outright
with no legitimate traffic ever getting through. If a backing service's
cache/state store (Valkey, Redis, etc.) is *only* used by such a feature —
not by a separate, generally-applicable caching layer — don't assume
enabling that feature is a safe way to "make the cache do something": test
it before assuming it's compatible with an internal-only topology.

**Considered and set aside:** LiteLLM can also run a stdio server *itself*
(`transport: "stdio"` in its config, or via the Admin UI's JSON config field)
— no bridge pod at all. Not used as the default here because it runs the
tool's process inside LiteLLM's own pod, sharing its master key and database
credentials — a compromised or misbehaving tool then has a much larger blast
radius, and can affect live inference traffic. Keep it available as a
deliberate, case-by-case exception for a specific low-risk, fully-trusted
server, not the standard path.

## MCP Toolsets — curating tools across servers

When two registered servers expose overlapping capability (e.g. two
different "read a page" tools) and you want consumers to see only a curated
subset, use LiteLLM's **MCP Toolset** feature instead of relying on
per-client filtering: `POST/GET/PUT /v1/mcp/toolset` (`DELETE` by id), each
toolset naming individual `{server_id, tool_name}` pairs pulled from any
already-registered servers, exposed at its own gateway path
(`/toolset/{name}/mcp`) alongside the normal `/{server_name}/mcp` paths. This
is enforced at the LiteLLM gateway itself, so it applies uniformly to every
consumer (Open WebUI *and* external MCP-native clients) — unlike Open
WebUI's own per-connection `function_name_filter_list`, which only affects
Open WebUI's own view and does nothing for anyone else hitting the server
directly.

**Toolset access uses a different grant mechanism than `allow_all_keys`.**
There's no `allow_all_keys` equivalent on a toolset — a key needs the
toolset explicitly listed in its `object_permission.mcp_toolsets`
(`POST /key/update {"key": "...", "object_permission": {"mcp_toolsets":
[...]}}`, confirmed via LiteLLM's own `/openapi.json`). **The grant list must
contain the toolset's ID, not its name** — granting by name returns a
plain 200 from `/key/update` with no error at all, and only fails later, at
actual request time, with `403 "API key does not have access to toolset
'<toolset_id>'"`. Confirm with a real `tools/list` against
`/toolset/{name}/mcp` after granting — a 200 from `/key/update` alone proves
nothing.

## Stateful backends don't work through LiteLLM's MCP gateway (as of v1.91.0)

**LiteLLM's MCP gateway creates a brand-new backend session for every single
`tools/call`, even when the client reuses one session ID throughout the
whole conversation.** Confirmed empirically (driving an MCP session directly
against a backend pod preserved state correctly across calls; the identical
call sequence through LiteLLM — via a plain per-server gateway path *or* a
toolset path, doesn't matter which — always saw a fresh, empty backend
state) and confirmed upstream: this is a **deliberate, current architectural
stance**, not a bug waiting to be fixed. BerriAI/litellm tried adding real
persistent sessions (PR #19809, `stateless=False`, to support progress
notifications), it broke other MCP clients that don't manage
`mcp-session-id` headers (MCP Inspector, curl, etc.), and they reverted to
stateless-per-call mode (issue #20242, closed via PR #21323 "revert
StreamableHTTPSessionManager to stateless mode" + regression test PR
#22033). A newer, separate issue (#24522) shows continued problems even in
stateless mode under concurrency — this area isn't trending toward a
near-term fix.

**This only matters for backends whose tools depend on state left over from
a prior call** — a pure request-response tool (get the time, run one search)
never notices, since every call is independent regardless. It becomes a hard
blocker the moment a tool's value depends on session continuity — the
canonical case being **browser automation**: a "navigate" action typically
doesn't return page content itself, only a reference to the live page/tab;
actually reading that content requires a follow-up call (a snapshot/read
action) against the *same* browser session navigate just created, and that
session is already gone by the time LiteLLM forwards the next call.

**Workaround: have the client connect directly to the backend, bypassing
LiteLLM's gateway entirely**, for that one server. Open WebUI's own MCP
client manages real sessions correctly, so a direct connection
(`http://<service>.<namespace>:<port>/mcp` instead of going through
`litellm.<namespace>:4000`) works today. Real tradeoffs, worth deciding
explicitly rather than defaulting into: that server sits outside LiteLLM's
unified auth/spend-tracking, and an external MCP-native client wanting the
same tool needs its own separate direct route rather than the common
`api.domain.com/<name>/mcp` pattern everything else uses — there's no
generic fix here, just a per-server exception, matching the `mcp-bridge`
NetworkPolicy label's egress rule needing a matching direct-access rule on
the *consuming* pod (e.g. `open-webui-policy`) instead of relying on the
shared `litellm-policy`.

## Getting the model to reliably use the right tool

Registering a tool correctly and getting a model to reliably *choose* it are
different problems — a model can have a tool attached and available and
still not reach for it unprompted (e.g. answering from a search snippet when
the user actually wanted the full page read). Two distinct levers, depending
on where the tool lives:

- **For a tool registered in LiteLLM** (a plain server or a toolset): use
  `PUT /v1/mcp/server {"server_id": "...", "tool_name_to_description":
  {"<tool_name>": "..."}}` to override an individual tool's description.
  This is enforced server-side, so it's live for every consumer of that
  server/toolset (Open WebUI, external clients) with no per-client
  duplication — the same shared-registry benefit the whole point of this
  setup is built on. Use it to explicitly steer sequencing ("if the user
  wants a page actually read, follow up with X"), not just to fix wording.
- **For a tool a client connects to directly, bypassing LiteLLM** (the
  stateful-backend workaround above): there's no equivalent shared lever —
  Open WebUI has no per-tool description override for MCP connections. The
  only option is a per-model **system prompt** (Workspace → Models → edit,
  or `model.params.system` directly) spelling out when to reach for that
  tool. This has to be repeated per model and doesn't reach external
  clients at all — a real, accepted gap versus the LiteLLM-mediated case.

**A tool's own description can go stale the moment a related tool is
removed.** Hit this directly: `mcp-searxng`'s `searxng_web_search` tool
ships with a description telling the model to "follow up with
`web_url_read`" for full-page reads — correct when both tools are exposed,
actively wrong (pointing the model at something that no longer exists) the
moment `web_url_read` is deliberately excluded (e.g. via a toolset, in favor
of a real browser tool). Check any tool whose *own* description references
a sibling tool by name before excluding that sibling — the override above is
the fix, not just removing the sibling and moving on.

**Verify reliability with a real chat prompt, twice**: once with wording
vague enough that a model *could* get away without the tool (to see if it
naturally reaches for it), and once with an explicit instruction (to confirm
the tool itself still works end to end, isolating "doesn't want to" from
"can't"). Don't treat a single successful test as proving reliability — a
model choosing not to call a tool this time doesn't mean the wiring is
broken, and a model calling it under an explicit nudge doesn't mean it will
without one.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ADMIN BROWSER                          IDE / TUI CLIENT                  │
│  llm-admin.domain.com                   api.domain.com (bearer key)       │
│    └ CF Access: Allow, admin emails       └ CF Access: Bypass/Everyone    │
│      only, 4h session                       WAF allowlist: inference      │
│                                              paths + /mcp suffix (§4)     │
└───────────────────────┬──────────────────────────────┬───────────────────┘
                        │                              │
┌───────────────────────▼──────────────────────────────▼───────────────────┐
│  ns: llm-core                                                            │
│                                                                          │
│  litellm ── MCP Servers registry (persisted in Postgres, UI-managed)    │
│    ├──► native HTTP/SSE MCP server (external, no container)             │
│    └──► mcp-bridge-<name> pods (Supergateway, one per stdio server)     │
│           │  app: mcp-bridge label — shared NetworkPolicy, no per-      │
│           │  server edits needed                                       │
│           └──► stdio process (uvx/npx, pinned version, official image) │
└──────────────────────────────────────────────────────────────────────────┘
```

`llm-admin.domain.com` and `api.domain.com` both route to the same `litellm`
Service (step 06) — they're two differently-gated front doors to one
backend, not two backends.

---

## Access model — `llm-admin.domain.com`

### Layer 1 — Cloudflare Access (edge)
Same shape as `admin.domain.com` (step 16 §Access model): Allow / admin
emails only, 4h session with cookie refresh, login via Authentik OIDC.

### Layer 2 — LiteLLM's own SSO (app layer)
Unlike the custom Admin UI app (which checks the Authentik `groups` claim on
every request), LiteLLM's native SSO has no documented group-claim gate — its
only role-assignment mechanism is `PROXY_ADMIN_ID`, which promotes exactly
one user to Proxy Admin after first login. So the real enforcement here is:
(a) CF Access's email allowlist, and (b) an Authentik **policy binding on the
`litellm-ui` Application itself**, restricting who can even complete
authentication to `grp-admin` members — add this explicitly, don't assume
LiteLLM enforces it for you. Anyone who authenticates but isn't the
`PROXY_ADMIN_ID` user lands as an "Internal User" with reduced permissions —
verify (§6) rather than assume it self-resolves for a multi-admin setup.

---

## 1. Authentik OIDC provider + application

Applications → Providers → **Create** → OAuth2/OpenID Provider:

- Name/slug: `litellm-ui`
- Authorization flow: `default-authorization-flow`
- Redirect URI: `https://llm-admin.domain.com/sso/callback` (LiteLLM's fixed
  callback path — not `/callback` like the custom Admin UI app)
- **Enable "Include claims in id_token"**
- Access/refresh token validity: **4h** (matches the session-timeout table in
  [14-identity-sso.md](14-identity-sso.md))

Applications → Applications → **Create**, slug `litellm-ui`, linked to that
provider. Bind the same MFA policy used by every other application
(14-identity-sso.md §MFA enforcement), **and** a group-membership policy
restricting authentication to `grp-admin` — this is the real "only admins get
in" gate, per the nuance above.

Record the provider's client ID and secret — they become
`GENERIC_CLIENT_ID`/`GENERIC_CLIENT_SECRET` below.

## 2. LiteLLM SSO config + Secret

`assets/k8s/llm-core/litellm.yaml` already has the env vars wired
(`PROXY_BASE_URL`, `GENERIC_CLIENT_ID`, `GENERIC_CLIENT_SECRET`,
`GENERIC_AUTHORIZATION_ENDPOINT`, `GENERIC_TOKEN_ENDPOINT`,
`GENERIC_USERINFO_ENDPOINT`) — substitute your domain and pull the three
endpoint URLs from
`https://auth.domain.com/application/o/litellm-ui/.well-known/openid-configuration`
once the Authentik application exists, rather than guessing them.

```bash
microk8s kubectl create secret generic litellm-sso-credentials -n llm-core \
  --from-literal=client-id="<from Authentik>" \
  --from-literal=client-secret="<from Authentik>"
```

`PROXY_ADMIN_ID` is a **second-pass** step, not part of the initial rollout:
deploy, log in once via SSO, copy the resulting user_id from the LiteLLM UI,
uncomment and set `PROXY_ADMIN_ID` in `litellm.yaml`, redeploy.

## 3. Gateway API / routing

`assets/k8s/llm-platform/core-gateway.yaml` (new `llm-admin` listener) and
`assets/k8s/llm-core/core-httproutes.yaml` (new `llm-admin-route`) already
have this wired, mirroring the `api` listener/route — same backend
(`litellm:4000`), different hostname and gate. Substitute your domain (same
`sed` or `deployments/` overlay pattern as step 16 §5).

No NetworkPolicy change is needed for ingress to `litellm` — its existing
rule already allows any pod in `llm-platform` (i.e., Traefik) on port 4000,
regardless of hostname (confirmed against the live `litellm-policy`).

## 4. Cloudflare

- Zero Trust → Access → Applications → Add (Self-hosted): domain
  `llm-admin.domain.com`, session 4h + cookie refresh, Policy **Allow** /
  Emails (admin addresses), login via Authentik.
- WAF → Custom rules → add a **broad** allowlist for this host (unlike
  `api.domain.com`'s narrow one — see §Why above for the reasoning):

  ```
  http.host eq "llm-admin.domain.com" and not (
    starts_with(lower(http.request.uri.path), "/ui") or
    starts_with(lower(http.request.uri.path), "/v1/mcp") or
    starts_with(lower(http.request.uri.path), "/mcp-rest") or
    starts_with(lower(http.request.uri.path), "/.well-known/litellm-ui-config") or
    starts_with(lower(http.request.uri.path), "/litellm/.well-known") or
    starts_with(lower(http.request.uri.path), "/sso") or
    starts_with(lower(http.request.uri.path), "/get") or
    starts_with(lower(http.request.uri.path), "/update") or
    starts_with(lower(http.request.uri.path), "/public") or
    starts_with(lower(http.request.uri.path), "/health") or
    starts_with(lower(http.request.uri.path), "/key") or
    starts_with(lower(http.request.uri.path), "/team") or
    starts_with(lower(http.request.uri.path), "/organization") or
    starts_with(lower(http.request.uri.path), "/user") or
    starts_with(lower(http.request.uri.path), "/model") or
    starts_with(lower(http.request.uri.path), "/budget") or
    starts_with(lower(http.request.uri.path), "/spend") or
    starts_with(lower(http.request.uri.path), "/guardrails") or
    starts_with(lower(http.request.uri.path), "/config") or
    starts_with(lower(http.request.uri.path), "/global") or
    starts_with(lower(http.request.uri.path), "/credentials") or
    starts_with(lower(http.request.uri.path), "/cdn-cgi/access") or
    starts_with(lower(http.request.uri.path), "/litellm-asset-prefix")
  )
  ```
  Action **Block**. This is broad because CF Access already identity-gates
  this host (unlike `api.domain.com`, where the WAF allowlist is the *only*
  gate) — see step 09 §4 for that host's much narrower rule.

  **The `/cdn-cgi/access` clause is not optional.** This is CF Access's own
  callback path — it delivers the signed JWT back to the app after login
  completes. Without it, the initial redirect to Access's login page works
  fine (misleadingly, since the WAF only ever blocks the *return* trip), but
  every login attempt ends in the WAF's block page instead of reaching
  LiteLLM, because the callback itself gets blocked. This is the same class
  of bug as the `auth.domain.com` allowlist needing `/api/v3/flows/`,
  `/api/v3/root/`, `/ws/` added (step 09 §5) — any host combining CF Access
  with a narrow WAF allowlist needs its Access callback path added
  explicitly, since Access's own plumbing isn't automatically exempted from
  custom rules the way Cloudflare's other `/cdn-cgi/` diagnostic endpoints
  (e.g. `/cdn-cgi/trace`) are.

  **The `/litellm-asset-prefix` clause is the same lesson again, one layer
  further in.** Once Access lets a request through, LiteLLM's own Next.js UI
  serves its JS/CSS/font chunks from a custom asset prefix
  (`/litellm-asset-prefix/_next/static/...`) rather than nesting them under
  `/ui` — so the page shell loads but every asset 403s, distinct from the
  page failing to load at all. Confirm the exact prefix from a browser's
  DevTools Network tab rather than assuming `/_next` — LiteLLM's build uses a
  non-default prefix specifically to avoid path collisions when reverse-
  proxied, and that could change between versions.

- **One-time addition to the existing `api.domain.com` WAF rule** (step 09
  §4) so external MCP-native clients can reach any registered stdio bridge or
  native server, present or future, with zero further Cloudflare changes:
  add `ends_with(lower(http.request.uri.path), "/mcp")` to that rule's `not
  (...)` clause. `ends_with()` is available on the Free plan (unlike the
  `matches` regex operator) — this is an edit to an existing rule, not a new
  one, so it doesn't cost a custom-rule slot.
- Tunnel → Published application routes: add `llm-admin.domain.com` →
  `http://traefik.llm-platform:80` — **after** the Gateway listener +
  HTTPRoute exist (same 404-before-HTTPRoute-exists ordering warning as
  step 16 §6).

## 5. Supergateway bridge for a stdio server

Template: `assets/k8s/llm-core/mcp-bridge-time.yaml` (the `mcp-server-time`
pilot — no secrets, good for validating the chain end to end).

To add another stdio server: copy the file, rename (`mcp-bridge-<name>`),
change the `mcp-server` label, and swap the `--stdio` command with a pinned
package version. No image build — always the official
`ghcr.io/supercorp-ai/supergateway` image, pinned to a digest; the wrapped
tool's version is pinned in the command string instead. Apply, then register
`http://mcp-bridge-<name>.llm-core:8000/mcp` in LiteLLM's MCP Servers tab.

Only build a custom image if a specific tool genuinely needs one (heavy or
compiled dependencies, elevated supply-chain sensitivity) — treat it as the
exception, not the default.

**Two things confirmed the hard way while standing up the pilot:**
- **The base `supergateway` image only bundles Node/npx — no Python/uv/uvx at
  all.** A `uvx`-based tool crash-loops on it (`uvx: No such file or
  directory`, surfacing as an unhandled EPIPE when the child process dies).
  Use the `-uvx` tagged variant (e.g. `3.4.3-uvx`) for any `uvx`/Python-based
  MCP server; the plain/`:latest` tag is fine for `npx`-based ones. Verify
  which binaries an image actually has (`which uvx uv python3 node npx`)
  rather than trusting a base image's stated feature list.
- **Register as `transport: "sse"`, not `"http"` (streamable-HTTP), if tool
  discovery silently returns zero tools.** In this LiteLLM version,
  registering a Supergateway bridge running in `streamableHttp` mode as
  transport `"http"` hit a client-side bug (`httpx_sse` raised
  `UnsupportedProtocol` internally) — the "test connection" button failed
  with a generic error, and `tools/list` reported success while returning an
  empty array instead of surfacing the real error. Confirmed the bridge
  itself was spec-compliant first via a raw MCP `initialize` POST with curl,
  then switched the bridge to `--outputTransport sse` and registered it as
  transport `"sse"` — worked cleanly end to end. Worth retrying
  streamable-HTTP on a future LiteLLM upgrade rather than assuming this is
  permanent, but don't assume `"http"` works without testing an actual tool
  call, not just the registration succeeding.
- **`server_name` can't contain `-`.** The k8s Deployment/Service name can
  keep its hyphens; register under an underscored name in LiteLLM instead
  (e.g. `mcp_bridge_time`).
- **LiteLLM's "test connection" check may report failure even when the
  server works fine.** Don't treat it as authoritative — confirm with an
  actual `tools/list` and a real `tools/call` before concluding a server is
  broken.
- **An MCP Servers page that looks empty in the Admin UI doesn't mean a
  server was deleted.** An expired `llm-admin` session can 401 every
  data-fetching call on that page while the static nav/shell keeps
  rendering from cache, making it look broken rather than showing a clear
  "log in again." Confirm with the API directly
  (`GET /v1/mcp/server/{id}` by ID, or `GET /v1/mcp/server?include_health_status=true`
  — the bare list call without that parameter returns empty even when
  servers exist) before assuming data loss.
- **`allow_all_keys: false` (the default) silently empties `tools/list` for
  every key except the master key — while `initialize` still succeeds for
  everyone.** This is the most misleading failure mode encountered: a
  non-master-key client (e.g. Open WebUI) connects fine, completes the MCP
  handshake fine, and *looks* wired up correctly in every log — but
  `tools/list` quietly comes back empty for that key, so the client (and any
  model behind it) never actually sees the tool as an option at all. It's
  easy to misdiagnose this as a model tool-selection problem, since nothing
  errors — the model just never gets offered the function. Verify with the
  exact key the real client will use, not just the master key, or set
  `allow_all_keys: true` (or explicit team/key grants) up front. Tool names
  exposed this way are also prefixed with the server name (e.g.
  `mcp_bridge_time-get_current_time`), unlike the un-prefixed names LiteLLM's
  own `/mcp-rest/tools/list` convenience endpoint shows.

**Retirement:** delete the Deployment+Service *and* remove the entry from
LiteLLM's UI — both sides, or it's a dead registry entry pointing at nothing.
Update your deployment's MCP server inventory (if you keep one, see the
`deployments/` pattern in step 16) either way, so a future rebuild knows what
to re-register.

**If you register this server as a tool in Open WebUI and the connection
doesn't survive an Open WebUI restart**, that's not an MCP issue — check
`ENABLE_PERSISTENT_CONFIG` on the `open-webui` Deployment
([step 07 §4](07-webui-open-webui.md#4-confirm-the-models-appear)). With it
`false`, every admin-panel setting (this tool connection included) lives
only in process memory and is silently wiped on restart.

## 6. Verification

- From a non-Tailscale network, hit `https://llm-admin.domain.com/ui`:
  CF Access login (admin email only) → Authentik login (a non-`grp-admin`
  account should be rejected at Authentik, not just missing a role) →
  LiteLLM dashboard loads fully — Models/Keys/Teams/MCP Servers tabs all
  populate, not just the page shell.
- Confirm the bootstrap `PROXY_ADMIN_ID` user has full Proxy Admin
  capability; log in as a second admin email and check what role they land
  as — promote manually via LiteLLM's user management if they're stuck as
  Internal User and need full access. **In practice, `PROXY_ADMIN_ID` did not
  retroactively promote a user record already created by an earlier login —
  role stayed Internal User after setting it and redeploying.** The reliable
  fix is a direct API call with the master key:
  `POST /user/update {"user_id": "<id>", "user_role": "proxy_admin"}`,
  verified via `GET /user/info?user_id=<id>`. Don't assume the env var alone
  finished the job — check the role explicitly.
- `kubectl get pods -n llm-core -l app=mcp-bridge` healthy; register the
  pilot server in the UI and call its tool from Open WebUI's chat (embedded
  tool-calling path) **and** from an external MCP-native client pointed at
  `https://api.domain.com/<server-name>/mcp` with a valid bearer key
  (confirms the `ends_with` WAF addition works end to end).
- Retire the pilot server (delete its Deployment+Service, remove its UI
  entry) and confirm both sides are actually gone — no orphaned registry
  entry, no orphaned pod.

## 7. mcp-bridge-shell — command execution (elevated-risk exception)

A shell/command-execution MCP server is a different risk category from
everything else in this registry — every other tool here is read-only or
scoped to one backing service (time, search, browser automation); this one
lets a model run arbitrary whitelisted commands. Treat the steps below as
additions on top of §5, not a replacement — same Supergateway pattern, more
containment layered around it.

**Server:** [`mcp-shell-server`](https://github.com/tumf/mcp-shell-server)
(PyPI `mcp-shell-server`, pinned `1.1.2` as of 2026-07-22) — chosen over the
several other community shell-MCP servers because it execs argv directly
(`asyncio.create_subprocess_exec`, no `/bin/sh -c`, so shell metacharacters in
a model's output can't inject a second command), confines I/O redirection
paths to its working directory, ships per-call timeouts and an output-size
cap, and emits structured audit metadata per invocation.

**Custom image, not runtime `uvx`.** `assets/mcp-shell-server/Dockerfile`
bakes the package into the same `supergateway` `-uvx` base every other bridge
uses, instead of fetching it fresh from PyPI on every pod restart (the
`mcp-bridge-time.yaml` pattern). This is the "elevated supply-chain
sensitivity" exception called out in §5 above — for a command-execution tool
specifically, re-resolving the package from PyPI on every restart is a real
supply-chain exposure, not just a style choice. Build and push it like the
other custom images in this repo (`admin-ui`, `home-llm-inference` — step 04
§5-6):

```bash
sudo docker build -t localhost:32000/mcp-shell-server:latest assets/mcp-shell-server/
sudo docker push localhost:32000/mcp-shell-server:latest
```

Pin the digest into `mcp-bridge-shell.yaml` the same way (step 04 §6) once
verified working.

**The allowlist (`ALLOW_COMMANDS`) matches the executable name only, not its
arguments.** Whitelisting `git` does not distinguish `git status` from `git
push --force`; whitelisting `curl` does not distinguish a GET from a
POST/PUT/DELETE. There is no way to constrain arguments through this env var
— read the comment at the top of `mcp-bridge-shell.yaml` before adding
anything to the list, and don't assume a command is safe just because it
sounds read-only (e.g. `find` has a `-delete` flag).

**No chroot/jail exists for the commands themselves** — `directory` and
redirection targets are confined to the server's working directory, but a
whitelisted command can still read or write anywhere its own OS permissions
allow. The actual containment is the pod spec, not the MCP server:
`readOnlyRootFilesystem: true` plus two `emptyDir` scratch volumes (`/tmp`,
`/workspace`) mean a compromised or over-eager command has nothing persistent
to damage beyond that pod's own throwaway filesystem, `automountServiceAccountToken:
false` means it can't reach the k8s API even if it tried, and it's the only
bridge in this cluster with no mounted secrets at all.

**NetworkPolicy: deliberately left on the shared `mcp-bridge-policy`**
(DNS + public HTTPS, private ranges excluded), not tightened to a
zero-egress override — the "broader dev whitelist" (`git`, `npm`, `uv`)
genuinely needs that connectivity to clone repos and install packages. This
is a real, accepted residual risk: a manipulated model could use an allowed
command to exfiltrate data over HTTPS. If you ever narrow `ALLOW_COMMANDS` to
a read-only/local-only set, revisit this — that's the point where a dedicated
zero-egress NetworkPolicy (duplicating `mcp-bridge-policy` with a narrower
`mcp-server: shell` selector, per the comment in `networkpolicies.yaml`)
becomes worth the extra policy to maintain.

**Audit trail:** `mcp-shell-server` logs structured metadata (command,
outcome, truncation/timeout flags) to stdout for every call —
`kubectl logs -n llm-core deploy/mcp-bridge-shell` is where to look after the
fact, or `-f` it while testing. There's no alerting on this by default.

**Registration:** same flow as §5-6 — register
`http://mcp-bridge-shell.llm-core:8000/mcp` in LiteLLM's MCP Servers tab,
confirm with a real `tools/list` (this package's exact tool name/schema isn't
documented up front — read it off the actual response), and test both a
vague prompt and an explicit one before trusting it, per "Getting the model
to reliably use the right tool" above. Given the risk profile here, also
sanity-check what happens when a *malicious* prompt (e.g. from a fetched web
page, if this model also has browsing) tries to steer it toward a
destructive whitelisted command — this is exactly the tool where prompt
injection from untrusted content is the realistic threat model, not just a
user typing something dangerous directly.

---

## Security notes

- `llm-admin.domain.com` reaches the same `litellm` pod and process as
  `api.domain.com` — it's a different gate on the same backend, not a
  separate, lower-privilege service. Treat its CF Access email list with the
  same care as `admin.domain.com`'s.
- Every Supergateway bridge pod runs third-party tool code with network
  egress. NetworkPolicy scopes ingress to `litellm` only, but nothing stops a
  registered tool from doing whatever its own code does within its egress
  allowance — vet a server before registering it, the same caution Open
  WebUI's own docs raise about MCP servers generally.
- If `llm-admin.domain.com` is ever compromised or not worth keeping public,
  it can be torn down independently (CF Access app, WAF rule, tunnel route,
  Gateway listener, HTTPRoute) without touching `api.domain.com` or the MCP
  registry's contents — that independence was the point of using a separate
  host instead of widening `api.domain.com`'s allowlist.
- `mcp-bridge-shell` (§7) is the highest-blast-radius tool registered here —
  it's the one place a manipulated model, not just a malicious user, can turn
  into real command execution. If a model with this tool available ever also
  gets browsing/search, prompt injection from fetched content is the
  realistic threat model, not a hypothetical.
