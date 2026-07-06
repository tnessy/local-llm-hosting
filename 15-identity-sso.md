# 15 — Identity & SSO (central IdP)

← [14 Operations](14-operations.md) · Next: [16 Workspaces](16-workspaces.md)

> **Overview:** Deploy Authentik as the central OIDC identity provider, migrate Cloudflare Access authentication from email lists to OIDC groups, and configure SSO for Open WebUI and the workspace orchestrator so a single identity controls access across all client types.
>
> **Why:** As the number of client types grows past two, scattered per-service credentials become operationally unsound. Authentik is the single plane where adding or removing a person propagates to every surface immediately. This step is the prerequisite for workspaces (step 16).
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<domain.com>` | Your registered domain | From step 08 |
> | `<server-lan-ip>` | Server's static LAN IP | From step 02 |

Adding on-demand workspaces (the 3rd client type) is the moment to **unify
identity**. Today auth is split: Cloudflare Access emails (UI) and LiteLLM keys
(API). A central **OIDC identity provider** gives one place to add/remove a
person and one source of group/role truth across **all three** client types.

Decision **D11**: self-host **Authentik** (Keycloak/Zitadel are equivalent
alternatives) as the IdP.

## Why an IdP now

- **Workspaces need real login + RBAC** (who can launch what, quotas). Rolling
  that per-app is the trap you flagged ("figure out authn/authz").
- Cloudflare Access can **federate** to a generic OIDC IdP, so the same identity
  gates `llm.`, the workspaces, and (optionally) `api.`.
- Groups in the IdP become your authorization model (e.g. `grp-ui`,
  `grp-workspaces`, `grp-admin`) used everywhere.

## Architecture

```
                 ┌──────────── Authentik (OIDC IdP) ────────────┐
                 │  users, groups (grp-ui, grp-workspaces, …)    │
                 └───▲───────────────▲───────────────▲──────────┘
                     │ federate       │ OIDC          │ OIDC
            Cloudflare Access   Workspace orchestrator  (future: Open WebUI SSO)
            (edge identity)     (login + RBAC)
```

## Setup outline

1. **Deploy Authentik** (server + worker + postgres + redis) via its Helm chart
   into the `llm-platform` namespace. Generate secrets before first launch — see
   §Authentik hardening → Secrets below. Once the pods are running, apply the
   Authentik NetworkPolicies (they layer on the `llm-platform` default-deny from
   [step 04 §8](04-deploy-stack-ubuntu.md)):
   ```bash
   # Verify the chart's pod labels first, then apply:
   microk8s kubectl get pods -n llm-platform --show-labels | grep authentik
   microk8s kubectl apply -f assets/k8s/llm-platform/authentik-networkpolicies.yaml
   ```
2. **Harden Authentik before exposing it** — complete all steps in
   §Authentik hardening below before routing `auth.domain.com` to it.
3. **Create groups**: `grp-admin`, `grp-ui`, `grp-api`, `grp-workspaces`. Assign
   each person to the groups they need. `grp-admin` should have the fewest
   members — operator accounts only.
4. **Create OIDC provider applications** in Authentik for each service that uses
   OIDC login: CF Access federation, workspace orchestrator, and the Admin UI
   ([step 17](17-admin-ui.md)). Each gets its own client ID and secret.
5. **Cloudflare Access → Authentication → add OIDC login method** pointing at
   `https://auth.domain.com` (Authentik's public OIDC endpoint). Replace the
   per-app email lists with **group-based** Access policies (e.g. allow `grp-ui`
   on `llm.`, `grp-workspaces` on the workspaces hostname, `grp-admin` only on
   `admin.domain.com`). See [step 08](08-connectivity-cloudflare.md) §5 for the
   `auth.domain.com` WAF rules that restrict public access to OIDC paths only.
6. **Workspace orchestrator** uses Authentik as its OIDC provider for user login
   and reads `sub` (primary key) and `groups` claims for RBAC
   ([step 16](16-workspaces.md)).
7. **Admin UI** uses Authentik OIDC with a `grp-admin` group check as its
   application-layer auth gate ([step 17](17-admin-ui.md)).
8. *(Optional)* Wire **Open WebUI** to Authentik OIDC so UI friends SSO instead
   of maintaining separate local accounts.

## Authentik hardening

Authentik's OIDC and login-flow endpoints are publicly reachable via
`auth.domain.com` (Cloudflare WAF restricts all other paths). Complete these
steps before the tunnel route is active.

### Secrets

Generate these **before first launch** — neither can be safely rotated after
Authentik has running sessions or stored data.

```bash
openssl rand -hex 32   # → AUTHENTIK_SECRET_KEY
openssl rand -hex 32   # → postgres password (AUTHENTIK_POSTGRESQL__PASSWORD / PG_PASS)
```

Store them as a Kubernetes Secret in `llm-platform` (encrypted at rest by the
`secretbox` provider from [step 04 §2](04-deploy-stack-ubuntu.md)) and reference
them from the Helm values via `existingSecret` / `secretKeyRef` — never inline
values in the Helm chart, which land readable in the release ConfigMap.

> **`AUTHENTIK_SECRET_KEY` is permanent.** It signs tokens and encrypts stored
> credentials. Rotating it after initial setup immediately invalidates every active
> session across every SSO-protected service — all users are logged out
> simultaneously. Treat it identically to `LITELLM_SALT_KEY`: store in your
> password manager and never rotate without a coordinated maintenance window.

### Admin UI access (Tailscale only)

The Cloudflare WAF blocks `/if/admin/` and `/api/v3/` on `auth.domain.com`
([step 08](08-connectivity-cloudflare.md) §5) — the admin UI is not reachable
from the public internet. Access it exclusively via `kubectl port-forward` over
your Tailscale connection:

```bash
microk8s kubectl port-forward svc/authentik-server 9000:9000 -n llm-platform
# Open http://localhost:9000/if/admin/ in your browser
# Ctrl+C when done — do not leave the forward running unattended
```

### MFA enforcement

Create a default authentication policy that requires a second factor for every
user. Apply it as the binding on every OIDC application in Authentik:

1. **Flows & Stages → Stages → Create** — add a **TOTP Authenticator Validation
   Stage** (or WebAuthn if you prefer hardware keys).
2. **Flows → default-authentication-flow → Stage Bindings → Add** — bind the
   TOTP stage with order 20 (after password, before session).
3. In each OIDC application's **Policy/Group/User Bindings**, add a policy that
   checks `ak_is_verified_for_session` = true. This blocks any session that
   skipped MFA.
4. After setup: verify by logging in with a test account — Authentik must
   prompt for a TOTP code before issuing the OIDC token.

### Brute-force lockout

Authentik's built-in reputation system rate-limits failed logins:

1. **Flows & Stages → Stages → default-authentication-login** → edit the
   **User Login Stage** → set **Failed attempts before cancel: 5**.
2. **Policies → Create → Reputation Policy** — threshold: 5. Bind it to the
   default-authentication-flow with order 0 (evaluated before the password
   stage). A source IP that accumulates 5 failed logins is blocked for the
   lockout window (default 600 s; tune to taste).
3. Complement with the Cloudflare WAF rate limit on `/if/flow/` — 10 req/min
   per IP, block 5 min ([step 08](08-connectivity-cloudflare.md) §5). This
   provides edge-level protection before requests even reach Authentik.

### akadmin lockdown

The built-in `akadmin` account is a well-known target:

1. Create a named admin account (e.g. your personal email) and add it to
   `grp-admin`.
2. **Admin → Users → akadmin → Edit** — set a long random password, enable MFA,
   then **Deactivate** the account. The account must exist (Authentik requires
   it) but should never be used for day-to-day access.
3. Log in with your named admin account to verify access before deactivating
   akadmin.

### Session timeout alignment

Align Authentik token lifetimes with the CF Access session durations:

| Application | CF Access session | Authentik token lifetime |
|---|---|---|
| `llm.domain.com` | 24 h | 24 h |
| `admin.domain.com` | 4 h | 4 h |
| `auth.domain.com` (IdP itself) | — | Refresh token: 30 days; access token: 5 min |
| `*.ws.domain.com` | 24 h | 24 h |

Set these in **Applications → Providers → (each provider) → Access token
validity** and **Refresh token validity**.

## Authorization model (groups → capabilities)

| Group | Can | Enforced at |
|---|---|---|
| `grp-admin` | Full management: provision/deprovision users, manage keys, view/stop workspaces | CF Access (`admin.`) + Admin UI OIDC group check |
| `grp-ui` | Open WebUI chat | CF Access on `llm.` |
| `grp-api` | LiteLLM API inference (virtual key required) | LiteLLM key auth |
| `grp-workspaces` | Launch/use dev workspaces, quota tier | CF Access + orchestrator RBAC |

## Verification

- A user in `grp-ui` but **not** `grp-workspaces` can reach the chat UI but is
  denied the workspaces hostname at the Cloudflare edge.
- A user not in `grp-admin` is denied `admin.domain.com` at the CF edge; a user
  who passes CF Access but is not in `grp-admin` is rejected with 403 by the
  Admin UI OIDC check.
- Removing a user from a group in Authentik takes effect at next auth for
  CF Access-gated services; the Admin UI deprovision flow handles LiteLLM key
  revocation immediately.

→ Continue to [16 — Workspaces](16-workspaces.md).
