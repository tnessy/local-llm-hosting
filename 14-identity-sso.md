# 14 — Identity & SSO (central IdP)

← [13 Operations](13-operations.md) · Next: [15 Workspaces](15-workspaces.md)

> **Overview:** Deploy Authentik as the central OIDC identity provider, migrate Cloudflare Access authentication from email lists to OIDC groups, and configure SSO for Open WebUI and the workspace orchestrator so a single identity controls access across all client types.
>
> **Why:** As the number of client types grows past two, scattered per-service credentials become operationally unsound. Authentik is the single plane where adding or removing a person propagates to every surface immediately. This step is the prerequisite for workspaces (step 15).
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<domain.com>` | Your registered domain | From step 09 |
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
   ([step 16](16-admin-ui.md)). Each gets its own client ID and secret.
5. **Cloudflare Access → Authentication → add OIDC login method** pointing at
   `https://auth.domain.com` (Authentik's public OIDC endpoint). Replace the
   per-app email lists with **group-based** Access policies (e.g. allow `grp-ui`
   on `llm.`, `grp-workspaces` on the workspaces hostname, `grp-admin` only on
   `admin.domain.com`). See [step 09](09-connectivity-cloudflare.md) §5 for the
   `auth.domain.com` WAF rules that restrict public access to OIDC paths only.
6. **Workspace orchestrator** uses Authentik as its OIDC provider for user login
   and reads `sub` (primary key) and `groups` claims for RBAC
   ([step 15](15-workspaces.md)).
7. **Admin UI** uses Authentik OIDC with a `grp-admin` group check as its
   application-layer auth gate ([step 16](16-admin-ui.md)).
8. **Wire Open WebUI SSO via the Cloudflare Access trusted header** — not a second
   OIDC round-trip. CF Access already authenticated the user (Authentik + MFA) and
   injects `Cf-Access-Authenticated-User-Email` on every request; set
   `WEBUI_AUTH_TRUSTED_EMAIL_HEADER=Cf-Access-Authenticated-User-Email` on the
   Open WebUI deployment and it auto-signs-in the matching user — no Open WebUI
   login prompt. See §Open WebUI SSO below.

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
([step 09](09-connectivity-cloudflare.md) §5) — the admin UI is not reachable
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

**Per-group MFA strength (optional but recommended):** require **TOTP/WebAuthn for
admins** while allowing **TOTP _or_ Email** for regular users. Create two
Authenticator Validation stages — `mfa-validate-admin` (device classes: TOTP,
WebAuthn) and `mfa-validate-friends` (TOTP, Email) — and bind **both** to
`default-authentication-flow` (after password, before login), each with a **Group
binding to `grp-admin`**: the admin stage un-negated, the friends stage **negated**.
Set "Not configured action" = **Force the user to configure an authenticator** (with
the matching setup stages listed), never "Deny".

> **Critical:** on both stage bindings set **"Evaluate when flow is planned" = OFF**
> and **"Evaluate when stage is run" = ON**. The flow plan is built while the user is
> still anonymous, so a group check evaluated at plan time always fails — you must
> defer it to execution (after identification) or the wrong stage (or no stage) is
> selected.

**Email as a factor** needs SMTP. Configure it **per-stage in the Authenticator
Email stage's own connection fields** (host/port/user/pass/from — kept in Authentik's
DB, not a k8s Secret) rather than the global `AUTHENTIK_EMAIL__*` env. Port 465 =
**Use SSL**; 587 = **Use TLS** (not both), and the `From` must be an address the
mailbox is authorized to send as. For the Email authenticator to appear in user
enrollment, create a **Stage Configuration** flow containing the Email setup stage
and set it as that stage's **Configuration flow**. Email is the weakest factor —
keep it off admin accounts.

### Brute-force lockout

Authentik's built-in reputation system rate-limits failed logins:

1. **Flows & Stages → Stages → default-authentication-login** → edit the
   **User Login Stage** → set **Failed attempts before cancel: 5**.
2. **Policies → Create → Reputation Policy** — leave **threshold at its default
   `-5`** (a *negative* number; failed logins drive a score down, so the block
   condition is a low score). Bind it to the default-authentication-flow with
   order 0 (evaluated before the password stage) **and tick "Negate result" on
   the binding**. A source IP that accumulates ~5 failed logins is then blocked
   for the lockout window (default 600 s; tune to taste).

   > **Why negate is mandatory (do not skip):** a Reputation Policy `passes`
   > (returns *true*) only when the score is **≤ threshold** — i.e. it matches
   > **bad** actors, not good ones. A flow-level binding makes the flow
   > *applicable* only when its policies pass. So an **un-negated** binding makes
   > the login flow apply **only to already-flagged IPs** and denies **everyone
   > with a normal score of 0** (`0 <= -5` is false) — the flow becomes
   > non-applicable and the OIDC authorize endpoint returns a bare **"Not Found"
   > (HTTP 404)** page for all users. Negating inverts it: the flow applies to
   > good users (score 0) and is denied only for bad-reputation IPs. Setting a
   > *positive* threshold like `5` is also wrong — `0 <= 5` is true, so the gate
   > passes for everyone (including bad actors) and does nothing.
3. Complement with the Cloudflare WAF rate limit on `/if/flow/` — 10 req/min
   per IP, block 5 min ([step 09](09-connectivity-cloudflare.md) §5). This
   provides edge-level protection before requests even reach Authentik.

> ⚠️ **Enable the reputation policy AFTER Authentik is behind Cloudflare (Phase 4),
> not while you're setting up over a `kubectl port-forward`.** Over a port-forward
> every request's source IP is `127.0.0.1`, so any failed logins during setup poison
> that single IP's reputation — and a reputation policy bound to the *flow* then
> denies the **entire flow for everyone** with the misleading message *"Flow does
> not apply to current user"* (it's a flow-level policy denial, not an MFA problem).
> Behind Cloudflare, real client IPs arrive via `X-Forwarded-For` and per-IP
> reputation works correctly. If you self-lock during setup: **disable the flow's
> reputation policy binding** to get back in, and clear poisoned scores via
> `/api/v3/policies/reputation/scores/`.
>
> **Same 404 symptom, second cause — a mis-negated binding.** If `auth.<domain>`
> shows Authentik's "Not Found" page for *every* user (even with an **empty**
> reputation store), the reputation binding is almost certainly **un-negated**
> (see step 2). Verify and fix from the Authentik shell:
> ```bash
> microk8s kubectl -n llm-platform exec deploy/authentik-server -- ak shell -c "
> from authentik.flows.models import Flow
> from authentik.policies.models import PolicyBinding
> f=Flow.objects.get(slug='default-authentication-flow')
> b=PolicyBinding.objects.filter(target=f, policy__isnull=False).first()
> b.negate=True; b.save(); print('negate set to', b.negate)"
> ```
> Then confirm the authorize endpoint returns **302 → /if/flow/…** instead of 404.

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

## Open WebUI SSO (trusted header)

Behind Cloudflare Access, **don't** federate Open WebUI to Authentik directly —
that double-prompts the user (CF Access already ran the full Authentik + MFA
login). Instead have Open WebUI trust the identity CF Access asserts:

- CF Access injects **`Cf-Access-Authenticated-User-Email`** on every
  authenticated request to `chat.domain.com`.
- Set **`WEBUI_AUTH_TRUSTED_EMAIL_HEADER=Cf-Access-Authenticated-User-Email`** on
  the Open WebUI deployment (see `assets/k8s/llm-core/open-webui.yaml`). Open WebUI
  reads the header and auto-signs-in the matching user — no second login form.

> **Security:** trusted-header auth is only safe because the **sole ingress path**
> is `cloudflared → traefik → open-webui` (enforced by the NetworkPolicies in
> [step 04 §8](04-deploy-stack-ubuntu.md)) and CF Access **strips any
> client-supplied `Cf-Access-*` header at the edge**. If Open WebUI were reachable
> by any path that bypasses Cloudflare, an attacker could set the header and
> impersonate anyone — so never expose it outside the tunnel.

> **Account matching is by email.** Open WebUI maps the header to a user by email.
> If your existing admin account's email differs from the CF Access identity, the
> header creates a **new, non-admin** account instead of logging into the admin
> one. Align the admin account's email with the CF identity (or promote the new
> account) before relying on this. Inspect accounts with:
> ```bash
> microk8s kubectl -n llm-core exec deploy/open-webui -- \
>   python3 -c "import sqlite3; c=sqlite3.connect('/app/backend/data/webui.db'); print(list(c.execute('select email, role from user')))"
> ```

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

→ Continue to [15 — Workspaces](15-workspaces.md).
