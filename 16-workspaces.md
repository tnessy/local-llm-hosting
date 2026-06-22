# 16 — On-demand workspaces (3rd client type)

← [15 Identity & SSO](15-identity-sso.md) · [Back to README](README.md)

The 3rd client type: the host spins up **on-demand Linux dev environments**
(hardened containers) that users reach **from anywhere** via a browser IDE, with
**LiteLLM access baked in**. Decision **D12**: a **custom orchestrator/UI**
managing **hardened Docker containers**, browser IDE (code-server), for the same
trusted-friend group. Coder/Kasm are kept as reference (see end).

> ⚠️ A workspace is **arbitrary code execution by design**, with network reach to
> LiteLLM. Treat every workspace as semi-hostile: isolate it from the LAN, the
> management plane, and other workspaces. Containers are an adequate boundary for
> *trusted* friends **only when hardened** (below). If trust ever drops, the
> upgrade path is microVMs (Kata/Firecracker) with the same orchestrator.

## Architecture

```
 User (browser) ─► ws-<id>.ws.domain.com
                    └ CF Access (OIDC → Authentik, grp-workspaces) ─► Tunnel
                                                                        │
                                              ┌─────────────────────────▼─────────┐
                                              │ Traefik (routes hostname → ws ctr) │
                                              └─────────────────────────┬─────────┘
                                                                        │  ws-net (isolated)
   ┌──────────────── Orchestrator (custom UI + control API) ───────────┐│
   │ - OIDC login (Authentik) + RBAC (groups → quota tier)            ││
   │ - lifecycle: launch from base image / stop / idle-TTL / destroy  ││
   │ - provisions: scoped LiteLLM key, env, home volume, route        ││
   │ - holds the Docker socket (NEVER mounted into workspaces)        ││
   └──────────────────────────────────────────────────────────────────┘│
                                                                        ▼
                                   ┌──────────── workspace container ───────────┐
                                   │ code-server (VS Code in browser)           │
                                   │ toolchain + preconfigured LLM clients      │
                                   │ env: OPENAI_API_BASE=api.domain.com/v1     │
                                   │      OPENAI_API_KEY=<scoped LiteLLM key>    │
                                   │ persistent /home volume per user           │
                                   └──────────── egress: internet + LiteLLM ────┘
                                                  (DENY LAN / mgmt / engine port)
```

## Components to build

1. **Orchestrator (the custom part)** — a small service + UI that:
   - Logs users in via **Authentik OIDC** ([step 15](15-identity-sso.md)); reads
     group claims for RBAC and quota tier.
   - Exposes "launch workspace from base image X" → creates a container via the
     **Docker API**, applies limits, wires networking, and registers a Traefik
     route `ws-<id>.ws.domain.com`.
   - Tracks ownership so a user only sees/reaches **their** workspaces.
   - Runs the lifecycle: idle auto-stop (TTL), manual stop/start, destroy.
   - **Holds Docker socket access itself** — this is the crown jewel; never
     expose it to workspaces or the public. Reachable admin-only (Tailscale +
     `grp-admin`).
2. **Traefik (reverse proxy)** — routes the per-workspace wildcard hostnames to
   the right container; one place for the tunnel to target.
3. **Base images** — a curated registry (e.g. `ws-python`, `ws-node`,
   `ws-fullstack`) each containing code-server + toolchain + **preconfigured LLM
   clients** (Aider/Continue) pointing at LiteLLM. See
   [`assets/workspace-base/Dockerfile`](assets/workspace-base/Dockerfile).

## Access (from anywhere)

- Add a **wildcard tunnel route** `*.ws.domain.com → http://traefik:80` (step 08
  pattern) and a **wildcard cert** (Cloudflare provides edge TLS).
- A **Cloudflare Access** application on `*.ws.domain.com` with an **Allow** policy
  for `grp-workspaces` (federated to Authentik). Unauthenticated users are
  rejected at the edge before reaching Traefik.
- Defense in depth: edge identity (Access) + orchestrator ownership check +
  code-server's own session.

## LLM access from inside a workspace

- On launch, the orchestrator mints a **short-lived, per-user scoped LiteLLM key**
  (`/key/generate` with `max_budget`, `rpm_limit`, model allowlist — see
  [step 06](06-gateway-litellm.md)) and injects it as `OPENAI_API_KEY` +
  `OPENAI_API_BASE=https://api.domain.com/v1`.
- Base images pre-configure Aider/Continue to those env vars, so tools work out
  of the box and **usage is attributed and budgeted per user**.
- **No GPU** in workspaces — they call LiteLLM over the network, so they never
  contend for VRAM.

## Resource management

Per workspace (Docker limits): `--cpus`, `--memory`, `--pids-limit`, disk quota
on the home volume. Globally: max concurrent workspaces per user and overall;
**idle TTL auto-stop**; destroy ephemeral workspaces on stop (persist only the
home volume). Map quota tiers to IdP groups (e.g. `grp-workspaces` = 2 vCPU /
4 GB / 1 concurrent).

## Scoping & container hardening (required)

Network:
- Dedicated **`ws-net`** Docker network, **isolated** from `llmnet` and the
  management plane (`com.docker.network.bridge.enable_icc=false` so workspaces
  can't talk to each other).
- **Egress firewall**: allow DNS + general internet (pip/npm need it) + the
  public `api.domain.com`; **DENY** RFC1918/LAN, the management VLAN, the
  Tailscale subnet, and the engine's internal `inference:8080`. Workspaces reach
  models only via the public, authenticated LiteLLM endpoint.

Container hardening:
- **Never** mount the Docker socket into a workspace.
- Run as **non-root**; enable **userns-remap** (or rootless Docker).
- `--security-opt no-new-privileges`, default/strict **seccomp**, drop all
  capabilities and add back none unless required, read-only root FS with a
  writable `/home` + `/tmp`.
- `--pids-limit`, memory/CPU limits, no host bind mounts.

## Security caveats

- Containers are **not** a strong boundary against a determined attacker. This
  design is sized for **trusted friends** + hardening. If you later open it to
  less-trusted users, switch the runtime to **Kata/Firecracker microVMs**
  (orchestrator and templates stay; only the runtime changes).
- The **orchestrator is host-root-equivalent** (Docker socket). Keep it
  admin-only (Tailscale + `grp-admin`), patched, and audited.

## Reference: adopting a platform instead

If the custom build grows heavy, these map onto the same design:

| This design's piece | Coder | Kasm |
|---|---|---|
| Orchestrator + UI | Coderd + templates (Terraform) | Kasm manager |
| Base images | Workspace templates | Kasm images |
| AuthN/AuthZ | Built-in OIDC + RBAC | Built-in OIDC + RBAC |
| Browser IDE | code-server / web IDE | Streamed container desktop/app |
| Quotas/TTL | Built-in | Built-in |

Either would replace most of "Components to build" with configuration. Revisit
**D12** in the [README](README.md) if the custom UI scope balloons.

## Verification

- A `grp-workspaces` user logs in (Authentik), launches `ws-python`, and reaches
  it at `ws-<id>.ws.domain.com` in the browser; Aider inside works against
  LiteLLM with the injected key.
- A non-`grp-workspaces` user is denied at the Cloudflare edge.
- From inside a workspace: `curl http://inference:8080` and any LAN IP **fail**;
  `https://api.domain.com/v1/models` **succeeds**.
- Idle workspace auto-stops after TTL; home volume persists across relaunch.
- Docker socket is **not** present inside the workspace (`ls /var/run/docker.sock`
  absent).
