# Security Review — Findings

**98 findings** — Critical: 5  High: 29  Medium: 45  Low: 16  Info: 3

Critical items C-1 through C-5 addressed across two rounds of fixes.
Round 1 fixes applied after initial review. Round 2 gaps found by adversarial
re-check and closed in the same commit.

---

> ## ⚠️ Architecture change (2026-07-06): k8s-native rewrite
>
> The guide moved from a **Docker Compose core + late MicroK8s migration** to
> **MicroK8s from step 04**. The core stack (inference, litellm, open-webui,
> cloudflared, Traefik) now deploys as Kubernetes manifests under
> [`assets/k8s/`](assets/k8s/); `assets/docker-compose.yml` and `assets/.env.example`
> are retired. This **voids the premise** of several Docker-specific findings —
> they need re-adjudication in the pending per-finding Medium pass, not the fixes
> they originally proposed:
>
> - **Dissolved (mechanism no longer exists):** H-6 (Docker bridge egress),
>   M-23 (userns-remap), M-25 (compose service hardening), M-33 (flat `.env`),
>   M-44 (`CF_TUNNEL_TOKEN` as docker env), M-45 (`TABBY_API_KEY` on `ps`).
> - **Superseded by k8s equivalents applied in the rewrite:** default-deny +
>   per-service NetworkPolicies (step 04 §8) replace Docker network isolation;
>   k8s Secrets + `secretbox` encryption-at-rest (step 04 §2/§3) replace `.env`;
>   `securityContext` (cap-drop, no-priv-esc, non-root where feasible) on every
>   Deployment; digest pinning (step 04 §6) addresses the floating-tag findings
>   (H-8/H-9/M-30).
> - **Premise changed, still needs review:** M-24 (inference securityContext —
>   partially applied), M-42 (AppArmor → k8s seccomp), M-47 (LiteLLM logs →
>   k8s pod logs), M-57/H-20 (docker group still exists, Docker retained as an
>   image builder).
>
> Location references below that point to `docker-compose.yml` or
> `16-workspaces.md §4c/§4d` predate the rewrite; the equivalent resources now
> live in `assets/k8s/` and are applied in step 04 (core) / step 15 (Authentik).

---
## CRITICAL

### ~~C-1~~ — ✅ FIXED (R1 + R2) — Calico CNI Not Pre-Validated — All NetworkPolicies Silently Unenforced if Missing
**Location:** 16-workspaces.md §1, §5  
**Flagged by:** NET-2  
**Issue:** The entire network isolation model depends on Calico being the active CNI, but there is no enforcement gate — Kubernetes accepts NetworkPolicy resources regardless of whether any CNI enforces them, so a missing or crash-looping Calico results in all policies becoming no-ops with no visible error.  
**Impact:** If Calico is not correctly active, workspace pods have unrestricted access to the inference engine, LAN hosts, the management plane, and each other — a complete, silent network isolation failure.  
**R1 Fix:** Orchestrator pre-flight check; wait-for-Calico documented in §1.  
**R2 Gaps found:** (a) pre-flight only blocks new launches — running workspaces unprotected on post-launch Calico crash; (b) snap auto-update can restart calico-node during working hours with no alert; (c) direct kubectl/API calls bypass orchestrator pre-flight.  
**R2 Fix:** Calico watchdog CronJob (§5) suspends all ws-* Deployments on degradation; snap refresh window pinned to maintenance hours (§1). Bypass via direct kubectl noted as accepted residual; Kyverno admission gate documented as upgrade path.

### ~~C-2~~ — ✅ FIXED (R1 + R2) — LiteLLM Master Key and Admin Endpoints Exposed on Public api.domain.com
**Location:** 07-gateway-litellm.md §2–3; 10-connectivity-cloudflare.md §4  
**Flagged by:** AUTH-3, INGRESS-3  
**Issue:** The Cloudflare tunnel routes api.domain.com directly to litellm:4000 with no path filtering, making /key/generate, /key/delete, /key/info, and /health reachable from the public internet protected only by LITELLM_MASTER_KEY.  
**Impact:** Any actor who obtains or brute-forces the master key gains full LiteLLM admin access from the internet: minting unlimited keys, revoking all friend keys, and reading all spend data.  
**R1 Fix:** WAF blocklist for `^/(key|user|model/info|health)`; Tailscale-only admin note in step 07.  
**R2 Gaps found:** (a) blocklist missed /v1/key/*, /budget/*, /team/*, /config/*, /spend/*, /model/new, /model/delete; (b) case-sensitive regex allowed /KEY/generate bypass; (c) blocklist is architecturally weaker than allowlist for an evolving API.  
**R2 Fix:** Replaced blocklist with strict allowlist — only `/v1/(chat/completions|completions|models|responses|messages|embeddings)` are permitted; case-insensitive `(?i)` flag added; all other paths (including /v1/key/*) blocked by default.

### ~~C-3~~ — ✅ FIXED (R1 + R2) — Orchestrator ClusterRole Is Effectively Cluster-Admin via Cluster-Wide Secrets CRUD
**Location:** 16-workspaces.md §5 RBAC — assets/k8s/llm-platform/orchestrator-rbac.yaml  
**Flagged by:** AUTH-5, SECRETS-12, ORCHESTRATOR-1, HOST-10  
**Issue:** The orchestrator's ClusterRole grants create/get/list/watch/patch/delete on secrets with no namespace restriction, meaning the orchestrator service account can read and modify secrets in every namespace including llm-core and llm-platform.  
**Impact:** A compromised orchestrator process immediately yields every credential in the cluster, enabling full privilege escalation to all services.  
**R1 Fix:** Two-tier RBAC — ClusterRole covers only cluster-scoped resources; per-namespace Roles created in ws-* at provisioning time.  
**R2 Gaps found:** (a) ClusterRole lacked rbac.authorization.k8s.io permissions, making it impossible for the orchestrator to create the per-namespace RoleBindings it is documented to create — logical contradiction; (b) §10 still said "orchestrator is cluster-admin-equivalent."  
**R2 Fix:** Added `roles/rolebindings: create` to ClusterRole with a Kyverno policy (restrict-orchestrator-rbac) that confines RoleBindings to ws-* namespaces and the orchestrator-ws Role only; §10 updated to accurately describe the two-tier constraint.

### ~~C-4~~ — ✅ FIXED (R1 + R2) — Orchestrator ClusterRole Has Cluster-Wide NetworkPolicy Write — Can Erase All Isolation
**Location:** 16-workspaces.md §5 RBAC — assets/k8s/llm-platform/orchestrator-rbac.yaml  
**Flagged by:** NET-12, AUTH-6, ORCHESTRATOR-2  
**Issue:** The orchestrator ClusterRole grants create/patch/delete on networkpolicies cluster-wide, allowing a compromised orchestrator to delete the inference-ingress policy in llm-core and the workspace-isolation policies in all ws-* namespaces.  
**Impact:** A single compromised orchestrator process can erase every network boundary in the architecture, enabling workspace pods to reach the inference engine directly.  
**R1 Fix:** Moved NetworkPolicy write to per-namespace Roles in ws-* only; inference-ingress in llm-core out of orchestrator scope.  
**R2 Gaps found:** (a) per-namespace Role still included `networkpolicies: delete`, so a compromised orchestrator could delete workspace-isolation in every ws-* namespace it manages; (b) inference-ingress protection was documentation-only — no technical enforcement.  
**R2 Fix:** Removed `delete` from networkpolicies verbs in the per-namespace Role (patch remains for template updates); added Kyverno ClusterPolicy (protect-inference-ingress) that denies DELETE on the inference-ingress NetworkPolicy at the admission layer.

### ~~C-5~~ — ✅ FIXED (R1 + R2) — Cloudflare Tunnel Token Stored in Plaintext — Compromise Grants Full Ingress Hijack
**Location:** 04-deploy-stack-ubuntu.md §2; 10-connectivity-cloudflare.md §5  
**Flagged by:** INGRESS-1  
**Issue:** CF_TUNNEL_TOKEN is stored in a plaintext .env file; a leaked token lets an attacker register an additional cloudflared connector on the same tunnel and MITM all traffic.  
**Impact:** A stolen tunnel token enables interception of all friend traffic, capture of Access JWT cookies and LiteLLM keys, and persistent re-entry with no visible indicator.  
**R1 Fix:** Migrated CF_TUNNEL_TOKEN to k8s Secret in MicroK8s phase; connector notifications mentioned.  
**R2 Gaps found:** (a) .env cleanup step never instructed — token remained in /opt/home-llm/.env after k8s migration; (b) `docker inspect cloudflared` exposes the token to any docker-group member during the Docker Compose phase; (c) dqlite stores k8s Secrets base64 but unencrypted — host filesystem access yields the token; (d) connector notification was one advisory sentence with no actionable substeps or verification.  
**R2 Fix:** Added explicit `sed -i` .env cleanup step in step 10 §5 post-migration; added docker inspect exposure warning in step 04 §2; added dqlite encryption note referencing EncryptionConfiguration (cross-ref H-14); expanded connector notifications to numbered substeps with dashboard verification.

---
## HIGH

### H-1 — api.domain.com Has No Cloudflare Access Authentication — Edge Is Fully Bypassed — **ACCEPTED RESIDUAL**
**Location:** 10-connectivity-cloudflare.md §4; assets/cloudflare-access-notes.md §3  
**Flagged by:** AUTH-1, INGRESS-2  
**Issue:** The Cloudflare Access policy for api.domain.com is set to Bypass/Everyone, so any internet client reaches LiteLLM with zero edge-level identity check; the sole gate is the LiteLLM virtual key, and the per-IP WAF rate limit is trivially circumvented with distributed sources.  
**Impact:** Attackers can freely probe all LiteLLM endpoints, brute-force virtual keys, and exploit LiteLLM vulnerabilities without passing any identity verification at the edge.  
**Decision:** CF Access Service Tokens would close this but require every API client to send two extra headers in addition to the LiteLLM key — breaking the single-credential UX (`Authorization: Bearer <key>`) that all OpenAI-compatible clients expect. The risk is accepted. Mitigating controls: WAF path allowlist blocks all non-inference endpoints; LiteLLM virtual key required for every inference request; per-IP rate limit; admin endpoints Tailscale-only.

### ~~H-2~~ — ✅ FIXED — No Default-Deny NetworkPolicy in llm-core or llm-platform Namespaces
**Location:** 16-workspaces.md §4b — Default-deny baseline; §4c — llm-core policies; §4d — llm-platform policies  
**Flagged by:** NET-1  
**Issue:** Targeted NetworkPolicies exist for specific pods but no baseline deny-all policy is applied to llm-core or llm-platform, leaving all intra-namespace and cross-namespace traffic unrestricted by default for any pod not explicitly covered.  
**Impact:** A newly added or compromised pod in llm-core (sidecar, debug pod, future service) can freely reach workspace pods, management services, or the host network; inference egress is completely open, enabling data exfiltration from a compromised inference process.  
**Fix (implemented):** Added `default-deny` NetworkPolicy (ingress and egress, `podSelector: {}`) to both llm-core and llm-platform. Layered explicit allow policies on top covering every required traffic flow: `inference-policy`, `litellm-policy`, `open-webui-policy` in llm-core; `cloudflared-policy`, `traefik-policy`, `orchestrator-policy`, `admin-ui-policy`, `authentik-server-policy`, `authentik-worker-policy`, `authentik-postgres-policy`, `authentik-redis-policy` in llm-platform. Also fixes M-3 (inference egress now restricted to kube-dns only).

### ~~H-3~~ — ACCEPTED RESIDUAL — Race Condition: Workspace Pod May Start Before NetworkPolicy Is Applied
**Location:** 16-workspaces.md §5 — Workspace launch sequence  
**Flagged by:** NET-3  
**Issue:** If the workspace-isolation NetworkPolicy is absent or deleted from a namespace when a Deployment is created, the pod starts and has unrestricted network access during the window before Calico wires up the policy to the container's network interface.  
**Impact:** Code executing at container start (e.g. a supply-chain-compromised package) can establish outbound connections to inference, LAN hosts, or a remote C2 before isolation takes effect.  
**Residual accepted:** The orchestrator already applies `workspace-isolation` as the first operation at namespace provisioning time, before any Deployment is created (16-workspaces.md §5, step 1). The remaining sub-second window between the k8s API accepting the NetworkPolicy and Calico wiring it to the pod's network interface is an inherent CNI platform limitation not closable without Calico-specific APIs or a Kyverno admission webhook (both disproportionate complexity for this threat model). The practical exploitability of a <100ms window at container startup by a supply-chain payload specifically targeting that window is negligible. The Calico watchdog (§5) mitigates the broader case of Calico being absent or degraded.

### ~~H-4~~ — ✅ FIXED — No Ingress NetworkPolicy on the LiteLLM Pod — Any In-Cluster Pod Can Reach It
**Location:** 16-workspaces.md §4c — litellm-policy  
**Flagged by:** NET-6  
**Issue:** The inference-ingress policy restricts who can reach the inference pod, but there is no corresponding ingress policy on the litellm pod itself, so any pod with unrestricted egress (debug pod, monitoring agent, future service) can call LiteLLM on port 4000.  
**Impact:** A misconfigured or compromised pod anywhere in the cluster can call the LiteLLM API and, if the master key is known, gain full admin access to key management.  
**Fix (implemented):** Added `litellm-policy` in llm-core restricting ingress on port 4000 to: llm-platform pods (traefik, admin-ui, orchestrator), open-webui (llm-core), and namespaces labeled `workspace=true` (ws-* pods) only. LiteLLM egress restricted to inference:8080 and kube-dns:53. The `workspace=true` label is applied by the orchestrator at namespace creation, making workspace pods selectable by a stable namespaceSelector without Kyverno or wildcard patterns.

### ~~H-5~~ — ✅ FIXED — Gateway allowedRoutes: All Allows Any Namespace to Attach HTTPRoutes — Hostname Hijack Risk
**Location:** 16-workspaces.md §3 (gateway.yaml)  
**Flagged by:** NET-7, INGRESS-4  
**Issue:** The Traefik Gateway is configured with allowedRoutes.namespaces.from: All, so any namespace — including ws-* namespaces or any future namespace — can attach an HTTPRoute claiming llm.domain.com or api.domain.com, potentially redirecting legitimate traffic to a malicious service.  
**Impact:** A compromised orchestrator or any namespace with API write access could hijack production hostnames to harvest Cloudflare Access JWTs, LiteLLM keys, and all LLM interaction data.  
**Fix (implemented):** Replaced single main-gateway with two restricted gateways. `core-gateway` handles llm.domain.com and api.domain.com with allowedRoutes restricted to llm-platform and llm-core only. `workspace-gateway` handles *.ws.domain.com with allowedRoutes restricted to llm-platform only. The orchestrator creates workspace HTTPRoutes in llm-platform (not in ws-* namespaces), referencing workspace Services cross-namespace via a ReferenceGrant provisioned at launch. ws-* namespaces cannot attach routes to either gateway.

### ~~H-6~~ — ✅ FIXED — Docker Bridge Network llmnet Has No Inter-Container Egress Restrictions
**Location:** assets/docker-compose.yml — networks: llmnet; 04-deploy-stack-ubuntu.md  
**Flagged by:** NET-10  
**Issue:** All four Docker services (inference, litellm, open-webui, cloudflared) share a single bridge network with no iptables or network segmentation, so any container can reach any other on any port — including cloudflared and open-webui reaching inference on port 8080, bypassing LiteLLM entirely.  
**Impact:** A compromise of open-webui or cloudflared gives direct access to the inference endpoint, bypassing all LiteLLM authentication, per-user budgets, and rate limits.  
**Fix (implemented):** Replaced llmnet with two Docker networks. `frontend` (cloudflared + open-webui + litellm) handles all user-facing traffic. `backend` (litellm + inference only) is the inference path. cloudflared and open-webui have no route to inference. litellm bridges both networks as the sole authorised caller. Fixed alongside H-26.

### ~~H-8~~ — ✅ FIXED — All Third-Party Container Images Use Floating Mutable Tags — Supply Chain Risk
**Location:** assets/docker-compose.yml lines 35, 52, 72; assets/inference/Dockerfile line 8; assets/workspace-base/Dockerfile line 6  
**Flagged by:** CONTAINER-2, OPS-1  
**Fix (implemented):** Added digest-pinning procedure to step 04 §4. Operators pull images immediately after staging, record SHA-256 digests via `docker inspect --format='{{index .RepoDigests 0}}'`, and write `image: <name>:<tag>@sha256:<digest>` into docker-compose.yml before first deploy. Same procedure covers the TabbyAPI base image (inference/Dockerfile FROM line) and the code-server base image (workspace-base/Dockerfile). Step 14 container update procedure (H-27) extends this to deliberate re-pinning on every update. Also resolves M-30 (same issue, duplicate finding).

### ~~H-9~~ — ✅ FIXED — Inference Image and llama-swap Binary Not Pinned or Integrity-Verified
**Location:** assets/inference/Dockerfile lines 8 and 11–13  
**Flagged by:** CONTAINER-3, CONTAINER-4, OPS-2  
**Fix (implemented):** Replaced `ADD <url>` + `RUN chmod` with a `RUN wget | sha256sum -c | chmod` chain that downloads the binary and verifies it against `ARG LLAMA_SWAP_SHA256` in a single layer — build fails with a clear message if the arg is empty or the hash mismatches. Step 04 §4 shows how to compute the hash (`curl | sha256sum`) and set the ARG default in the Dockerfile before building. Base image pinned via the H-8 procedure (FROM line updated with digest at first deploy).

### ~~H-7~~ — ✅ FIXED — Workspace emptyDir /tmp Has No Size Limit — Node-Wide DoS via Disk Exhaustion
**Location:** 16-workspaces.md §6 — Workspace pod spec (volumes.tmp emptyDir: {})  
**Flagged by:** CONTAINER-1  
**Issue:** Workspace /tmp mounted as an unbounded emptyDir — a single user could fill the node disk and trigger cluster-wide eviction.  
**Fix (implemented):** `emptyDir: {sizeLimit: "500Mi"}` set on the /tmp volume (§6 pod spec). LimitRange (§7) now includes `default.ephemeral-storage: 500Mi` and `defaultRequest.ephemeral-storage: 100Mi`. ResourceQuota (§7) includes `requests.ephemeral-storage: 1Gi` as a namespace-level cap. Kubelet enforces the emptyDir sizeLimit via periodic du checks and evicts the pod if /tmp exceeds the limit, containing the blast radius to a single workspace.

### H-8 — All Third-Party Container Images Use Floating Mutable Tags — Supply Chain Risk
**Location:** assets/docker-compose.yml lines 35, 52, 72; assets/workspace-base/Dockerfile line 3 (codercom/code-server:latest, ghcr.io/berriai/litellm:main-stable, ghcr.io/open-webui/open-webui:main, cloudflare/cloudflared:latest)  
**Flagged by:** CONTAINER-2, OPS-1  
**Issue:** Every third-party image in the stack — LiteLLM, Open WebUI, cloudflared, and the workspace base — is pinned to a mutable tag that resolves to a different digest on every pull, with no indication of what changed.  
**Impact:** A supply chain attacker who compromises any upstream registry account gets automatic deployment on the next maintenance cycle with full access to user sessions, chat history, and LiteLLM credentials.  
**Fix:** Pin all images to immutable SHA-256 digests and use Renovate or docker-pin to propose deliberate digest-bumped updates after validation.

### H-9 — Inference Image and llama-swap Binary Not Pinned or Integrity-Verified
**Location:** assets/inference/Dockerfile lines 8 and 11–13 (FROM ghcr.io/theroyallab/tabbyapi:latest; ADD https://github.com/.../llama-swap_linux_amd64)  
**Flagged by:** CONTAINER-3, CONTAINER-4, OPS-2  
**Issue:** The inference Dockerfile uses a floating :latest tag for the TabbyAPI base image and fetches the llama-swap binary via ADD with no checksum step; docker compose build --pull silently accepts any updated content.  
**Impact:** A compromised upstream image or a MITM during a release-tag re-point substitutes the inference entrypoint, which runs with direct NVIDIA GPU access and read-write access to all model weights at /srv/models.  
**Fix:** Pin the base image to a SHA-256 digest and add a RUN step that verifies the llama-swap binary SHA-256 against the published release checksum before chmod +x.

### ~~H-10~~ — ✅ FIXED — .env File Created Without Restrictive Permissions — All Secrets World-Readable
**Location:** 04-deploy-stack-ubuntu.md §2; assets/.env.example  
**Flagged by:** SECRETS-1  
**Issue:** The guide creates /opt/home-llm/.env containing all service credentials but never sets file permissions, leaving it at the system umask default (typically 644 — world-readable).  
**Impact:** Any local user or process with filesystem read access can extract CF_TUNNEL_TOKEN, LITELLM_MASTER_KEY, TABBY_API_KEY, and all other secrets from the .env file.  
**Fix (implemented):** `chmod 600 .env` and `chmod 750 /opt/home-llm` added immediately after `cp .env.example .env` in step 04 §2. All subsequent `.env` touch points verified safe: step 07 updated to use `nano` (not shell redirection) when writing `OPENWEBUI_LITELLM_KEY`; step 10 `sed -i` preserves mode 600 (GNU sed on Ubuntu calls `fchmod()` before rename); `/tmp/cf-token` pre-created at mode 600 with `install -m 600` before the `>` redirect.

### ~~H-11~~ — ✅ FIXED — No .gitignore for .env — Risk of Accidental Secret Commit
**Location:** 04-deploy-stack-ubuntu.md §2; assets/.env.example  
**Flagged by:** SECRETS-3  
**Issue:** The guide warns against committing .env but never instructs users to add it to a .gitignore in /opt/home-llm, so initialising a git repo for config management will include the .env by default.  
**Impact:** If the directory is pushed to any remote, all secrets are permanently embedded in git history and cannot be removed without history rewriting.  
**Fix (implemented):** `echo ".env" >> /opt/home-llm/.gitignore` added to step 04 §2 immediately after the `chmod` steps, in the same block that creates the file.

### ~~H-12~~ — ✅ FIXED — LITELLM_MASTER_KEY and LITELLM_SALT_KEY Exposed via docker inspect
**Location:** assets/docker-compose.yml (litellm service environment: section)  
**Flagged by:** SECRETS-7  
**Issue:** Both keys were passed as Docker environment variables, making them readable via `docker inspect litellm`.  
**Fix (implemented):** Keys removed from `environment:` and moved to Docker secrets (`secrets:` stanza in compose, files at `/etc/home-llm/litellm_{master,salt}_key`, mode 400 root-owned). Docker secrets are mounted at `/run/secrets/` and do not appear in `docker inspect` output. An entrypoint wrapper (`/bin/sh -c`) reads the files and exports them as env vars before starting LiteLLM. Step 04 §2 adds the secret file creation step. `.env.example` updated to remove these keys and explain the split.

### ~~H-13~~ — ✅ FIXED — LITELLM_SALT_KEY Rotation Is Destructive and Undocumented
**Location:** 14-operations.md §Key & access hygiene; assets/.env.example  
**Flagged by:** SECRETS-10  
**Issue:** LITELLM_SALT_KEY rotation silently invalidates every existing virtual key with no documented recovery procedure.  
**Fix (implemented):** Warning comment added to `.env.example` immediately above `LITELLM_SALT_KEY`. Step 14 Key & access hygiene now has a dedicated bullet explaining that the salt key must be treated as permanent, distinguishing it from `LITELLM_MASTER_KEY` (safe to rotate), and documenting the four-step coordinated rotation procedure (notify → list keys → update + restart → re-mint) for the case where rotation becomes unavoidable.

### ~~H-14~~ — ✅ FIXED — Kubernetes Secrets Not Encrypted at Rest in etcd (MicroK8s Default)
**Location:** 16-workspaces.md §1 (MicroK8s setup)  
**Flagged by:** SECRETS-11  
**Issue:** MicroK8s does not enable encryption at rest by default — Secrets are base64-encoded plaintext in the dqlite data directory, readable by any process with host filesystem access.  
**Fix (implemented):** `secretbox` (XSalsa20 + Poly1305 AEAD) `EncryptionConfiguration` added to 16-workspaces.md §1. Steps: generate 32-byte key via `openssl rand -base64 32`; write config to `/var/snap/microk8s/current/args/encryption-config.yaml` (mode 400, root-owned); append `--encryption-provider-config=...` to `/var/snap/microk8s/current/args/kube-apiserver`; `sudo snap restart microk8s`; re-encrypt all existing Secrets with `kubectl get secrets --all-namespaces -o json | kubectl replace -f -`. The `identity: {}` fallback provider is listed last to allow the one-time re-encryption pass to read pre-existing plaintext Secrets. Key rotation procedure documented (add key2 above key1 → restart → re-encrypt → remove key1 → restart).

### ~~H-15~~ — ✅ FIXED — Authentik Admin Credentials and Secret Key Have No Documented Setup or Hardening
**Location:** 15-identity-sso.md §Setup outline; §Authentik hardening  
**Flagged by:** SECRETS-15  
**Issue:** Step 15 deployed Authentik with no guidance on secret generation, postgres password, akadmin deactivation, or admin UI access restriction.  
**Fix (implemented):** New "§Secrets" sub-section added to Authentik hardening: `openssl rand -hex 32` for both `AUTHENTIK_SECRET_KEY` and the postgres password, with a prominent permanence warning for the secret key (same pattern as `LITELLM_SALT_KEY`). New "§Admin UI access" sub-section documents `kubectl port-forward` over Tailscale as the sole access path for the admin UI (WAF already blocks `/if/admin/` on the public tunnel), with a Docker Compose SSH port-forward fallback for the pre-MicroK8s phase. akadmin deactivation, MFA enforcement, and brute-force lockout were already documented in prior hardening sections. Setup outline step 1 no longer references the security review document.

### ~~H-16~~ — ✅ FIXED — SSH Not Hardened and Root SSH Access Normalized in Tailscale ACL
**Location:** 09-connectivity-tailscale.md §4; 02-host-os-ubuntu.md; assets/tailscale-acl.json lines 22–27  
**Flagged by:** HOST-1, HOST-4  
**Issue:** The guide presents SSH hardening (key-only auth, PermitRootLogin no, ListenAddress binding) as advisory rather than mandatory, and the Tailscale ACL explicitly lists root as a permitted SSH user, normalizing direct root access.  
**Impact:** SSH remaining on 0.0.0.0 exposes it to LAN brute-force, and permitting root login means a successful credential attack yields immediate full host compromise with no privilege escalation step needed.  
**Fix (implemented):** Added mandatory SSH hardening section (step 02 §3): PermitRootLogin no, PasswordAuthentication no, phased key-onboarding workflow documented, per-user Match block template included as a comment. ListenAddress binding (LAN + Tailscale IPs) made mandatory in step 09 §4 with `ss -tlnp` verification gate. Root removed from Tailscale SSH ACL `users` list in assets/tailscale-acl.json — only `autogroup:nonroot` permitted. Also resolves M-17 and M-19.

### ~~H-17~~ — ✅ FIXED — No Host Firewall (UFW) Configured — All Host Ports Unrestricted on LAN
**Location:** 02-host-os-ubuntu.md §4; 09-connectivity-tailscale.md §1, §5  
**Flagged by:** HOST-2  
**Issue:** UFW ships inactive on Ubuntu Server 24.04 and the guide never enables it, leaving all host ports and any accidentally LAN-bound services reachable from the local network with no OS-level defence.  
**Impact:** Any service that binds to a non-loopback address — including MicroK8s NodePorts, Docker published ports, or misconfigured future containers — is immediately accessible from the LAN without authentication. Secondary risk: IPv6 bypasses NAT entirely; a globally routable IPv6 prefix (common on modern ISPs) would make open host ports directly internet-facing.  
**Fix (implemented):** Added mandatory UFW section (step 02 §4): `default deny incoming / default allow outgoing`, SSH allowed from operator-specified `<LAN_CIDR>`, monitoring placeholder for Prometheus scrape rules (Grafana host IP TBD — step 14). `ufw allow in on tailscale0` added to step 09 §1 post-`tailscale up`. Docker bypass mitigated via `"ip": "127.0.0.1"` merged into daemon.json in step 02 §7 (after nvidia-ctk writes the nvidia runtime entry) — loopback is now the default bind address for any future `ports:` entry that omits an explicit host IP; existing compose services already use `127.0.0.1:` bindings and `expose:` only. UFW manages ip6tables alongside iptables, so IPv6 internet exposure is also covered.

### ~~H-18~~ — ✅ FIXED — No Automatic Security Patching Configured on a 24/7 Internet-Facing Server
**Location:** 02-host-os-ubuntu.md §2; 14-operations.md  
**Flagged by:** HOST-3  
**Issue:** The guide performs a one-time apt upgrade at setup and mentions manual upgrades in operations, but never installs or configures unattended-upgrades for a server that runs continuously with a public-facing Cloudflare tunnel.  
**Impact:** Known CVEs in OpenSSH, the Linux kernel, or glibc accumulate between manual upgrade runs, leaving the host exploitable during the disclosure-to-patch window.  
**Fix (implemented):** Added `timedatectl set-timezone` as the first step in step 02 §2 — the reboot window uses the system clock. `unattended-upgrades` configured for Ubuntu `-security` origins only; `nvidia-*` and `libnvidia-*` blacklisted (driver updates require manual testing). Automatic reboot at 03:00 system time with `Automatic-Reboot-WithUsers "false"`. `14-operations.md` Updates section updated to reflect the automatic/manual/NVIDIA split. **H-29 dependency:** full post-reboot health visibility requires (a) Promtail systemd unit `TimeoutStopSec=30` to flush its buffer before shutdown completes, and (b) a Grafana heartbeat alert firing if the LLM server stops sending logs for >5–10 minutes — both to be implemented in step 14.

### ~~H-19~~ — ✅ ADDRESSED (via H-17) — MicroK8s API Server Binds to All Interfaces by Default — LAN-Exposed
**Location:** 16-workspaces.md §1; 02-host-os-ubuntu.md §4; 09-connectivity-tailscale.md §1  
**Flagged by:** HOST-7  
**Issue:** MicroK8s binds the kube-apiserver to 0.0.0.0:16443 by default, and no step restricts it to the Tailscale interface; combined with the absent host firewall (H-17), the k8s API server is reachable from the LAN.  
**Impact:** LAN-accessible kube-apiserver enables credential enumeration and, if any service account token leaks via a workspace pod breakout, it can be replayed from any LAN host to gain cluster-level access.  
**Fix (addressed via H-17):** UFW `default deny incoming` (step 02 §4) blocks all inbound LAN access to port 16443; `ufw allow in on tailscale0` (step 09 §1) permits Tailscale-based remote kubectl. The apiserver bind-address is intentionally left at `0.0.0.0` — `--bind-address` takes a single IP, so binding to the Tailscale IP would break local `microk8s kubectl` which uses `127.0.0.1:16443` over loopback. Accepted residual: the apiserver process listens on all interfaces; UFW is the enforcement layer. Recovery path if Tailscale is unavailable: LAN SSH (port 22 open from LAN CIDR) → `microk8s kubectl` locally over loopback is always accessible from the host. Remote kubeconfig (Tailscale IP substitution) and verification steps added to step 16 §1.

### ~~H-20~~ — ✅ FIXED — Docker Group Membership Is Effective Root — Unprivileged Escalation Path
**Location:** 02-host-os-ubuntu.md §6; 04-deploy-stack-ubuntu.md §1, §6  
**Flagged by:** HOST-12  
**Issue:** Step 02 adds the primary user to the docker group, which is equivalent to passwordless root because docker run -v /:/host mounts the entire host filesystem without any further privilege check.  
**Impact:** Any code execution as the server user — via SSH, a kubeconfig leak, or a compromised container exec — can trivially escalate to root, and the systemd service unit running as that user has the same implicit capability.  
**Fix (implemented):** Created `llm-svc` system account (no login shell) in step 02 §6; `llm-svc` is the only docker group member and owns `/opt/home-llm`. The interactive admin account is never added to the docker group — all ad-hoc docker commands use `sudo docker`. Systemd unit updated to `User=llm-svc`. Also closes M-57 (same risk, documentation-level variant).

### ~~H-21~~ — ✅ FIXED (via H-24) — Namespace Naming Collision: Crafted Username Can Target Existing Namespaces
**Location:** 16-workspaces.md §5 — Orchestrator namespace creation logic  
**Flagged by:** ORCHESTRATOR-3  
**Issue:** The orchestrator created namespaces as `ws-<preferred_username>` with no validation; an Authentik account named `llm-core` would cause the orchestrator to target `ws-llm-core`, potentially colliding with infrastructure namespaces and inheriting their NetworkPolicy posture.  
**Fix (via H-24):** All Kubernetes resource names are now derived from the immutable OIDC `sub` UUID (`ws-<uuid>`, `home-<uuid>`). A UUID cannot collide with any human-readable namespace name. Username validation and prefix blocklists are no longer necessary as a primary control; the sub UUID provides the isolation by construction.

### ~~H-22~~ — ✅ FIXED — Workspace Activity API Controlled by the Workspace Pod — Idle TTL Spoofable
**Location:** 16-workspaces.md §5 — Idle TTL polling  
**Flagged by:** ORCHESTRATOR-4  
**Issue:** Orchestrator polled the pod's own HTTP activity endpoint for idle detection — trivially spoofable. No hard maximum lifetime existed.  
**Fix (implemented):** Step 3 updated with two independent stop conditions: (1) metrics-server CPU as the idle signal — near-zero CPU cannot be spoofed from inside the pod regardless of what HTTP responses it serves; (2) a hard maximum workspace lifetime (default 24 h from `launched_at`, stored in the workspaces table) that triggers a stop independently of CPU activity. `launched_at` column added to the workspaces DB schema and set on every launch.

### ~~H-23~~ — ✅ FIXED — LiteLLM Key Revocation on Workspace Destroy Is Not Atomic — Orphaned Keys Persist
**Location:** 16-workspaces.md §5 — Destroy flow  
**Flagged by:** ORCHESTRATOR-5  
**Issue:** Destroy sequence deleted the k8s Secret before revoking the LiteLLM key; a crash mid-sequence left the key value irrecoverably lost but still valid in LiteLLM's database.  
**Fix (implemented):** Two-part fix: (1) `litellm_key_alias` column added to the workspaces DB schema — written at key mint time, before the k8s Secret is created, so the alias is always available for retry regardless of Secret state. (2) Destroy and deprovision sequences now read the alias from the DB (not the Secret), call `/key/delete`, verify 404 before touching any k8s resource, clear the DB alias after confirmed revocation, and halt with an error if revocation fails rather than proceeding to Secret deletion with an unrevoked key. Orchestrator startup recovery procedure added: scan for rows where `litellm_key_alias IS NOT NULL` with no active Deployment and retry revocation for each.

### ~~H-24~~ — ✅ FIXED — Workspace Resources Keyed on Mutable preferred_username — Identity Confusion on Rename
**Location:** 16-workspaces.md §5 and §6 — PVC persistence; 15-identity-sso.md — OIDC login flow  
**Flagged by:** ORCHESTRATOR-6, ORCHESTRATOR-7  
**Issue:** The orchestrator derives namespace names, PVC names, and all workspace resources from the OIDC preferred_username claim, which is admin-editable in Authentik; renaming a user or recycling a username routes the new account to the previous user's namespace and home PVC.  
**Impact:** A username recycle grants the new user access to the previous user's persistent data, shell history, cached credentials, and any secrets written to the home directory; a compromised Authentik admin can re-route any user's workspace.  
**Fix (implemented):** Orchestrator uses the immutable OIDC `sub` UUID as the primary key for all Kubernetes resource names (`ws-<sub>` namespace, `home-<sub>` PVC, `litellm-key` Secret). `preferred_username` is cached as `display_name` only — never used to name or locate resources.  
Workspace hostname (`<slug>.ws.domain.com`) is a stable alias set once at first provisioning in a `hostname_registry` table (`slug → sub`, status: `active | reserved | released`). Collision check runs at provisioning time only; slug does not auto-update on Authentik rename, so URLs are stable across username changes. Slug is marked `reserved` across workspace destroy/relaunch cycles and `released` only on full deprovision — preventing recycling until explicitly freed. Also eliminates H-21 (namespace collision via crafted username) as a side effect.

### H-25 — ⚠️ ACCEPTED RESIDUAL — Orchestrator ClusterRole Grants Namespace Delete Cluster-Wide — Can Destroy llm-core or kube-system
**Location:** 16-workspaces.md §5 RBAC — assets/k8s/llm-platform/orchestrator-rbac.yaml  
**Flagged by:** ORCHESTRATOR-14  
**Issue:** The orchestrator ClusterRole grants `namespaces: delete` cluster-wide. A compromised orchestrator could delete `llm-core`, `llm-platform`, or `kube-system`.  
**Residual accepted because:** RBAC has no namespace-name pattern syntax, so the `ws-*` scope cannot be enforced at the RBAC layer without a ValidatingAdmissionWebhook. A webhook (Kyverno, OPA/Gatekeeper) adds a new runtime dependency not present elsewhere in the stack — assessed as disproportionate for this home server threat model, consistent with the H-3 decision. The exploit path requires the orchestrator to be compromised (admin-only, Tailscale + `grp-admin` gated), then specifically targeting namespace deletion rather than the many higher-value actions available to a compromised orchestrator.  
**Mitigations in place:** Two-tier RBAC structurally prevents the orchestrator from reading Secrets or writing NetworkPolicies outside `ws-*`. Tailscale + `grp-admin` restricts who can reach the orchestrator API. Design intent — `namespaces: delete` is called only on `ws-*` namespaces at deprovision — is documented in §10 security caveats.  
**Upgrade path:** Install Kyverno and add a `ClusterPolicy` denying DELETE on the orchestrator SA for any namespace not matching `ws-*` if the threat model expands (e.g., less-trusted operators, or multi-operator deployment).

### ~~H-26~~ — ✅ FIXED — cloudflared Is Single Point of Failure with Broad Internal Network Access
**Location:** README.md (service map); assets/docker-compose.yml (cloudflared service); 16-workspaces.md §9  
**Flagged by:** INGRESS-5  
**Issue:** The single cloudflared process fronts all three public hostnames and in the Docker deployment shares llmnet with inference, litellm, open-webui, and authentik, so a container escape gives direct unauthenticated access to every internal service.  
**Impact:** Compromising cloudflared yields full read/write access to all internal services: Open WebUI accounts and chat history, LiteLLM key management, Authentik admin, workspace pods, and the tunnel token for persistent external re-entry.  
**Fix (implemented):** Docker network split (H-6) removes inference from cloudflared's reachable network. cloudflared container hardened: runs as UID/GID 65534 (nobody), read-only filesystem, tmpfs on /tmp, no-new-privileges, all capabilities dropped. In MicroK8s phase, egress NetworkPolicy on the cloudflared pod limits it to traefik:80 only.

### ~~H-27~~ — ✅ FIXED — Update Process Performs No Digest Verification Before Deployment
**Location:** 14-operations.md — Updates section  
**Flagged by:** OPS-3  
**Issue:** Step 14 instructed `docker compose pull && docker compose up -d` with no guidance to verify image digests, compare against a known-good baseline, or perform any staging before deploying.  
**Fix (implemented):** Replaced the bare pull-and-up block in step 14 Updates with a five-step procedure: (1) record current digests with `docker inspect` to a temp file, (2) pull, (3) `diff` before vs after to see exactly what changed, (4) update pinned digests in docker-compose.yml after reviewing changelogs for changed images, (5) deploy and smoke-test with rollback instructions (restore previous digest in docker-compose.yml + `up -d` — old layers remain in Docker's local cache until pruned).

### ~~H-28~~ — ✅ FIXED — Backup Archives Written Unencrypted with No Access Controls or Retention Policy
**Location:** 14-operations.md — Backups section  
**Flagged by:** OPS-4  
**Issue:** Backup commands wrote plaintext `.tgz` archives to `/srv/backups` with no directory permissions, no encryption, no retention limit.  
**Fix (implemented):** Backups section fully rewritten. First-time setup creates `/srv/backups` owned root:root at mode 700 and generates a 256-bit backup passphrase at `/root/.backup-passphrase` (mode 600). Backup commands now pipe `docker run ... tar cz` through `gpg --symmetric --cipher-algo AES256 --passphrase-file` — archives are encrypted before touching disk. Retention: `find /srv/backups -name '*.tgz.gpg' -mtime +30 -delete`. Restore procedure documented. `.env` backup explicitly called out as a separate concern (password manager only, never co-located with archives) — closing M-43 and M-60 as side effects.

### ~~H-29~~ — ✅ FIXED — Monitoring Is Manual Log Inspection Only — No Alerting or Anomaly Detection
**Location:** 14-operations.md — Monitoring section  
**Flagged by:** OPS-5  
**Issue:** The entire monitoring strategy was four manual docker logs commands and nvidia-smi, with no log aggregation, no persistent storage, and no automated alerting for credential abuse, container anomalies, or authentication failures.  
**Fix (implemented):** Full off-server monitoring stack in 14-operations.md §Monitoring. The Grafana host is a separate machine on the same LAN (`<grafana-host-lan-ip>`):
1. **External monitoring host** — Grafana + Loki + Prometheus Docker Compose stack. Loki retains logs ≥ 90 days. Grafana admin password stored as a Docker secret (`/etc/monitoring/grafana_admin_password`).
2. **Promtail on the LLM server** — dedicated Compose project (`/opt/promtail`) separate from the main stack, ships Docker container logs (phase 1) and MicroK8s pod logs (phase 2) to Loki via LAN push to `<grafana-host-lan-ip>:3100`.
3. **Trivy Operator in MicroK8s** — installed via Helm in `trivy-system` namespace, continuously scans all cluster images and produces `VulnerabilityReport` CRDs. Metrics exposed as NodePort 32000 (`<llm-server-lan-ip>:32000`), scraped by external Prometheus. UFW rule restricts access to monitoring host only.
4. **Host OS CronJob** — `trivy fs /host` nightly at 02:00 in `trivy-system` namespace. `hostPath: /` mounted read-only. `automountServiceAccountToken: false` — no cluster API access. Output → stdout → Promtail → Loki. (`hostPID: true` is not needed for `trivy fs`.)
5. **Grafana alert rules** — LiteLLM 401 spike, Authentik failed-auth spike, Trivy CRITICAL CVE, Trivy HIGH CVE new, host OS CVE found, Promtail canary (pipeline health).

---
## MEDIUM

### ~~M-1~~ — ✅ FIXED — DNS Egress Rule Allows Port 53 to All Namespaces, Not Just kube-dns
**Location:** 16-workspaces.md §4a — workspace-isolation NetworkPolicy, kube-dns egress rule  
**Flagged by:** NET-4, CONTAINER-12, ORCHESTRATOR-11  
**Issue:** The DNS egress rule uses `namespaceSelector: {}` (matches all namespaces) with no podSelector, allowing workspace pods to reach any pod in any namespace on port 53 UDP/TCP, not only the kube-dns pods in kube-system.  
**Impact:** Workspace pods can use port 53 TCP for DNS tunneling to any pod listening on that port in any namespace, enabling covert data exfiltration or lateral movement via a rogue DNS listener in another ws-* namespace.  
**Fix (implemented):** All kube-dns egress rules throughout the policy set — workspace-isolation (§4a), inference-policy, litellm-policy, open-webui-policy (§4c), and all llm-platform policies (§4d) — now use `namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}` combined with `podSelector: {matchLabels: {k8s-app: kube-dns}}`. Port 53 is no longer reachable to arbitrary pods in arbitrary namespaces.

### M-2 — Workspace Egress ipBlock Exception List Misses Link-Local and RFC 6598 Ranges
**Location:** 16-workspaces.md §4a — workspace-isolation NetworkPolicy, egress ipBlock except list  
**Flagged by:** NET-5, NET-9, NET-16, AUTH-16  
**Issue:** The egress exception list covers 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and 100.64.0.0/10, but omits 169.254.0.0/16 (link-local / cloud IMDS), 127.0.0.0/8 (loopback), and 100.0.0.0/10 (lower RFC 6598 CGNAT range); cross-workspace isolation also relies on MicroK8s pod CIDRs falling within the RFC1918 blocks, which is unverified.  
**Impact:** Workspace pods can reach link-local addresses (critical if the host is ever migrated to a cloud VM where 169.254.169.254 is the IMDS credential endpoint), ISP CGNAT infrastructure in 100.0.0.0/10, and potentially each other if the MicroK8s pod CIDR falls outside the excepted ranges.  
**Fix:** Add 169.254.0.0/16, 127.0.0.0/8, and 100.0.0.0/10 to the except list, verify the MicroK8s pod and service CIDRs with `microk8s kubectl cluster-info dump | grep -E 'podCIDR|serviceClusterIP'`, and add those ranges explicitly regardless of RFC1918 overlap.

### ~~M-3~~ — ✅ FIXED — Inference Pod Has No Egress NetworkPolicy — Full Outbound Access from GPU Process
**Location:** 16-workspaces.md §4c — inference-policy  
**Flagged by:** NET-8  
**Issue:** Only an ingress NetworkPolicy is defined for the inference pod; no egress policy exists, giving the inference process (TabbyAPI / llama-swap) unrestricted outbound access to the LAN, internet, and all other pods.  
**Impact:** A compromised inference process — via malicious model weights, a TabbyAPI/ExLlamaV2 vulnerability, or a supply-chain attack — can exfiltrate user prompts, API keys visible in the environment, or establish a reverse shell to an external C2.  
**Fix (implemented):** `inference-ingress` replaced with `inference-policy` (policyTypes: [Ingress, Egress]). Egress restricted to kube-dns:53 only — the inference process has no legitimate outbound connections beyond DNS resolution. Fixed as part of the H-2 default-deny + explicit-allow overhaul.

### M-4 — api.domain.com Has Cloudflare Access Bypass with Only IP-Based Rate Limiting
**Location:** 10-connectivity-cloudflare.md §4; assets/cloudflare-access-notes.md §3–4  
**Flagged by:** NET-11, AUTH-2, SECRETS-20, HOST-18, INGRESS-8, INGRESS-14  
**Issue:** The api.domain.com Cloudflare Access policy is set to Bypass / Everyone, meaning no edge identity check is performed; the only protections are LiteLLM virtual-key authentication and a per-IP WAF rate limit of 60 req/min that is trivially bypassed with multiple IPs.  
**Impact:** The entire security of the public API rests on LiteLLM key secrecy; a leaked key is immediately usable from anywhere in the world, there is no edge revocation, and LiteLLM pre-auth vulnerabilities are directly exploitable from the public internet.  
**Fix:** Issue Cloudflare Service Tokens for API clients that support custom headers and switch to an Allow policy; for clients requiring Bypass, restrict LiteLLM admin endpoints to Tailscale-only, tighten the WAF to reject requests lacking a valid Authorization header format, and add per-key token-per-minute limits in LiteLLM.

### M-5 — Orchestrator Pod Has No Egress NetworkPolicy — High-Privilege Process with Unrestricted Outbound
**Location:** 16-workspaces.md §5 — Orchestrator; no NetworkPolicy defined for orchestrator  
**Flagged by:** NET-13  
**Issue:** No NetworkPolicy restricts the orchestrator's own egress, giving a process that holds the LiteLLM master key, OIDC client secrets, and a cluster-admin-equivalent ServiceAccount token unrestricted access to the LAN, internet, and all in-cluster services.  
**Impact:** Compromise of the orchestrator allows exfiltration of every high-value credential in the stack to an external destination with no network-layer control to detect or block it.  
**Fix:** Apply an egress NetworkPolicy to the orchestrator pod restricting outbound to only Authentik (port 9000), the k8s API server (port 6443), LiteLLM (port 4000), and kube-dns (port 53), blocking all other destinations including external internet.

### M-6 — Traefik Ingress Policy Uses Pod Label Only — Spoofable by Any Pod Created in llm-platform
**Location:** 16-workspaces.md §4a — workspace-isolation NetworkPolicy, ingress rule  
**Flagged by:** NET-14  
**Issue:** The workspace ingress NetworkPolicy allows traffic from any pod labeled `app.kubernetes.io/name: traefik` in llm-platform, but pod labels are attacker-controlled; anyone with pod-create rights in llm-platform can forge this label.  
**Impact:** An attacker who compromises the orchestrator (which can create pods cluster-wide) can deploy a pod impersonating Traefik and reach any workspace pod on any port, bypassing the single-ingress-point design.  
**Fix:** Restrict pod creation in llm-platform to only the orchestrator service account via RBAC, audit all pod creation events in llm-platform with alerting, and remove `pods: create` from any other ClusterRole or Role in that namespace.

### M-7 — MicroK8s Pod Network Can Reach Docker Bridge — Kubernetes NetworkPolicies Do Not Protect Docker Services
**Location:** 04-deploy-stack-ubuntu.md; 16-workspaces.md §1  
**Flagged by:** NET-15  
**Issue:** The Docker Compose stack (inference, litellm, open-webui, cloudflared) and MicroK8s share the same host network stack with no documented iptables rules preventing MicroK8s pods from routing directly to the Docker bridge CIDR.  
**Impact:** A workspace pod can bypass all Kubernetes NetworkPolicies and reach Docker containers directly via host routing, circumventing the inference-ingress NetworkPolicy and the LiteLLM authentication layer.  
**Fix:** Add host-level iptables rules dropping traffic from the MicroK8s pod CIDR to the Docker bridge CIDR, and ensure inference and litellm ports have no host-level binding; ideally migrate all services into MicroK8s under a single NetworkPolicy framework.

### M-8 — Authentik Has No NetworkPolicy and No Documented Access Restriction for Its Admin UI
**Location:** 15-identity-sso.md §Setup outline step 1; 16-workspaces.md §Architecture  
**Flagged by:** NET-20, INGRESS-13, AUTH-12  
**Issue:** No NetworkPolicy restricts which pods can reach Authentik within llm-platform, and there is no documented Cloudflare Access application or Kubernetes network control preventing accidental public exposure of the Authentik admin UI (port 9000).  
**Impact:** Authentik compromise gives full control over all OIDC-federated identities and the ability to forge tokens for every protected resource; since it is the master trust anchor, no concrete network-layer enforcement exists to protect it from a compromised Traefik or orchestrator pod.  
**Fix:** Apply a NetworkPolicy to the Authentik pod permitting ingress only from the orchestrator and cloudflared pods, restrict its admin UI to kubectl port-forward over Tailscale only (never route it through the tunnel), and add a Tailscale ACL entry limiting port 9000 to autogroup:admin.

### M-9 — Open WebUI Uses a Single Shared LiteLLM Key with No Per-User Budget or Rate Limit
**Location:** 07-gateway-litellm.md §2; 08-webui-open-webui.md  
**Flagged by:** AUTH-4, AUTH-20  
**Issue:** All Open WebUI users share one LiteLLM virtual key (OPENWEBUI_LITELLM_KEY) which is minted with no max_budget or rpm_limit, making it impossible to attribute usage to individual users or prevent one user from exhausting the shared budget.  
**Impact:** A single runaway or malicious UI session can monopolize the GPU indefinitely and lock out all other UI users, and per-user spend tracking and key revocation are impossible without separate keys.  
**Fix:** Either mint one LiteLLM virtual key per Open WebUI user and store it in that user's profile, or pass a per-user identifier header (X-LiteLLM-User-ID) with each request; at minimum set a conservative max_budget and rpm_limit on the shared key proportional to the expected concurrent user count.

### M-10 — Workspace PVC Keyed on Mutable Username — Username Recycling Exposes Prior User's Data
**Location:** 16-workspaces.md §5, §6  
**Flagged by:** AUTH-7, SECRETS-13, ORCHESTRATOR-13  
**Issue:** Workspace namespaces and PVCs are named after the Authentik `preferred_username` (mutable), so a deleted and recreated account with the same username inherits the previous user's home directory; additionally, a compromised workspace can plant persistent backdoors in ~/.bashrc that survive destroy/relaunch and capture the newly minted LiteLLM key injected at next launch.  
**Impact:** A recycled username gives a new user full access to the prior user's code, credentials, git history, and any secrets written to disk; a planted .bashrc hook defeats the rotate-key-on-relaunch security assumption by harvesting the fresh key at shell init time.  
**Fix:** Bind workspace namespaces and PVCs to the Authentik immutable `sub` claim rather than `preferred_username`, and consider persisting only specific subdirectories (e.g. ~/projects) rather than the entire home directory to limit the blast radius of a compromised session.

### ~~M-11~~ — ✅ ADDRESSED (Admin UI) — Removing User from grp-api in Authentik Does Not Revoke Their LiteLLM Virtual Key
**Location:** 15-identity-sso.md; 07-gateway-litellm.md  
**Flagged by:** AUTH-8  
**Issue:** LiteLLM virtual keys are minted manually and are not session-bound; removing a user from grp-api in Authentik does not trigger any key revocation in LiteLLM, so the user retains valid API access indefinitely.  
**Impact:** A departing friend whose Authentik account is removed can continue making API calls and consuming GPU budget until an admin manually calls `/key/delete`, contradicting the documented claim that group removal 'revokes access everywhere on next auth'.  
**Fix (addressed by design):** The Admin UI (step 17) makes user deprovision a single operation that atomically revokes the LiteLLM key, removes the Authentik group membership, and deletes the Open WebUI account. No separate manual step required. The deprovision flow is documented in 17-admin-ui.md.

### M-12 — Open WebUI OIDC SSO Is Optional — Authentik Removal Does Not Disable WebUI Account
**Location:** 15-identity-sso.md §Setup outline step 5; 08-webui-open-webui.md; 10-connectivity-cloudflare.md §3  
**Flagged by:** AUTH-9, AUTH-14  
**Issue:** Open WebUI uses its own local account store by default instead of Authentik OIDC SSO, so removing a user from Authentik leaves their WebUI account active; combined with a 24-hour Cloudflare Access session, a removed user can continue chatting for up to a full day.  
**Impact:** A friend who should be cut off retains full conversational UI access until both their CF Access session expires and their Open WebUI account is manually deleted — an identity lifecycle gap that is easy to miss under operational pressure.  
**Fix:** Make Open WebUI OIDC SSO with Authentik a mandatory setup step rather than optional, and reduce the Cloudflare Access session duration to 4–8 hours; document a formal offboarding checklist that covers all three layers (Authentik, CF Access revocation, Open WebUI account deletion as a fallback).

### M-13 — code-server Runs Without Authentication by Default — Cloudflare Access Is the Only Auth Layer
**Location:** assets/workspace-base/Dockerfile CMD; 16-workspaces.md §9  
**Flagged by:** AUTH-10, CONTAINER-20, INGRESS-15, ORCHESTRATOR-15, SECRETS-22  
**Issue:** The workspace Dockerfile launches code-server without `--auth password`; the orchestrator 'may' inject a per-session password but this is not mandatory, meaning a Cloudflare Access bypass (misconfigured policy, stolen JWT, or Traefik routing error) yields unauthenticated full IDE access with a terminal.  
**Impact:** Any path that bypasses Cloudflare Access and reaches Traefik — stolen CF Access cookie, CF outage, SSRF from another workspace pod — delivers immediate arbitrary code execution in the workspace container with access to the user's home PVC and injected LiteLLM key.  
**Fix:** Make `--auth password` mandatory in the Dockerfile CMD with a cryptographically random per-session secret generated and stored by the orchestrator in a Kubernetes Secret, then displayed to the user once at workspace launch.

### M-14 — Per-Workspace LiteLLM Key Stored as Plaintext Kubernetes Secret with Broad Orchestrator Read Access
**Location:** 16-workspaces.md §5, §6  
**Flagged by:** AUTH-11, SECRETS-14, ORCHESTRATOR-16  
**Issue:** Workspace LiteLLM keys are stored as Kubernetes Secrets in each ws-* namespace, but the orchestrator ClusterRole grants get/list/watch on secrets cluster-wide, meaning the orchestrator can enumerate all live workspace keys at any time, and any container with RCE can read the key from `/proc/1/environ`.  
**Impact:** A bug in the orchestrator API could cross-disclose one user's LiteLLM key to another user; etcd encryption is not enabled by default in MicroK8s, so all stored key values are readable from the host filesystem data directory.  
**Fix:** Enable MicroK8s etcd encryption at rest, rotate workspace LiteLLM keys on every workspace restart with short TTLs, and scope the orchestrator's Secret access to only the specific ws-* namespace it is currently managing rather than cluster-wide.

---
## LOW

### M-15 — LITELLM_MASTER_KEY Uses Indistinct 'sk-' Prefix Shared with All Virtual Keys
**Location:** assets/.env.example; assets/litellm-config.yaml  
**Flagged by:** AUTH-13  
**Issue:** The .env.example pre-fills LITELLM_MASTER_KEY=sk-, making the master key format identical to virtual keys and preventing WAF rules or log scanners from distinguishing the master key from user keys.  
**Impact:** A master key that accidentally appears in logs or WAF traffic cannot be programmatically identified as higher-privilege, and format-based filtering to block master key usage on the public API endpoint is impossible.  
**Fix:** Use a distinct prefix for the master key (e.g. `sk-admin-`) to differentiate it from virtual keys, enabling WAF rules that block the admin prefix on the public api.domain.com endpoint while allowing normal virtual key traffic.

### M-16 — Cloudflare Access Session Duration of 24h Gives Removed Users Extended Access Window
**Location:** 10-connectivity-cloudflare.md §3; assets/cloudflare-access-notes.md §2  
**Flagged by:** AUTH-14  
**Issue:** The Cloudflare Access session is configured for 24 hours, so a user removed from the allowlist retains an active browser session for up to a full day.  
**Impact:** Combined with the lack of mandatory Open WebUI OIDC SSO (M-12), a departing user may retain UI access for the maximum session window, especially dangerous if revocation is urgent.  
**Fix:** Reduce the CF Access session duration to 4–8 hours and use Cloudflare's session revocation feature (Zero Trust > Access > Revoke User Sessions) as the first step in any offboarding procedure.

---
## MEDIUM

### ~~M-17~~ — ✅ FIXED (see H-16) — Tailscale SSH ACL Permits Direct Root Login from Any Admin Device
**Location:** assets/tailscale-acl.json  
**Flagged by:** AUTH-15  
**Issue:** The Tailscale SSH ACL allows autogroup:admin to SSH to the server as `root`, meaning a stolen or malware-infected admin device immediately yields a root shell on the LLM server without requiring any additional credential.  
**Impact:** Full host compromise — all services, secrets, model weights, and user data — collapses to the question of whether a personal admin device is uncompromised.  
**Fix:** Remove `root` from the Tailscale SSH allowed users, require sudo escalation from a non-root account for all administrative actions, and enable Tailscale device posture checks to gate enrollment of admin devices.

### M-18 — Wildcard Workspace Tunnel Route Combined with Non-Unique IDs Risks Hostname Collision and Session Confusion
**Location:** 16-workspaces.md §9; 10-connectivity-cloudflare.md §2  
**Flagged by:** NET-18, INGRESS-6  
**Issue:** The *.ws.domain.com wildcard tunnel route hands all workspace routing to Traefik, and workspace IDs are username-derived rather than cryptographically random, creating a risk of hostname collision if a username is recycled or an ID is reused for a different user.  
**Impact:** A user whose workspace was destroyed and whose ID is reassigned to a new user could — via cached bookmarks or IDE settings — reach the wrong workspace pod; a Traefik routing bug on the wildcard amplifies this into cross-user session access.  
**Fix:** Use UUID4 workspace IDs, enforce global uniqueness in the orchestrator with a persistent ID registry, implement exact-match HTTPRoutes per workspace, and configure Traefik to return 404 for *.ws.domain.com hostnames with no matching HTTPRoute.

---
## LOW

### ~~M-19~~ — ✅ FIXED (see H-16) — SSH ListenAddress Restriction Is Documented as Optional with No Mandatory Verification Step
**Location:** 09-connectivity-tailscale.md §4 — Lock SSH to Tailscale  
**Flagged by:** NET-19  
**Issue:** Step 09 §4 presents restricting sshd to the Tailscale interface as an alternative option ('or restrict via your VLAN/firewall') with no blocking verification before proceeding, leaving SSH potentially listening on 0.0.0.0.  
**Impact:** If skipped or misconfigured, SSH is exposed to all LAN devices, providing a direct brute-force attack surface that conflicts with the VLAN isolation goal.  
**Fix:** Make the ListenAddress restriction mandatory and add a blocking verification command (`ss -tlnp | grep sshd` should show only the Tailscale IP) before the section is considered complete.

### M-20 — No mTLS Between In-Cluster Services and No CF Access JWT Validation at Application Layer
**Location:** 16-workspaces.md §8; assets/litellm-config.yaml; assets/cloudflare-access-notes.md §1  
**Flagged by:** NET-17, INGRESS-11  
**Issue:** All in-cluster communication uses plain HTTP with no mTLS, and internal services do not validate the Cf-Access-Jwt-Assertion header Cloudflare Access adds to requests, so any pod on the same network can inject requests that appear indistinguishable from legitimate Cloudflare-forwarded traffic.  
**Impact:** A host-level compromise or a container on llmnet can read all API keys and user prompts in transit and impersonate authenticated users at the application layer without triggering any Cloudflare-enforced identity check.  
**Fix:** At minimum validate the CF Access JWT assertion header in Open WebUI and LiteLLM (Cloudflare publishes per-team public keys); for full protection, deploy a lightweight service mesh (e.g. Linkerd) to provide mTLS for in-cluster service identity.

---
## MEDIUM

### M-21 — No Pod Security Admission Labels on ws-* Namespaces — Pod Spec Hardening Is Not Admission-Enforced
**Location:** 16-workspaces.md §5 — Orchestrator namespace creation; §6 Workspace pod spec  
**Flagged by:** CONTAINER-6, HOST-9  
**Issue:** The orchestrator creates ws-* namespaces without PodSecurityAdmission labels, so the namespace defaults to the `privileged` PSA standard; the hardened pod spec (no hostPID/hostNetwork/hostIPC, drop ALL caps) is an intent in a Deployment template, not an admission-enforced guarantee, and hostPID/hostNetwork/hostIPC are not explicitly set to false in the spec.  
**Impact:** A compromised orchestrator or a Kubernetes admission path bypass can create pods in ws-* namespaces with hostNetwork: true (defeats all NetworkPolicies) or privileged: true (trivial container escape to the host via NVIDIA device nodes).  
**Fix:** Apply `pod-security.kubernetes.io/enforce: baseline` (aiming for `restricted`) labels to every ws-* namespace at creation time in the orchestrator, and add explicit `hostPID: false`, `hostNetwork: false`, `hostIPC: false` to the pod spec template.

### M-22 — Orchestrator ClusterRole Grants Cluster-Wide Secret and Pod Management Including Core Namespaces
**Location:** 16-workspaces.md §5 — Orchestrator RBAC (ClusterRole orchestrator)  
**Flagged by:** CONTAINER-7, SECRETS-17, ORCHESTRATOR-16  
**Issue:** The orchestrator ClusterRole grants create/get/list/watch/patch/delete on secrets and pods across all namespaces via a ClusterRoleBinding, giving it read/write access to llm-core and llm-platform secrets (LITELLM_MASTER_KEY, CF_TUNNEL_TOKEN, etc.) that it has no legitimate need to access.  
**Impact:** Orchestrator compromise yields full cluster secret exfiltration of every high-value credential, deletion of inference/litellm pods (denial of service), and the ability to remove NetworkPolicy isolation from any namespace.  
**Fix:** Replace the single ClusterRoleBinding with a ClusterRole only for genuinely cluster-scoped resources (namespaces, PVs) and dynamic per-namespace RoleBindings in ws-* namespaces for secrets and pods; explicitly deny orchestrator SA access to llm-core and llm-platform.

### M-23 — Docker Stack Runs All Containers as Root with No userns-remap Configured
**Location:** 02-host-os-ubuntu.md (Docker installation); assets/docker-compose.yml  
**Flagged by:** CONTAINER-8  
**Issue:** The Docker engine runs in default root mode with no user namespace remapping, so all Docker Compose services (inference, litellm, open-webui, cloudflared) execute as UID 0 mapped to host root.  
**Impact:** A container escape from any Docker service — particularly the GPU-access inference container — immediately yields host root access and full read access to the .env file containing all secrets.  
**Fix:** Enable Docker user namespace remapping (`{"userns-remap": "default"}` in /etc/docker/daemon.json) or migrate to rootless Podman; configure the NVIDIA container toolkit's no-cgroups mode to support userns-remap for GPU access.

### M-24 — Inference Container Runs as Root with No securityContext, cap_drop, or read_only Filesystem
**Location:** assets/docker-compose.yml (service: inference); assets/inference/Dockerfile  
**Flagged by:** CONTAINER-9  
**Issue:** The inference Docker service has no `user:` directive, no `security_opt`, no `cap_drop`, and no `read_only: true`, leaving the TabbyAPI / llama-swap process running as root with GPU device access and a writable bind-mount of /srv/models.  
**Impact:** A vulnerability in the inference stack exploitable by a crafted model file or API request gives an attacker a root shell with GPU device access and potential host escape via /dev/nvidia* or /proc.  
**Fix:** Add a non-root user in the Dockerfile (`useradd -u 1001 inference`), switch with `USER inference`, and add `security_opt: ["no-new-privileges:true"]`, `read_only: true`, and `cap_drop: ["ALL"]` to the docker-compose service definition.

### M-25 — Non-Inference Docker Compose Services Have No security_opt, cap_drop, or Non-Root User
**Location:** assets/docker-compose.yml (services: litellm, open-webui, cloudflared)  
**Flagged by:** CONTAINER-15  
**Issue:** litellm, open-webui, and cloudflared are defined in docker-compose.yml with no `security_opt: ["no-new-privileges:true"]`, no `cap_drop: ["ALL"]`, and no explicit `user:` directive, leaving them running as root with default Docker security settings.  
**Impact:** A vulnerability in any of these services can exploit setuid binaries inside the container to escalate to root within the container, and without userns-remap this is equivalent to host root.  
**Fix:** Add `security_opt: ["no-new-privileges:true"]`, `cap_drop: ["ALL"]`, `read_only: true` (with tmpfs mounts for writable paths), and explicit non-root `user:` directives to each service definition.

---
## LOW

### M-26 — GPU Device Scope Is 'count: all' — Automatically Expands to All GPUs on Hardware Change
**Location:** assets/docker-compose.yml (inference service, deploy.resources.reservations.devices.count: all)  
**Flagged by:** CONTAINER-10, OPS-18  
**Issue:** The inference service requests `count: all` GPUs rather than a specific device UUID, so any future GPU addition automatically grants the inference container access to all cards without a deliberate security review.  
**Impact:** On a multi-GPU host, a compromised inference container can access all GPU memory across all cards, potentially reading sensitive data from co-located GPU processes or monopolizing all GPU resources.  
**Fix:** Replace `count: all` with `device_ids: ['GPU-<uuid>']` using the UUID from `nvidia-smi`, pinning the container to exactly the intended GPU.

---
## MEDIUM

### M-27 — Traefik Gateway Allows HTTPRoutes from All Namespaces — Any Namespace Can Register Public Routes
**Location:** 16-workspaces.md §3 — Traefik Gateway setup (gateway.yaml: allowedRoutes.namespaces.from: All)  
**Flagged by:** AUTH-19, CONTAINER-11, INGRESS-10, ORCHESTRATOR-9  
**Issue:** The main-gateway Gateway is configured with `allowedRoutes.namespaces.from: All`, allowing any namespace (including ws-* namespaces) to attach HTTPRoutes that can specify arbitrary hostnames including llm.domain.com or api.domain.com.  
**Impact:** A compromised orchestrator, or any future path to create Kubernetes resources in a workspace namespace, could register a rogue HTTPRoute that intercepts or redirects traffic for other users or internal services without any hostname-level admission control.  
**Fix:** Change `allowedRoutes.namespaces` to `from: Selector` targeting only llm-platform and llm-core, add hostname allowlist validation in the orchestrator rejecting any non-ws-*.ws.domain.com pattern, and have the orchestrator create HTTPRoutes in its own namespace (llm-platform) rather than workspace namespaces.

### M-28 — No seccompProfile at Container Level in Workspace Pod securityContext
**Location:** 16-workspaces.md §6 — Workspace pod spec (containers[0].securityContext)  
**Flagged by:** CONTAINER-5  
**Issue:** The seccompProfile (RuntimeDefault) is set only at pod level, not at container level; the container-level securityContext block explicitly sets other fields but omits seccompProfile, creating an auditing gap and leaving ptrace/io_uring/keyctl accessible under RuntimeDefault.  
**Impact:** A workspace user who achieves RCE within code-server can call syscalls not blocked by RuntimeDefault (notably ptrace on child processes, io_uring, keyctl) that are useful in kernel exploit chains.  
**Fix:** Duplicate `seccompProfile: {type: RuntimeDefault}` into the container-level securityContext, and for stronger isolation author a custom Localhost seccomp profile that additionally denies ptrace, io_uring, userfaultfd, keyctl, bpf, and perf_event_open.

### ~~M-29~~ — ✅ FIXED (partial) — Workspace Base Dockerfile Installs Unpinned pip Packages as Root
**Location:** assets/workspace-base/Dockerfile lines 7–18; assets/workspace-base/Dockerfile line 3  
**Flagged by:** CONTAINER-14, HOST-22, OPS-11, ORCHESTRATOR-10  
**Issue:** The workspace Dockerfile installed `pip3 install --no-cache-dir aider-chat` (unpinned) as root, using a floating `codercom/code-server:latest` base image with no digest pin.  
**Fix (implemented):** aider-chat install now requires an explicit version pin (`aider-chat==VERSION` with comment pointing to PyPI). Base image pinning follows the H-8 procedure (same `docker inspect` + FROM-line update at first build). Accepted residual: transitive PyPI dependency hashing (`pip-compile --generate-hashes` + `--require-hashes`) is not implemented — full hash pinning of a deep dependency tree is a significant maintenance burden for a workspace image that is rebuilt infrequently; operator is expected to review aider-chat release notes when bumping the version.

### M-30 — All Container Images Use Mutable Tags — Silent Supply-Chain Substitution on Next Pull
**Location:** assets/docker-compose.yml (litellm: main-stable, open-webui: main, cloudflared: latest)  
**Flagged by:** CONTAINER-16, HOST-16, INGRESS-12  
**Issue:** LiteLLM, Open WebUI, and cloudflared are all referenced with mutable image tags that resolve to different digests on each `docker compose pull`, providing no integrity guarantee between deployments.  
**Impact:** An upstream tag re-point or registry compromise would be silently pulled at the next restart, potentially introducing backdoored versions of the services that handle authentication, API key enforcement, and the Cloudflare tunnel.  
**Fix:** Pin all images to their immutable SHA-256 digest (`image: ghcr.io/berriai/litellm@sha256:<digest>`) and establish a controlled update process that explicitly reviews changelogs and updates digest pins after validation.

---
## LOW

### M-31 — Orchestrator Can Delete Its Own Deployment and Core Namespaces — Self-Inflicted DoS Vector
**Location:** 16-workspaces.md §5 — Orchestrator RBAC (verbs: delete on namespaces, deployments)  
**Flagged by:** CONTAINER-17  
**Issue:** The orchestrator ClusterRole includes `delete` on namespaces and deployments with no RBAC restriction preventing it from deleting its own Deployment or the llm-platform namespace, which could be triggered by a logic bug or injection attack via a crafted Authentik group claim.  
**Impact:** Accidental or malicious deletion of the llm-platform namespace takes down Traefik, cloudflared, and Authentik simultaneously, requiring manual recovery via Tailscale SSH.  
**Fix:** Restrict namespace delete permissions to namespaces with a `workspace: "true"` label (applied to ws-* at creation time), add an admission webhook or Kyverno policy blocking deletion of llm-platform and llm-core, and add a PodDisruptionBudget for the orchestrator requiring minAvailable: 1.

---
## INFO

### M-32 — ResourceQuota Lacks Storage Limits — Workspace Users Can Fill the Host NVMe
**Location:** 16-workspaces.md §7 — Resource management (workspace-quota ResourceQuota)  
**Flagged by:** CONTAINER-19  
**Issue:** The workspace ResourceQuota limits CPU, memory, and pod count but sets no `requests.storage` cap, and the home PVC has no `resources.requests.storage` field; on MicroK8s with hostpath-storage, PVC capacity is limited only by the host NVMe that also holds model weights.  
**Impact:** A user can fill their home directory without bound, potentially consuming all available disk space and crashing pods or preventing model downloads for all users.  
**Fix:** Add `requests.storage: 10Gi` to the PVC spec and a matching `requests.storage` total to the ResourceQuota, and implement node-level disk quotas (ext4/XFS project quotas) for the hostpath provisioner base directory.

---
## MEDIUM

### M-33 — All Stack Secrets in a Single Flat Plaintext .env File with No Permission Hardening
**Location:** 04-deploy-stack-ubuntu.md §2; assets/.env.example  
**Flagged by:** HOST-19, SECRETS-2, OPS-19  
**Issue:** All high-value secrets (CF_TUNNEL_TOKEN, LITELLM_MASTER_KEY, LITELLM_SALT_KEY, WEBUI_SECRET_KEY, TABBY_API_KEY) coexist in a single /opt/home-llm/.env file with no documented chmod, making a single point of exposure — backup leak, shell history, file permission error — a full credential compromise.  
**Impact:** CF_TUNNEL_TOKEN exposure allows hijacking the Cloudflare tunnel; LITELLM_MASTER_KEY exposure allows minting unlimited API keys; WEBUI_SECRET_KEY exposure allows forging all Open WebUI session tokens; all are lost simultaneously from one file.  
**Fix:** Apply `chmod 600 /opt/home-llm/.env` immediately after creation (document this in step 04, not step 14), separate high-impact secrets (CF_TUNNEL_TOKEN, LITELLM_MASTER_KEY) into Docker secrets or a systemd credential store, and ensure backups exclude or encrypt the .env file.

### M-34 — etcd / dqlite Data at Rest Is Unencrypted — Kubernetes Secrets Readable from Host Filesystem
**Location:** 16-workspaces.md §5; assets/litellm-config.yaml; assets/docker-compose.yml  
**Flagged by:** HOST-8, SECRETS-5, AUTH-11  
**Issue:** MicroK8s does not enable etcd encryption at rest by default, so all Kubernetes Secrets (workspace LiteLLM keys, any key material stored as Secrets) are base64-encoded plaintext in the dqlite data directory at /var/snap/microk8s/current/; the LiteLLM SQLite database in its Docker volume is also unencrypted.  
**Impact:** Physical access to the NVMe, or any host-level process reading the snap data directory, exposes all active workspace LiteLLM keys plus any other secret stored as a Kubernetes Secret.  
**Fix:** Enable Kubernetes secret encryption at rest via an EncryptionConfiguration manifest passed to kube-apiserver (`--encryption-provider-config`), enable full-disk encryption (LUKS) on the OS drive, and ensure /var/lib/docker is on an encrypted partition.

### M-35 — /srv/models Is World-Readable — Model Weights Accessible to Any Local Process
**Location:** 03-storage-ubuntu.md §4; 04-deploy-stack-ubuntu.md §3  
**Flagged by:** HOST-5  
**Issue:** Step 03 sets ownership of /srv/models with `chown -R $USER:$USER` but leaves default 755 permissions, making multi-gigabyte model weight files readable by any local user or container that can access the host filesystem.  
**Impact:** Model weight exfiltration (IP/licensing value) and, if the directory is writable, the possibility of silently replacing weights with adversarially modified versions.  
**Fix:** Apply `chmod 750 /srv/models` after chown, create a dedicated `llm` group for the inference container GID, and mount the models directory as `:ro` in docker-compose if TabbyAPI only requires read access.

### M-36 — Tailscale ACL Opens All Ports on tag:llm to Admin Devices
**Location:** assets/tailscale-acl.json; 09-connectivity-tailscale.md §3  
**Flagged by:** HOST-11  
**Issue:** The Tailscale ACL uses a wildcard `tag:llm:*` giving autogroup:admin unrestricted access to every listening port on the server — including the raw inference API (8080), MicroK8s API server (16443), LiteLLM (4000), and Open WebUI (3000).  
**Impact:** A compromised admin device gains direct access to every service without further authentication, including services that bypass LiteLLM key enforcement and the k8s API server.  
**Fix:** Restrict the ACL to only the specific ports needed for administration (e.g. SSH 22, k8s API 16443, and optionally Open WebUI 3000) using port-specific rules like `tag:llm:22,16443,3000`.

### M-37 — MicroK8s hostpath-storage Has No Path Restriction — PVCs Could Reference Sensitive Host Directories
**Location:** 16-workspaces.md §1; 02-host-os-ubuntu.md  
**Flagged by:** HOST-13  
**Issue:** The hostpath-storage addon provisions PVs from arbitrary host directories with no documented base-path restriction, and MicroK8s daemons run with root privileges and full host cgroup, mount, and PID namespace access.  
**Impact:** A misconfigured StorageClass or orchestrator bug could provision a PVC from /etc, /root, or /opt/home-llm, exposing sensitive host files inside a workspace pod.  
**Fix:** Configure the hostpath-storage addon with a restricted base path (e.g. /srv/k8s-volumes) and verify no PVC can be created outside that directory; document the kubelet host-access trust boundary in the architecture.

### M-38 — llama-swap Binary Downloaded in Dockerfile Without Checksum Verification
**Location:** assets/inference/Dockerfile line 12  
**Flagged by:** HOST-15  
**Issue:** The inference Dockerfile uses `ADD <github-url>` to download the llama-swap pre-built binary with no SHA-256 checksum verification; a GitHub account takeover of the upstream repo would silently substitute a malicious binary.  
**Impact:** A backdoored llama-swap binary would run as root in the inference container with GPU access and read access to all model weights, providing a complete host-escape primitive.  
**Fix:** Replace the `ADD` URL with a `RUN curl | sha256sum -c` block that downloads the binary and verifies a hardcoded expected hash, updating the hash intentionally on each version bump.

### M-39 — Workspace Egress Allows Unrestricted Internet with No Monitoring or DNS Filtering
**Location:** 16-workspaces.md §4a (workspace-isolation NetworkPolicy); 14-operations.md Monitoring  
**Flagged by:** HOST-17, OPS-13  
**Issue:** The workspace egress NetworkPolicy permits all traffic to 0.0.0.0/0 except RFC1918 ranges with no flow logging, DNS query logging, or bandwidth accounting, making data exfiltration via HTTPS or DNS tunneling completely undetectable.  
**Impact:** A compromised workspace can silently exfiltrate user code, credentials written to the home PVC, and the injected LiteLLM API key to arbitrary internet destinations with no detection mechanism.  
**Fix:** Enable Calico flow log collection for workspace namespaces, implement a DNS-based egress proxy (e.g. CoreDNS with a firewall plugin) logging all lookups, and consider per-namespace bandwidth quotas to detect anomalous egress volume.

---
## LOW

### M-40 — Tailscale Installed via Unverified curl-pipe-sh Script
**Location:** 09-connectivity-tailscale.md §1  
**Flagged by:** HOST-14, OPS-14  
**Issue:** Step 09 installs Tailscale via `curl -fsSL https://tailscale.com/install.sh | sh` with no integrity verification; the `-fsSL` flags follow redirects silently and the script executes with root privileges.  
**Impact:** A DNS hijack, CDN compromise, or MITM during installation could deliver a malicious script that installs a backdoored admin-plane daemon, granting persistent root access over the server's Tailscale overlay.  
**Fix:** Use the Tailscale APT repository with GPG signature verification instead (`apt install tailscale`), and verify the GPG key fingerprint against Tailscale's published value before importing.

### M-41 — Tailscale Key Expiry Disabled for Server Node — Permanent Node Key with No Forced Re-Auth
**Location:** 09-connectivity-tailscale.md §1  
**Flagged by:** HOST-20  
**Issue:** The server's Tailscale node key has expiry disabled, meaning it is permanently valid until manually revoked; a decommissioned server whose key is not revoked remains a permanent valid node on the tailnet.  
**Impact:** A stolen or leaked Tailscale node key (from /var/lib/tailscale/) allows an attacker to permanently impersonate the server on the tailnet without the key ever expiring.  
**Fix:** Document a decommission procedure that explicitly revokes the server's Tailscale node, monitor Tailscale audit logs for unexpected connections from the server tag, and consider enabling Tailnet Lock for additional key validation.

### M-42 — No AppArmor Custom Profiles for Docker Containers
**Location:** 04-deploy-stack-ubuntu.md; 02-host-os-ubuntu.md  
**Flagged by:** HOST-21  
**Issue:** Docker applies only the generic `docker-default` AppArmor profile to all containers with no custom profiles for the inference container, which runs a custom binary from GitHub with GPU device access.  
**Impact:** A container exploit in the inference stack benefits from relatively broad syscall access limited only by the generic profile; custom confinement would meaningfully raise the exploitation bar.  
**Fix:** Verify the `docker-default` AppArmor profile is active for all containers (`docker inspect <container> | grep AppArmor`) and author a custom profile for the inference container restricting it to the specific syscalls and device paths required by llama-swap and TabbyAPI.

---
## MEDIUM

### M-43 — Backup Archives Are Unencrypted and Contain Active LiteLLM Virtual Keys
**Location:** 14-operations.md §Backups  
**Flagged by:** SECRETS-4  
**Issue:** The backup procedure tarballs openwebui-data and litellm-db volumes with no encryption; litellm.db contains all valid virtual key values, and backups are written to /srv/backups with no documented access controls.  
**Impact:** Any off-site copy of an unencrypted backup exposes all LiteLLM virtual keys in transit and at rest on the backup destination, enabling immediate API abuse by anyone who obtains the archive.  
**Fix:** Encrypt all backup archives before writing to /srv/backups using `gpg --symmetric` or restic with an encrypted repository, set chmod 700 on /srv/backups, and require encrypted transport for any off-site transfer.

### M-44 — CF_TUNNEL_TOKEN Exposed as Docker Environment Variable — Readable by docker group Members
**Location:** assets/docker-compose.yml (cloudflared service); assets/.env.example  
**Flagged by:** SECRETS-6  
**Issue:** CF_TUNNEL_TOKEN is passed as a container environment variable, making it readable via `docker inspect cloudflared` by any user in the `docker` group — which is effectively root-equivalent.  
**Impact:** Any local user in the docker group can steal the tunnel token, giving full control of the Cloudflare tunnel including the ability to connect a rogue cloudflared instance and intercept all routed traffic.  
**Fix:** Use Docker secrets (`secrets:` stanza in compose) or mount the token from a file using cloudflared's `--credentials-file` option instead of injecting it as an environment variable.

### M-45 — TABBY_API_KEY Passed on Command Line — Visible in /proc/cmdline and ps aux
**Location:** assets/llama-swap-config.yaml; assets/docker-compose.yml (inference service)  
**Flagged by:** SECRETS-8  
**Issue:** TABBY_API_KEY is interpolated into the TabbyAPI command-line argument `--api-key ${TABBY_API_KEY}`, making it readable from `ps aux` and `/proc/<pid>/cmdline` on the host.  
**Impact:** Any host process or container with /proc access can read the TabbyAPI key, enabling direct calls to the inference endpoint that bypass LiteLLM key enforcement if the inference port is ever accidentally exposed.  
**Fix:** Configure TabbyAPI to read its API key from an environment variable or config file rather than a command-line argument, eliminating the --api-key flag from the process command line.

### M-46 — No Documented Rotation Procedure for CF_TUNNEL_TOKEN, LITELLM_MASTER_KEY, or LITELLM_SALT_KEY
**Location:** 14-operations.md §Key & access hygiene; assets/.env.example  
**Flagged by:** SECRETS-9, OPS-10  
**Issue:** Step 14 documents rotating per-friend virtual keys but is silent on rotating CF_TUNNEL_TOKEN, LITELLM_MASTER_KEY, or LITELLM_SALT_KEY; there is no recovery path documented if the tunnel token is leaked, and no rotation schedule for the master key that grants full API gateway admin.  
**Impact:** A leaked CF_TUNNEL_TOKEN or LITELLM_MASTER_KEY has an indefinite validity window because operators have no documented procedure to identify the exposure, rotate, and re-secure the stack.  
**Fix:** Add rotation procedures for all three keys to step 14 (LITELLM_SALT_KEY rotation requires coordinated key reissuance to all users), schedule quarterly rotation for the master key, and document CF_TUNNEL_TOKEN rotation via the Cloudflare dashboard. Friend virtual key revocation/reissuance is handled through the Admin UI (step 17) as a routine operation.

### M-47 — LiteLLM Verbose Logging May Write API Keys to Docker Log Files Readable by docker Group
**Location:** 14-operations.md Monitoring; assets/litellm-config.yaml line 23  
**Flagged by:** OPS-6, SECRETS-16  
**Issue:** `set_verbose: false` is commented out in litellm-config.yaml; at verbose log levels LiteLLM logs request headers including bearer tokens, and Docker log files are accessible to any user in the docker group.  
**Impact:** API keys from every request — including accidentally misdirected third-party credentials — may persist indefinitely in /var/lib/docker/containers/ in plaintext and be readable without elevated privileges.  
**Fix:** Explicitly set `set_verbose: false` in litellm-config.yaml, add `LITELLM_LOG=ERROR` to the environment, and configure Docker log rotation (`max-size: 10m, max-file: 3`) for the litellm service.

### M-48 — NVIDIA Container Toolkit Installed Without Version Pinning or GPG Fingerprint Verification
**Location:** 02-host-os-ubuntu.md §7  
**Flagged by:** OPS-7  
**Issue:** The toolkit is installed with `apt install -y nvidia-container-toolkit` without pinning a version and without verifying the repository GPG key fingerprint; the toolkit has had container-escape CVEs (CVE-2024-0132, CVE-2024-0133) and runs as a privileged Docker daemon component.  
**Impact:** An unpatched toolkit CVE is a direct path from the GPU inference container to the host OS; without version pinning there is no visibility into which CVEs are outstanding between `apt upgrade` runs.  
**Fix:** Pin the toolkit to a specific version, verify the GPG key fingerprint against NVIDIA's published value before importing, subscribe to NVIDIA's security advisory feed, and document an explicit toolkit update cadence separate from general apt upgrade.

### M-49 — MicroK8s Receives Automatic Snap Updates That Can Break Cluster Behavior Without Notice
**Location:** 16-workspaces.md §1  
**Flagged by:** OPS-8  
**Issue:** MicroK8s is distributed via snap, which applies automatic updates up to 4 times daily by default; a minor version bump can alter CNI behavior (transiently removing NetworkPolicy enforcement during Calico pod restart) or break the orchestrator's k8s client API compatibility.  
**Impact:** Unplanned snap updates can silently break workspace isolation during CNI restart, leave orphaned LiteLLM keys billable against user budgets, or render the orchestrator unable to manage workspaces until an API incompatibility is diagnosed.  
**Fix:** Pin MicroK8s to a specific channel (`snap install microk8s --channel=1.31/stable`) and hold automatic refreshes (`snap refresh --hold microk8s`); test upgrades on a non-production clone before applying to the live node.

### M-50 — Authentik Helm Chart Deployed Without Chart Version or Image Digest Pinning
**Location:** 15-identity-sso.md Setup outline step 1  
**Flagged by:** OPS-9  
**Issue:** The Authentik Helm installation specifies no `--version`, pulling the latest chart at install time; subsequent `helm upgrade` without version pinning will automatically apply whatever chart is current at upgrade time.  
**Impact:** An unplanned Authentik breaking change could simultaneously lock all users out of every protected service; a supply chain compromise of the Authentik chart or images would compromise the entire identity layer.  
**Fix:** Pin the Authentik Helm chart to a specific version (`--version 2024.x.y`), pin image tags and digests in a versioned values.yaml committed to version control, and subscribe to Authentik's security advisory feed.

---
## LOW

### M-51 — WEBUI_SECRET_KEY Rotation Invalidates All Sessions and Is Undocumented — Empty Value Allowed
**Location:** assets/.env.example; assets/docker-compose.yml  
**Flagged by:** AUTH-18, SECRETS-19  
**Issue:** WEBUI_SECRET_KEY rotation invalidates all active Open WebUI sessions simultaneously, but this is undocumented in step 14's rotation procedures, and the .env.example does not prevent the key from being left empty (which may cause a predictable default).  
**Impact:** An operator responding to a suspected session hijack who rotates the key will cause unexpected mass logout; an empty or default key allows an attacker who knows the application's default behavior to forge session tokens for any user including admin.  
**Fix:** Document in step 14 that WEBUI_SECRET_KEY rotation invalidates all sessions (requires a maintenance window), enforce a non-empty value in the .env.example with a startup health check, and add this key to the quarterly rotation schedule.

---
## MEDIUM

### M-52 — No Maximum Concurrent Workspace Limit — grp-workspaces Users Can Exhaust Host Resources
**Location:** 16-workspaces.md §5, §7  
**Flagged by:** ORCHESTRATOR-8  
**Issue:** The orchestrator's workspace launch flow has no pre-launch check of total active workspace count across all ws-* namespaces; per-namespace ResourceQuota limits are enforced per user but there is no cluster-wide cap.  
**Impact:** Any grp-workspaces user can trigger enough concurrent workspace launches to exhaust the host's remaining RAM (4 GiB quota × multiple users), causing OOM kills that degrade inference quality or crash LiteLLM/Authentik pods.  
**Fix:** Implement a configurable hard cluster-level concurrent workspace cap in the orchestrator (query active workspace Deployments across all ws-* namespaces before launch and reject if the cap is reached), and enforce per-user concurrent workspace limits in the orchestrator launch logic independent of ResourceQuota.

### M-53 — Orchestrator OIDC Session Group Membership Not Re-Validated on Each Request
**Location:** 16-workspaces.md §5; 15-identity-sso.md  
**Flagged by:** ORCHESTRATOR-12  
**Issue:** The orchestrator does not document re-validating group membership claims at each API call; if it caches claims at login time, a user removed from grp-workspaces in Authentik retains the ability to manage their workspace until their orchestrator session expires.  
**Impact:** A user whose access is revoked in Authentik can continue to launch workspaces, mint LiteLLM keys, and interact with the orchestrator for the duration of their cached session.  
**Fix:** Implement short-lived orchestrator sessions (max 1 hour) with re-authentication, and re-validate group membership against Authentik's userinfo endpoint on every state-changing orchestrator API call with a short TTL cache (≤5 minutes).

---
## LOW

### M-54 — Workspace Egress NetworkPolicy Does Not Explicitly Block the Kubernetes API Server IP
**Location:** 16-workspaces.md §4a, §6  
**Flagged by:** ORCHESTRATOR-18  
**Issue:** The workspace NetworkPolicy relies on `automountServiceAccountToken: false` as the primary control preventing workspace pods from calling the Kubernetes API; there is no explicit network-layer block of the API server address (typically 10.96.0.1:443 in MicroK8s), so the defence-in-depth collapses if automount is ever accidentally re-enabled.  
**Impact:** If `automountServiceAccountToken: false` is removed from the pod spec during a template update, workspace pods immediately gain unauthenticated (but token-capable) access to the API server without any network-level control catching the regression.  
**Fix:** Add the Kubernetes API server ClusterIP (verify with `microk8s kubectl get svc kubernetes`) to the egress except list in the workspace NetworkPolicy, providing a network-layer backstop independent of the pod spec automount setting.

---
## MEDIUM

### M-55 — Traefik Dashboard Not Explicitly Disabled — Internal Service Topology Exposed to In-Cluster Pods
**Location:** 16-workspaces.md §3 (Traefik Helm install)  
**Flagged by:** INGRESS-7  
**Issue:** The Traefik Helm install does not explicitly disable the admin dashboard, which exposes all registered routes, backend services, TLS configuration, and middleware to any pod that can reach traefik.llm-platform on its dashboard port.  
**Impact:** Any pod that reaches the llm-platform namespace (via a NetworkPolicy gap or privilege escalation) can enumerate the full internal service topology — hostnames, backend names, ports — enabling targeted lateral movement and potentially unauthenticated route manipulation.  
**Fix:** Add `--set dashboard.enabled=false` (or equivalent) to the Traefik Helm install, and if the dashboard is required for operations, protect it with basic auth middleware and restrict it to Tailscale access only via a dedicated NetworkPolicy.

### M-56 — Cloudflare Access Session Cookie Scope for Wildcard *.ws.domain.com May Allow Cross-Workspace Cookie Reuse
**Location:** 10-connectivity-cloudflare.md §3; 15-identity-sso.md §3  
**Flagged by:** INGRESS-9  
**Issue:** A Cloudflare Access JWT issued for one ws-* subdomain under the wildcard *.ws.domain.com application may be accepted for any other subdomain in the same wildcard application; a compromised workspace running JavaScript in the code-server context can read and exfiltrate this cookie.  
**Impact:** A stolen CF Access JWT from one workspace could grant access to another workspace subdomain belonging to the same or a different user, valid for up to the configured 24-hour session duration.  
**Fix:** Verify Cloudflare Access's cookie scoping behavior for wildcard applications, shorten workspace application session duration to 1–2 hours, and make per-session code-server `--auth password` mandatory (M-13) so that a stolen CF cookie still cannot reach the IDE without the per-session password.

### ~~M-57~~ — ✅ FIXED (see H-20) — Docker Group Membership Grants Effective Root Without Acknowledgment in the Guide
**Location:** 02-host-os-ubuntu.md §6; 04-deploy-stack-ubuntu.md §6  
**Flagged by:** OPS-12  
**Issue:** Step 02 adds the operator's account to the `docker` group for convenience, but docker group membership is equivalent to passwordless root (any member can mount the host filesystem via a container) and this is not acknowledged anywhere in the guide.  
**Impact:** Any compromise of the operator's interactive shell session — SSH session hijack, malicious script, CI pipeline — immediately yields host root access via the Docker socket without any additional exploitation step.  
**Fix (implemented):** Closed by H-20. Admin account never added to docker group; dedicated `llm-svc` service account is the sole docker group member; docker group = effective root risk documented in step 02 §6.

---
## INFO

### M-58 — LiteLLM /health and /v1/models Endpoints Publicly Accessible — Software and Model Enumeration
**Location:** 07-gateway-litellm.md §1; 10-connectivity-cloudflare.md §4  
**Flagged by:** AUTH-17, INGRESS-14  
**Issue:** The /health and /v1/models endpoints on api.domain.com are unauthenticated and publicly accessible (CF Access is bypassed), disclosing that LiteLLM is the gateway, its version, and the full list of configured model names.  
**Impact:** Version disclosure enables targeted exploitation of known LiteLLM CVEs; model enumeration reveals the full inference stack to an attacker conducting reconnaissance before attempting key brute-force or API abuse.  
**Fix:** Add Cloudflare WAF rules blocking /health and /v1/models for unauthenticated requests, or restrict these paths to Tailscale-only access via LiteLLM's `allowed_ips` feature.

---
## LOW

### ~~M-59~~ — ✅ ADDRESSED (Admin UI) — Orchestrator Has No Audit Logging for Workspace Lifecycle and Key Minting Events
**Location:** 14-operations.md; 16-workspaces.md  
**Flagged by:** ORCHESTRATOR-17  
**Issue:** The operations guide describes monitoring for inference and LiteLLM logs but documents no structured audit logging for orchestrator actions (workspace launches, key mints, namespace creation/deletion, failed attempts) or Kubernetes API server audit logs for the orchestrator SA.  
**Impact:** Abuse — excessive workspace launches, namespace collision attempts, reconnaissance via failed API calls — and orchestrator compromise are undetectable and unscoped post-incident without a log trail.  
**Fix (addressed by design):** The Admin UI (step 17) is the single choke point for all administrative operations — user provisioning, key management, workspace force-stop, deprovision. Every action is logged with timestamp, operator identity (OIDC sub), operation type, and outcome, forwarded to the external Loki instance. The orchestrator logs its own workspace lifecycle events (launch, destroy, key mint/revoke) as structured output; the Admin UI audit log covers the human-initiated layer above that.

### M-60 — .env File Not Included in Backup — LITELLM_SALT_KEY Loss Makes Database Restores Useless
**Location:** 14-operations.md §Backups  
**Flagged by:** SECRETS-18  
**Issue:** The backup procedure backs up litellm-db and openwebui-data volumes but excludes /opt/home-llm/.env; loss of LITELLM_SALT_KEY after a host failure makes the backed-up litellm.db irretrievable because key hashes no longer match.  
**Impact:** After a disaster recovery event where the .env is lost, all friends must be re-issued LiteLLM keys despite having a valid database backup; operators may not realize this dependency until recovery is already failing.  
**Fix:** Add the .env file to the backup procedure, encrypted separately (e.g. GPG-encrypted, stored in a password manager), and document explicitly in step 14 that LITELLM_SALT_KEY and litellm.db are inseparable for recovery.

### M-61 — Shell History May Capture Plaintext Secrets During Setup
**Location:** 04-deploy-stack-ubuntu.md §2  
**Flagged by:** SECRETS-21  
**Issue:** Step 04 generates secrets via `openssl rand -hex 32` and instructs operators to fill .env, but does not warn against using echo or shell substitution commands that would persist secret values in ~/.bash_history or ~/.zsh_history.  
**Impact:** Shell history files backed up by cloud sync tools or readable by backup processes may expose all generated secrets in plaintext, and many operators naturally use echo/shell tricks when filling config files.  
**Fix:** Instruct operators to fill .env exclusively with a text editor (`nano /opt/home-llm/.env`), add a note about using `HISTFILE=/dev/null` during the setup session, and document that shell history sync tools should exclude ~/.bash_history on this machine.

---
## INFO

### M-62 — Persistent Home PVC Contains Potentially Compromised State After a Security Incident
**Location:** 16-workspaces.md §5 (orchestrator), §6 (workspace pod spec)  
**Flagged by:** CONTAINER-18  
**Issue:** The home PVC persists across workspace restarts and destroy operations by default; if a workspace was compromised (malicious package, supply-chain attack), the compromised state in ~/.bashrc, ~/.ssh, or ~/.local survives container restart and re-hardens a fresh workspace launch.  
**Impact:** Container restart cannot be used as a remediation path after a workspace compromise because the persistence mechanism (the PVC) is explicitly preserved; a new container launched from a clean image immediately re-inherits the attacker's foothold.  
**Fix:** Document this risk explicitly in §10 Security Caveats, expose an operator 'sanitize home' command that remounts /home/user from a clean snapshot, and recommend the destroy-with-PVC-deletion path as the required remediation for confirmed compromises.

---
## LOW

### M-63 — SQLite LiteLLM Database Has No Log Rotation and No Integrity Monitoring
**Location:** assets/litellm-config.yaml line 27; assets/docker-compose.yml; 14-operations.md Backups  
**Flagged by:** OPS-15, OPS-16  
**Issue:** The litellm.db SQLite database has no query audit trail or change monitoring, and Docker container logs for all services have no size or rotation limits configured, allowing both the database and log files to grow without bound on the same NVMe as model weights.  
**Impact:** Unauthorized database modification (key budget elevation, rogue key insertion) is undetectable; unbounded log growth can fill the NVMe and crash pods, while long-lived logs persist any key material captured at verbose log level (M-47).  
**Fix:** Add `logging: driver: json-file options: max-size: '10m' max-file: '5'` to each docker-compose service, and schedule a periodic `sha256sum litellm.db` checksum record against a baseline to detect unexpected database modifications.

### M-64 — No Integrity Verification for Downloaded EXL2 Model Weights
**Location:** 05-inference-tabbyapi-llamaswap.md; README.md step 06 reference  
**Flagged by:** OPS-17  
**Issue:** No guidance is provided on recording or verifying the SHA-256 hashes of downloaded EXL2 model weight files; Hugging Face repositories can be modified after an initial download, and no provenance log is maintained.  
**Impact:** Adversarially modified model weights could cause systematically biased or information-leaking inference outputs for all users, and detection is difficult because a poisoned model appears functionally normal for most queries.  
**Fix:** Record the Hugging Face repository commit SHA and the SHA-256 hash of each weight file at download time, verify against uploader-published checksums where available, and maintain a provenance log with source URL, commit SHA, download date, and file hashes.

