# 15 — Identity & SSO (central IdP)

← [14 Operations](14-operations.md) · Next: [16 Workspaces](16-workspaces.md)

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

1. **Deploy Authentik** as containers (server + worker + postgres + redis) on
   `llmnet`; expose its UI only via Tailscale/Access (admin-only).
2. **Create groups**: `grp-admin`, `grp-ui`, `grp-api`, `grp-workspaces`. Assign
   each friend to the groups they need.
3. **Cloudflare Access → Authentication → add OIDC login method** pointing at
   Authentik. Replace the per-app email lists with **group-based** Access policies
   (e.g. allow `grp-ui` on `llm.`, `grp-workspaces` on the workspaces hostname).
4. **Workspace orchestrator** uses Authentik as its OIDC provider for user login
   and reads group claims for RBAC ([step 16](16-workspaces.md)).
5. *(Optional)* Wire **Open WebUI** to Authentik OIDC so UI friends SSO instead
   of local accounts.

## Authorization model (groups → capabilities)

| Group | Can | Enforced at |
|---|---|---|
| `grp-admin` | Everything; manage workspaces/users | IdP + orchestrator + Tailscale |
| `grp-ui` | Open WebUI chat | CF Access on `llm.` |
| `grp-api` | API keys (LiteLLM) | LiteLLM keys (+ optional CF service tokens) |
| `grp-workspaces` | Launch/use dev workspaces, quota tier | CF Access + orchestrator RBAC |

## Verification

- A user in `grp-ui` but **not** `grp-workspaces` can reach the chat UI but is
  denied the workspaces hostname at the Cloudflare edge.
- Removing a user from a group in Authentik revokes the corresponding access
  everywhere on next auth.

→ Continue to [16 — Workspaces](16-workspaces.md).
