# Home LLM Server — Setup Guide

A dedicated GPU server on your home LAN that hosts local LLMs, serving:

- **Non-technical friends** — a browser chat UI (Open WebUI), no installs.
- **Technical friends** — an OpenAI/Anthropic-compatible API for their own tools
  (Continue, Aider, Codex, Claude Code, opencode, …).
- **Workspace users** — on-demand browser dev environments (hardened containers)
  spun up by the host, with LiteLLM access baked in, reachable from anywhere.
- **You (admin)** — full control over the box, kept entirely off the public
  internet.

Identity is unified by a self-hosted **OIDC IdP** (Authentik); Cloudflare Access
federates to it so one set of users/groups governs all client types.

Friends connect through **Cloudflare** (no VPN, no open router ports). You
administer through **Tailscale** (private overlay). A single GPU is time-shared
across models by **llama-swap**, which loads/unloads **TabbyAPI + ExLlamaV3**
models on demand. **LiteLLM** sits in front as the API gateway (per-user keys,
budgets, and dialect translation).

---

## Architecture (end-to-end)

```
 CLIENTS                       CONNECTIVITY                 SERVER (single GPU box / MicroK8s)
 ───────────────────────────   ─────────────────────────   ──────────────────────────────────────

 UI friend (browser) ────────► llm.domain.com
                                └ CF Access (Google/OTP) ──► Open WebUI        [ns: llm-core]
                                                                    │
 Coder friend                                                       ▼
   Continue (IDE)                                         LiteLLM (per-user keys,
   Aider (CLI/TUI)    ────────► api.domain.com             budgets, dialects)   [ns: llm-core]
   opencode/Codex/                └ CF Access BYPASS + WAF ──►     │
   Claude Code                      (virtual-key auth)             ▼
                                                         llama-swap + TabbyAPI + ExLlamaV3
                                                         (one GPU, on-demand model swap)
                                                                              [ns: llm-core]
 Workspace user (browser) ──► ws-<id>.ws.domain.com
                                └ CF Access (OIDC→Authentik) ──► Traefik (Gateway API)
                                                                  [ns: llm-platform]  │
                                                                                       ▼
                                                                            code-server pod
                                                                            [ns: ws-<user>]
                                                                                 │
                                    ╔════════════════════════════════════════════╝
                                    ║  in-cluster, no public internet hop
                                    ▼  virtual-key auth + budgets enforced
                                  LiteLLM [ns: llm-core]

                              Orchestrator (k8s API) manages launch/stop/TTL [ns: llm-platform]

 You (admin) ───────────────► Tailscale (private) ──► SSH           └─ optional:
                               never public                           ComfyUI (SD), Tabby (FIM)

 Identity: Authentik (OIDC) ◄── Cloudflare Access federates ──► governs all client types
                                                                              [ns: llm-platform]
```

Internal service map (MicroK8s, nothing but the tunnel and Tailscale leave the box):

| Service | Namespace | In-cluster address | Reached by |
|---|---|---|---|
| `inference` (llama-swap + TabbyAPI) | `llm-core` | `http://inference.llm-core:8080/v1` | LiteLLM only (NetworkPolicy) |
| `litellm` | `llm-core` | `http://litellm.llm-core:4000` | cloudflared (`api.`), Open WebUI, workspace pods |
| `open-webui` | `llm-core` | `http://open-webui.llm-core:8080` | cloudflared (`llm.`) |
| `cloudflared` | `llm-platform` | — (outbound tunnel) | Cloudflare edge |
| `authentik` (IdP) | `llm-platform` | `http://authentik.llm-platform:9000` | CF Access, orchestrator |
| `traefik` (Gateway API) | `llm-platform` | `http://traefik.llm-platform:80` | cloudflared (all hostnames) |
| `orchestrator` | `llm-platform` | admin-only | Tailscale + `grp-admin`; uses k8s API |
| workspace `ws-<id>` | `ws-<username>` | in-namespace ClusterIP | Traefik only (NetworkPolicy) |

---

## Decisions log

Reference these when you want to revisit a choice. Each links to the step where
it's implemented, so changing a decision = editing that step.

| # | Decision | Choice | Why / alternatives | Implemented in |
|---|---|---|---|---|
| D1 | Friend connectivity | **Cloudflare Tunnel + Access** | No VPN/installs, no open router ports. Alt: Tailscale (rejected — requires a client per friend). | [09](09-connectivity-cloudflare.md) |
| D2 | Admin connectivity | **Tailscale** | Keeps host UI / SSH / engine off the public internet. | [08](08-connectivity-tailscale.md) |
| D3 | GPU sharing | **llama-swap** (on-demand swap) | One GPU time-shared cleanly. Alt: run two engines concurrently (rejected — VRAM contention). | [05](05-inference-tabbyapi-llamaswap.md) |
| D4 | Inference engine | **TabbyAPI + ExLlamaV3** (EXL2-compatible) | Fastest INT4 on a single consumer GPU; EXL3 default for new models. Alt: vLLM (concurrency, static model), Ollama (simplest). | [05](05-inference-tabbyapi-llamaswap.md) |
| D5 | API gateway | **LiteLLM** | Per-user keys/budgets + OpenAI/Responses/Anthropic dialect translation. | [06](06-gateway-litellm.md) |
| D6 | Web UI | **Open WebUI** | General-chat-first + RBAC auth boundary. Alt: AnythingLLM (RAG-first — rejected for this use). | [07](07-webui-open-webui.md) |
| D7 | Coding clients | **Continue (IDE) + Aider (CLI)** | Model-agnostic, forgiving of local models. Any OAI/Anthropic tool also works. | [11](11-clients.md) |
| D8 | Host OS | **Ubuntu Server (latest LTS)** | Plain Linux — no NAS overhead; best NVIDIA/CUDA driver support; runs MicroK8s + Docker (as an image builder) cleanly. Alt: Debian (slightly more manual NVIDIA setup), Arch (rolling — too risky for 24/7). | [02](02-host-os-ubuntu.md) |
| D9 | Model format/picks | **EXL3 quants, deferred** | EXL3 default (EXL2 still loads); finalize at GPU purchase; sizing table in step 05. | [05](05-inference-tabbyapi-llamaswap.md) |
| D10 | Optional services | **ComfyUI (SD), Tabby (FIM)** | Add later; mind VRAM contention. | [10](10-optional-comfyui-tabby.md) |
| D11 | Identity / SSO | **Authentik (OIDC IdP)** | One user/group source for all client types; CF Access federates to it. Alt: Keycloak/Zitadel. | [14](14-identity-sso.md) |
| D12 | Workspaces (3rd client) | **MicroK8s + custom orchestrator + hardened pods, browser IDE** | On-demand dev envs; GPU-free; workspace pods reach LiteLLM in-cluster (no public hop); NetworkPolicy enforces isolation. Ingress via Traefik + Gateway API (ingress-nginx EOL March 2026). Alt (reference): Coder, Kasm. | [15](15-workspaces.md) |
| D13 | Frontier / hosted-model access | **Per-user bring-your-own (BYO) provider keys — no shared global key** | Each user supplies their **own** hosted-provider token (Anthropic / OpenAI / OpenRouter …) in Open WebUI or with their API calls; the host never configures one global key all users share — avoids fronting the frontier bill and the blast radius of a shared secret. Both the `chat` (Open WebUI) and `api` (LiteLLM) paths route to hosted models **only with the caller's own key**; local models stay keyless behind LiteLLM. **Deferred — local-only for now.** | planned: [06](06-gateway-litellm.md) / [07](07-webui-open-webui.md) |

### How to change a decision later

1. Edit the relevant step file (column above) and the matching `assets/` config.
2. Because **LiteLLM fronts the backend**, swapping the inference engine (D3/D4)
   or models (D9) does **not** require any client to reconfigure.
3. Update this table's "Choice" cell so the log stays the source of truth.

---

## Table of contents

Follow in order.

> **Keep deployment specifics out of these files.** This guide is generic — no
> hardware, IPs, timezone, or version numbers, since those change over time.
> Record your build's concrete values in a per-deployment companion doc (e.g.
> `deployments/<host>.md`) and substitute them wherever a step shows a
> `<placeholder>`. The `deployments/` directory is git-ignored, so your build's
> IPs, hostnames, and versions stay out of version control.

| Step | Document | What it does |
|---|---|---|
| 01 | [Prerequisites](01-prerequisites.md) | Domain on Cloudflare, accounts, hardware checklist |
| 02 | [Host OS + GPU (Ubuntu)](02-host-os-ubuntu.md) | Install Ubuntu Server, NVIDIA driver + container toolkit, Docker (image builder) |
| 03 | [Storage (Ubuntu)](03-storage-ubuntu.md) | Format NVMe, mount at `/srv/models` |
| 04 | [Bootstrap MicroK8s + deploy core stack](04-deploy-stack-ubuntu.md) | Install MicroK8s + add-ons, deploy inference/litellm/open-webui/cloudflared/Traefik |
| 05 | [Inference engine + models](05-inference-tabbyapi-llamaswap.md) | Engine config, fetch EXL3, set context, validate tool-calling |
| 06 | [Gateway: LiteLLM](06-gateway-litellm.md) | Virtual keys, budgets, dialect routes |
| 07 | [Web UI: Open WebUI](07-webui-open-webui.md) | Accounts, signup off, model wiring |
| 08 | [Connectivity — admin (Tailscale)](08-connectivity-tailscale.md) | Admin overlay + ACL + VLAN |
| 09 | [Connectivity — friends (Cloudflare)](09-connectivity-cloudflare.md) | Tunnel + Access + WAF |
| 10 | [Optional: ComfyUI + Tabby](10-optional-comfyui-tabby.md) | Image gen + autocomplete |
| 11 | [Clients](11-clients.md) | Open WebUI, Continue, Aider, Codex, Claude Code |
| 12 | [Verification](12-verification.md) | End-to-end + negative tests |
| 13 | [Operations](13-operations.md) | Backups, updates, key rotation, monitoring |
| 14 | [Identity & SSO](14-identity-sso.md) | Central Authentik IdP; CF Access federation; groups → RBAC |
| 15 | [Workspaces](15-workspaces.md) | On-demand browser dev environments (3rd client type) |
| 16 | [Admin UI](16-admin-ui.md) | OIDC-gated control plane for user / key / workspace management |

Shared config artifacts live in [`assets/`](assets/) and are referenced (not
duplicated) by the steps above.

---

## Maintenance

Once the stack is live, **operational runbooks** — hardware swaps, upgrades,
recovery, routine upkeep — live in [`maintenance/`](maintenance/). Unlike the
numbered setup above, these are standalone and run on-demand.

| Runbook | Use when |
|---|---|
| [GPU — replace / upgrade / add](maintenance/gpu-replace.md) | Swapping, upgrading, or adding a GPU |

---

## Status checklist

- [ ] 01 Prerequisites (domain, Cloudflare, Tailscale, hardware)
- [ ] 02 Host OS + GPU passthrough
- [ ] 03 Fast model storage
- [ ] 04 MicroK8s bootstrapped + core stack deployed
- [ ] 05 Inference engine + models (TabbyAPI/llama-swap, EXL3 pulled, context set, tool-calling validated)
- [ ] 06 LiteLLM gateway + per-friend keys
- [ ] 07 Open WebUI accounts (signup disabled)
- [ ] 08 Tailscale admin plane + VLAN
- [ ] 09 Cloudflare Tunnel + Access + WAF
- [ ] 10 (Optional) ComfyUI / Tabby
- [ ] 11 Clients configured
- [ ] 12 End-to-end verification passed
- [ ] 13 Backups + update routine in place
- [ ] 14 Authentik IdP + Cloudflare Access federation + groups
- [ ] 15 Workspaces: orchestrator, base images, isolation, scoped LiteLLM keys
- [ ] 16 Admin UI (OIDC-gated control plane)
