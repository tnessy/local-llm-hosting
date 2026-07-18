# 16 — Admin UI

← [15 Workspaces](15-workspaces.md) · [Back to README](README.md)

> **Overview:** Deploy the Admin UI — a small internal web app at `admin.domain.com` that lets the operator provision Authentik accounts, mint/revoke LiteLLM friend keys, and manage Open WebUI accounts through a browser instead of raw `curl`/`kubectl`.
>
> **Why:** Centralises operational tasks that would otherwise require direct CLI access to multiple systems, reducing operational surface area and the risk of misconfiguration through ad-hoc commands. Closes out `security-review.md`'s `M-59` finding (no audit trail for admin actions) — every mutating action here is logged with operator identity, action, target, and outcome.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<domain.com>` | Your registered domain | From step 09 |

**v1 scope note:** the workspace orchestrator (step 15) is still just a design
doc with no code — so this build has **no workspace-management panel** and
makes no calls to an orchestrator API. Authentik user provisioning, LiteLLM
key lifecycle, and Open WebUI account visibility are fully implemented. Add
the workspace panel once step 15 actually ships.

Source: [`assets/admin-ui/`](assets/admin-ui/) (Node.js/TypeScript + Express,
server-rendered EJS views — no SPA build step).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ADMIN BROWSER                                                               │
│  admin.domain.com                                                            │
│    └ CF Access: Allow, grp-admin emails only, 4h session (refreshes on use) │
└──────────────────────────────────────────────────────────────────┬──────────┘
                                                                   │
┌──────────────────────────────────────────────────────────────────▼──────────┐
│  ns: llm-platform                                                            │
│                                                                              │
│  cloudflared ──► Traefik (core-gateway, admin listener)                      │
│                   └──► admin-ui pod                                          │
│                         │  Authentik OIDC login (grp-admin check)           │
│                         │  4h session, refreshes while active               │
│                         │                                                    │
│                         │ server-side calls only — browser never touches     │
│                         │ internal APIs directly                             │
│                         │                                                    │
│                         ├──► litellm :4000       (friend key management)    │
│                         ├──► authentik :9000      (user provisioning)       │
│                         └──► open-webui :8080     (UI user management)      │
└─────────────────────────────────────────────────────────────────────────────┘
```

(The orchestrator arrow from the original design is omitted above — v1 makes
no orchestrator calls. Re-add it once step 15 exists.)

The Admin UI is a **server-side proxy**. Every internal API call originates from
the admin-ui backend process. The browser receives only what the Admin UI
explicitly returns — internal service URLs, credentials, and raw API responses
are never forwarded to the client.

---

## Responsibility boundary

### Admin UI owns (v1)
- **Friend API keys** — mint, revoke, view spend/budget via LiteLLM `/key/*`
  endpoints (`assets/admin-ui/src/clients/litellm.ts`)
- **Authentik users** — create accounts, assign to groups (`grp-ui`,
  `grp-api`), **deactivate**. Hard delete is intentionally **not exposed** in
  the UI — it would destroy the audit-trail-adjacent user record; deactivate
  covers the real operational need (revoke access now). The client module has
  a `deleteUser()` method for future/CLI use, no route calls it.
- **Open WebUI accounts** — list, change role, delete *existing* accounts.
  Account **creation is not a manual step**: with `ENABLE_SIGNUP=false` +
  `WEBUI_AUTH_TRUSTED_EMAIL_HEADER` (step 14 §Open WebUI SSO), accounts
  self-provision on first login behind Cloudflare Access. The "Add UI friend"
  flow only creates the Authentik account + `grp-ui` membership.
- **Audit log** — every mutating action logged as structured JSON to stdout
  (timestamp, operator identity from the OIDC `sub`, action, target, outcome),
  scraped by the existing promtail → Loki pipeline. No new log infra.

### Not in v1 (design intent, needs step 15 first)
- LiteLLM model configuration browsing
- Workspace visibility / force-stop / deprovision via an orchestrator API

---

## Access model

### Layer 1 — Cloudflare Access (edge)
- Application: `admin.domain.com`, Self-hosted (already specified in
  [`assets/cloudflare-access-notes.md`](assets/cloudflare-access-notes.md) §4)
- Policy: **Allow**, rule type **Emails** — list admin email addresses only
- Session: **4 hours**, with cookie refresh on active use
- Login method: Authentik OIDC (same IdP used by all other services)

### Layer 2 — Authentik OIDC (application)
- The Admin UI validates the OIDC token on every request
- Checks the `groups` claim for `grp-admin` membership on **every request**,
  not just at login (`src/auth/middleware.ts`) — rejects with 403 if absent
- 4h session (`express-session`, in-memory store — see §Security notes)

Two independent gates: CF Access rejects unknown identities at the edge;
the app-level OIDC check ensures only `grp-admin` members reach any
admin function even if CF Access is misconfigured.

---

## Network isolation

`assets/k8s/llm-platform/admin-ui-policy.yaml` is the real NetworkPolicy:
ingress from Traefik only; egress to litellm (`llm-core:4000`), open-webui
(`llm-core:8080`), authentik-server (`:9000`), and kube-dns. No orchestrator
egress rule in v1.

**No edits were needed** to `litellm-policy`, `open-webui-policy`
(`assets/k8s/llm-core/networkpolicies.yaml`), or `authentik-server-policy`
(`assets/k8s/llm-platform/authentik-networkpolicies.yaml`) — all three
already had an `admin-ui`-shaped ingress allowance from when step 16 was
first drafted.

---

## Credentials the Admin UI holds

| Secret | Key | Used for |
|---|---|---|
| `litellm-credentials` (existing, step 04/06) | `master-key` | Friend key mint/revoke/list |
| `admin-ui-credentials` (new, this step) | `session-secret` | `express-session` cookie signing |
| ″ | `csrf-secret` | CSRF double-submit cookie signing |
| ″ | `authentik-token` | User creation, group assignment, deactivation |
| ″ | `openwebui-admin-key` | Open WebUI account list/role/delete |
| ″ | `oidc-client-id` / `oidc-client-secret` | The Admin UI's own OIDC login |

All via `secretKeyRef` — never a literal `value:` field (H-12 pattern: the
orchestrator, once it exists, has cluster-wide `pods: get/list/watch`, and
anything in a literal env field is readable from the pod spec without
touching the Secrets API).

---

## 1. Authentik OIDC provider + application

Applications → Providers → **Create** → OAuth2/OpenID Provider:

- Name: `admin-ui`
- Authorization flow: `default-authorization-flow`
- Redirect URI: `https://admin.domain.com/callback`
- Signing key: same one used by the stack's other providers
- **Enable "Include claims in id_token".** Without this the `groups` claim
  never reaches the app and every login silently 403s with no obvious cause
  — this is the single easiest step to forget.
- Access token validity / Refresh token validity: **4h** (matches the table
  in [14-identity-sso.md](14-identity-sso.md) §Session timeout alignment)

Applications → Applications → **Create**, link to the `admin-ui` provider,
slug `admin-ui`. Bind an MFA policy per
[14-identity-sso.md](14-identity-sso.md) §MFA enforcement, same as every
other application.

Create a **dedicated service-account user** for the Authentik API token —
not a personal admin's token: Directory → Users → Create (mark as a service
account), then Directory → Tokens and App passwords → Create, **User** = that
service account, **Intent = API Token**. Copy the value; it becomes
`AUTHENTIK_ADMIN_TOKEN` below.

Record the provider's client ID and secret; they become
`ADMIN_UI_OIDC_CLIENT_ID` / `ADMIN_UI_OIDC_CLIENT_SECRET` below.

## 2. Authentik groups

Confirm `grp-admin`, `grp-ui`, `grp-api`, `grp-workspaces` exist (step 14 §3
creates them). The Admin UI resolves group names to UUIDs itself via the API
— nothing to copy manually.

## 3. Build, push, and digest-pin the image

Same pattern as the inference image ([step 04 §5](04-deploy-stack-ubuntu.md)):

```bash
sudo docker build -t localhost:32000/admin-ui:latest assets/admin-ui/
sudo docker push localhost:32000/admin-ui:latest
sudo docker inspect --format='{{index .RepoDigests 0}}' localhost:32000/admin-ui:latest
```

Hand-edit `assets/k8s/llm-platform/admin-ui.yaml`'s `image:` line to
`localhost:32000/admin-ui:latest@sha256:<digest>` (step 04 §6).

## 4. Create the `admin-ui-credentials` Secret

`oidc-client-id`/`oidc-client-secret` are seeded empty and patched once the
Authentik provider exists (§1 above) — mirrors the `openwebui-credentials`
seed-then-patch pattern from step 06:

```bash
read -rsp "Paste the Authentik service-account API token, then press Enter: " AUTHENTIK_ADMIN_TOKEN; echo
read -rsp "Paste the Open WebUI admin API key, then press Enter: " OPENWEBUI_ADMIN_KEY; echo

microk8s kubectl create secret generic admin-ui-credentials -n llm-platform \
  --from-literal=session-secret="$(openssl rand -hex 32)" \
  --from-literal=csrf-secret="$(openssl rand -hex 32)" \
  --from-literal=authentik-token="$AUTHENTIK_ADMIN_TOKEN" \
  --from-literal=openwebui-admin-key="$OPENWEBUI_ADMIN_KEY" \
  --from-literal=oidc-client-id="" --from-literal=oidc-client-secret=""

# once the Authentik OIDC provider from §1 exists:
microk8s kubectl patch secret admin-ui-credentials -n llm-platform --type merge \
  -p "{\"stringData\":{\"oidc-client-id\":\"$ADMIN_UI_OIDC_CLIENT_ID\",\"oidc-client-secret\":\"$ADMIN_UI_OIDC_CLIENT_SECRET\"}}"
```

The Open WebUI admin API key comes from an existing admin account: Settings →
Account → API Keys, in the Open WebUI UI.

## 5. Apply the k8s assets

```bash
microk8s kubectl apply \
  -f assets/k8s/llm-platform/admin-ui.yaml \
  -f assets/k8s/llm-platform/admin-ui-policy.yaml \
  -f assets/k8s/llm-platform/admin-ui-httproute.yaml
```

## 6. Cloudflare

Already fully specified in
[`assets/cloudflare-access-notes.md`](assets/cloudflare-access-notes.md) §4
("Access application — Admin UI") — follow it as written. The one remaining
action is publishing the tunnel route, which that doc's §1 table already
reserves for this moment:

Zero Trust → Networks → Tunnels → your tunnel → **Published application
routes** → confirm/add `admin.domain.com` → `http://traefik.llm-platform:80`.

## 7. Verification

- Navigate to `https://admin.domain.com`: CF Access login prompt appears; a
  non-allow-listed account is rejected at the CF edge.
- Log in with a `grp-admin` Authentik account: the dashboard loads and shows
  live counts from LiteLLM/Authentik/Open WebUI.
- A `grp-ui`-only account that somehow passes CF Access is rejected with 403
  at the OIDC group check (`GET /callback` renders the "Access denied" page).
- `curl -sI https://admin.domain.com/` while logged out redirects toward
  Authentik's login flow.
- Run "Add API friend" end-to-end: confirm the Authentik user, its `grp-api`
  membership, and the LiteLLM key all exist (`/key/list`); the raw key is
  shown exactly once on the result page.
- Revoke that key from `/keys`: confirm 401 on the next inference call using it.
- Deactivate a test Authentik user from `/users`: confirm `is_active: false`
  and that no delete option is offered anywhere in the UI.
- Submit any mutating form with the hidden `_csrf` field stripped (e.g. via
  browser devtools) and confirm the request is rejected — check this once per
  route category (keys, users, friends), not just one.
- `microk8s kubectl logs -n llm-platform deploy/admin-ui` shows a structured
  audit line for every action above, including the deliberately-failed CSRF
  attempt.

---

## Security notes

- The Admin UI is the highest-privilege service in the stack after the host OS
  itself — it holds the LiteLLM master key and an Authentik service-account
  token. Keep it patched, monitored, and audited.
- All secrets are mounted via k8s Secrets (`secretKeyRef`) — never plaintext env
  literals readable from the pod spec by anything with `pods:get` (H-12 pattern).
- Sessions use `express-session`'s in-memory store, which only works correctly
  at `replicas: 1` (already pinned in `admin-ui.yaml`). If this is ever scaled
  up, sessions must move to a shared store first — otherwise requests land on
  a pod that never saw the login and users get bounced back to `/login`
  unpredictably.
- If the Admin UI is unavailable (cloudflared down, pod crash), fall back to
  Tailscale + direct curl to LiteLLM and Authentik admin APIs (steps 06, 14).
- `grp-admin` should have the fewest members of any group — ideally only the
  server operator(s).
