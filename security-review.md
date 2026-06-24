# Security Review — Findings

**98 findings** — Critical: 5  High: 29  Medium: 45  Low: 16  Info: 3

---
## CRITICAL

### C-1 — Calico CNI Not Pre-Validated — All NetworkPolicies Silently Unenforced if Missing
**Location:** 16-workspaces.md §1 — MicroK8s add-ons required  
**Flagged by:** NET-2  
**Issue:** The entire network isolation model depends on Calico being the active CNI, but there is no enforcement gate — Kubernetes accepts NetworkPolicy resources regardless of whether any CNI enforces them, so a missing or crash-looping Calico results in all policies becoming no-ops with no visible error.  
**Impact:** If Calico is not correctly active, workspace pods have unrestricted access to the inference engine, LAN hosts, the management plane, and each other — a complete, silent network isolation failure.  
**Fix:** Add an automated pre-flight check in the orchestrator that confirms Calico DaemonSet pods are all Running/Ready before allowing any workspace creation, and document that Calico must be enabled and verified before any namespace is created.

### C-2 — LiteLLM Master Key and Admin Endpoints Exposed on Public api.domain.com
**Location:** 06-gateway-litellm.md §2–3; assets/litellm-config.yaml; 08-connectivity-cloudflare.md §4  
**Flagged by:** AUTH-3, INGRESS-3  
**Issue:** The Cloudflare tunnel routes api.domain.com directly to litellm:4000 with no path filtering, making /key/generate, /key/delete, /key/info, and /health reachable from the public internet protected only by LITELLM_MASTER_KEY.  
**Impact:** Any actor who obtains or brute-forces the master key gains full LiteLLM admin access from the internet: minting unlimited keys, revoking all friend keys, and reading all spend data.  
**Fix:** Block /key/*, /model/info, and /health at the Cloudflare WAF for api.domain.com, and restrict master-key operations to the Tailscale interface (localhost:4000) only; update step 06 instructions accordingly.

### C-3 — Orchestrator ClusterRole Is Effectively Cluster-Admin via Cluster-Wide Secrets CRUD
**Location:** 16-workspaces.md §5 RBAC — assets/k8s/llm-platform/orchestrator-rbac.yaml  
**Flagged by:** AUTH-5, SECRETS-12, ORCHESTRATOR-1, HOST-10  
**Issue:** The orchestrator's ClusterRole grants create/get/list/watch/patch/delete on secrets with no namespace restriction, meaning the orchestrator service account can read and modify secrets in every namespace including llm-core (LiteLLM master key, TabbyAPI key) and llm-platform (Cloudflare tunnel token, Authentik credentials).  
**Impact:** A compromised orchestrator process immediately yields every credential in the cluster, enabling full privilege escalation to all services including the inference GPU.  
**Fix:** Remove secrets (and all other namespace-scoped resources) from the ClusterRole; instead create a Role + RoleBinding in each ws-<username> namespace at provisioning time, limiting the orchestrator's secret access to workspace namespaces it created.

### C-4 — Orchestrator ClusterRole Has Cluster-Wide NetworkPolicy Write — Can Erase All Isolation
**Location:** 16-workspaces.md §5 RBAC — assets/k8s/llm-platform/orchestrator-rbac.yaml  
**Flagged by:** NET-12, AUTH-6, ORCHESTRATOR-2  
**Issue:** The orchestrator ClusterRole grants create/patch/delete on networkpolicies cluster-wide, allowing a compromised orchestrator to delete the inference-ingress policy in llm-core and the workspace-isolation policies in all ws-* namespaces.  
**Impact:** A single compromised orchestrator process can erase every network boundary in the architecture in one kubectl call, enabling workspace pods to reach the inference engine directly and allowing unrestricted lateral movement.  
**Fix:** Restrict NetworkPolicy write permission to ws-* namespaces via per-namespace RoleBindings; manage the inference-ingress policy in llm-core through a separate bootstrap process the orchestrator cannot touch.

### C-5 — Cloudflare Tunnel Token Stored in Plaintext — Compromise Grants Full Ingress Hijack
**Location:** 04-deploy-stack-ubuntu.md §2; assets/docker-compose.yml (cloudflared service); 08-connectivity-cloudflare.md §1  
**Flagged by:** INGRESS-1  
**Issue:** CF_TUNNEL_TOKEN is stored in a plaintext .env file; a leaked token lets an attacker register an additional cloudflared connector on the same tunnel and intercept or MITM all traffic across llm.domain.com, api.domain.com, and *.ws.domain.com.  
**Impact:** A stolen tunnel token enables interception of all friend traffic, capture of Cloudflare Access JWT cookies and LiteLLM API keys, and persistent re-entry with no visible indicator to the legitimate operator.  
**Fix:** Store CF_TUNNEL_TOKEN as a Docker secret (not an env var), set .env to chmod 600, enable Cloudflare tunnel connector notifications for new registrations, and rotate the token immediately on any suspected host compromise.

---
## HIGH

### H-1 — api.domain.com Has No Cloudflare Access Authentication — Edge Is Fully Bypassed
**Location:** 08-connectivity-cloudflare.md §4; assets/cloudflare-access-notes.md §3  
**Flagged by:** AUTH-1, INGRESS-2  
**Issue:** The Cloudflare Access policy for api.domain.com is set to Bypass/Everyone, so any internet client reaches LiteLLM with zero edge-level identity check; the sole gate is the LiteLLM virtual key, and the per-IP WAF rate limit is trivially circumvented with distributed sources.  
**Impact:** Attackers can freely probe all LiteLLM endpoints, brute-force virtual keys, exploit LiteLLM vulnerabilities, and enumerate models without passing any identity verification at the edge.  
**Fix:** Make Cloudflare Service Tokens the default for header-capable clients (Codex, Claude Code, Aider), issuing one token per API friend; reserve the Bypass fallback only for clients that genuinely cannot send custom headers and document it as an accepted residual risk.

### H-2 — No Default-Deny NetworkPolicy in llm-core or llm-platform Namespaces
**Location:** 16-workspaces.md §4 — Network isolation; assets/k8s/ (no default-deny policy defined)  
**Flagged by:** NET-1  
**Issue:** Targeted NetworkPolicies exist for specific pods but no baseline deny-all policy is applied to llm-core or llm-platform, leaving all intra-namespace and cross-namespace traffic unrestricted by default for any pod not explicitly covered.  
**Impact:** A newly added or compromised pod in llm-core (sidecar, debug pod, future service) can freely reach workspace pods, management services, or the host network; inference egress is completely open, enabling data exfiltration from a compromised inference process.  
**Fix:** Add a default-deny-all NetworkPolicy (ingress and egress) to llm-core and llm-platform as the first policy applied, then layer explicit allow rules on top for each required traffic flow.

### H-3 — Race Condition: Workspace Pod May Start Before NetworkPolicy Is Applied
**Location:** 16-workspaces.md §5 — Workspace launch sequence  
**Flagged by:** NET-3  
**Issue:** If the workspace-isolation NetworkPolicy is absent or deleted from a namespace when a Deployment is created, the pod starts and has unrestricted network access during the window before Calico wires up the policy to the container's network interface.  
**Impact:** Code executing at container start (e.g. a supply-chain-compromised package) can establish outbound connections to inference, LAN hosts, or a remote C2 before isolation takes effect.  
**Fix:** Have the orchestrator verify that workspace-isolation NetworkPolicy is present and matches the expected spec before creating any Deployment, and abort the launch if the policy is missing or mismatched.

### H-4 — No Ingress NetworkPolicy on the LiteLLM Pod — Any In-Cluster Pod Can Reach It
**Location:** 16-workspaces.md §4 — Network isolation; 06-gateway-litellm.md  
**Flagged by:** NET-6  
**Issue:** The inference-ingress policy restricts who can reach the inference pod, but there is no corresponding ingress policy on the litellm pod itself, so any pod with unrestricted egress (debug pod, monitoring agent, future service) can call LiteLLM on port 4000.  
**Impact:** A misconfigured or compromised pod anywhere in the cluster can call the LiteLLM API and, if the master key is known, gain full admin access to key management.  
**Fix:** Add a NetworkPolicy for the litellm pod that restricts ingress to only cloudflared, open-webui, and ws-* namespace pods on port 4000, and restricts litellm egress to only the inference pod on port 8080 and kube-dns on port 53.

### H-5 — Gateway allowedRoutes: All Allows Any Namespace to Attach HTTPRoutes — Hostname Hijack Risk
**Location:** 16-workspaces.md §3 (gateway.yaml)  
**Flagged by:** NET-7, INGRESS-4  
**Issue:** The Traefik Gateway is configured with allowedRoutes.namespaces.from: All, so any namespace — including ws-* namespaces or any future namespace — can attach an HTTPRoute claiming llm.domain.com or api.domain.com, potentially redirecting legitimate traffic to a malicious service.  
**Impact:** A compromised orchestrator or any namespace with API write access could hijack production hostnames to harvest Cloudflare Access JWTs, LiteLLM keys, and all LLM interaction data.  
**Fix:** Change the Gateway to allowedRoutes.namespaces.from: Selector restricted to llm-platform and llm-core, and use a separate Gateway instance for workspace wildcard hostnames with explicit ReferenceGrant policies.

### H-6 — Docker Bridge Network llmnet Has No Inter-Container Egress Restrictions
**Location:** assets/docker-compose.yml — networks: llmnet; 04-deploy-stack-ubuntu.md  
**Flagged by:** NET-10  
**Issue:** All four Docker services (inference, litellm, open-webui, cloudflared) share a single bridge network with no iptables or network segmentation, so any container can reach any other on any port — including cloudflared and open-webui reaching inference on port 8080, bypassing LiteLLM entirely.  
**Impact:** A compromise of open-webui or cloudflared gives direct access to the inference endpoint, bypassing all LiteLLM authentication, per-user budgets, and rate limits.  
**Fix:** Split into two Docker networks: a frontend network (cloudflared, open-webui, litellm) and a backend network (litellm, inference only), so cloudflared and open-webui have no direct path to the inference engine.

### H-7 — Workspace emptyDir /tmp Has No Size Limit — Node-Wide DoS via Disk Exhaustion
**Location:** 16-workspaces.md §6 — Workspace pod spec (volumes.tmp emptyDir: {})  
**Flagged by:** CONTAINER-1  
**Issue:** The workspace pod mounts /tmp as an emptyDir with no sizeLimit, so a workspace process can fill /tmp until the node hits its kubelet eviction threshold, starving all other pods on the node of disk space.  
**Impact:** A semi-hostile workspace user can trigger node-wide pod eviction with a trivial one-liner, taking down inference and LiteLLM for all users.  
**Fix:** Set emptyDir: { sizeLimit: "500Mi" } on the /tmp volume and add ephemeral-storage limits to the namespace LimitRange.

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

### H-10 — .env File Created Without Restrictive Permissions — All Secrets World-Readable
**Location:** 04-deploy-stack-ubuntu.md §2; assets/.env.example  
**Flagged by:** SECRETS-1  
**Issue:** The guide creates /opt/home-llm/.env containing all service credentials but never sets file permissions, leaving it at the system umask default (typically 644 — world-readable).  
**Impact:** Any local user or process with filesystem read access can extract CF_TUNNEL_TOKEN, LITELLM_MASTER_KEY, TABBY_API_KEY, and all other secrets from the .env file.  
**Fix:** Add an explicit chmod 600 /opt/home-llm/.env immediately after the cp .env.example .env step, and set the directory to chmod 750 or 700.

### H-11 — No .gitignore for .env — Risk of Accidental Secret Commit
**Location:** 04-deploy-stack-ubuntu.md §2; assets/.env.example  
**Flagged by:** SECRETS-3  
**Issue:** The guide warns against committing .env but never instructs users to add it to a .gitignore in /opt/home-llm, so initialising a git repo for config management will include the .env by default.  
**Impact:** If the directory is pushed to any remote, all secrets are permanently embedded in git history and cannot be removed without history rewriting.  
**Fix:** Add a step creating /opt/home-llm/.gitignore containing .env immediately after the directory is staged, and note that git history scrubbing is required if a .env is ever accidentally committed.

### H-12 — LITELLM_MASTER_KEY and LITELLM_SALT_KEY Exposed via docker inspect
**Location:** assets/docker-compose.yml (litellm service environment: section)  
**Flagged by:** SECRETS-7  
**Issue:** Both keys are passed as Docker environment variables, making them readable by any user in the docker group via docker inspect litellm.  
**Impact:** Any docker-group member can extract the master key for full LiteLLM admin control and the salt key to perform offline brute-forcing of hashed virtual keys from the database.  
**Fix:** Pass LITELLM_MASTER_KEY and LITELLM_SALT_KEY via Docker secrets or a mounted file with mode 400, not environment variables.

### H-13 — LITELLM_SALT_KEY Rotation Is Destructive and Undocumented
**Location:** 14-operations.md §Key & access hygiene; assets/.env.example  
**Flagged by:** SECRETS-10  
**Issue:** LITELLM_SALT_KEY is used to hash all virtual keys in the database; rotating it silently invalidates every existing virtual key, but this destructive behavior is not documented anywhere in the operations guide.  
**Impact:** An operator who rotates the salt key expecting normal key rotation will simultaneously break access for all friends, with no documented recovery procedure; conversely, a leaked salt key enables offline brute-forcing of virtual keys from the database.  
**Fix:** Add a prominent warning in step 14 and in .env.example that LITELLM_SALT_KEY must never be rotated without first re-issuing all virtual keys, and document the full re-issuance procedure.

### H-14 — Kubernetes Secrets Not Encrypted at Rest in etcd (MicroK8s Default)
**Location:** 16-workspaces.md §5–§6 (orchestrator and workspace pod spec)  
**Flagged by:** SECRETS-11  
**Issue:** MicroK8s does not enable etcd encryption at rest by default, so per-workspace LiteLLM keys stored as Kubernetes Secrets are base64-encoded plaintext on disk and readable by any process with direct etcd or filesystem access.  
**Impact:** Physical access to the host or access to the etcd data directory exposes all workspace LiteLLM keys in plaintext; the orchestrator's cluster-wide secret read permission (see C-3) makes this a single-API-call exfiltration from any compromised process.  
**Fix:** Enable Kubernetes EncryptionConfiguration (AES-GCM or secretbox) on the MicroK8s kube-apiserver, then re-encrypt existing secrets by piping them back through kubectl replace.

### H-15 — Authentik Admin Credentials and Secret Key Have No Documented Setup or Hardening
**Location:** 15-identity-sso.md §Setup outline  
**Flagged by:** SECRETS-15  
**Issue:** Step 15 deploys Authentik but provides no guidance on generating AUTHENTIK_SECRET_KEY, setting a strong postgres password, disabling the default akadmin account, or restricting the Authentik admin UI to Tailscale.  
**Impact:** A default or weakly configured Authentik instance is the single point of failure for all SSO; compromising it allows adding an attacker to any group, modifying OIDC applications, and breaking all identity-based access controls.  
**Fix:** Add explicit steps to generate AUTHENTIK_SECRET_KEY with openssl rand -hex 32, set a strong postgres password, disable akadmin after creating a named admin, enforce MFA on the admin account, and expose the admin UI only over Tailscale.

### H-16 — SSH Not Hardened and Root SSH Access Normalized in Tailscale ACL
**Location:** 09-connectivity-tailscale.md §4; 02-host-os-ubuntu.md; assets/tailscale-acl.json lines 22–27  
**Flagged by:** HOST-1, HOST-4  
**Issue:** The guide presents SSH hardening (key-only auth, PermitRootLogin no, ListenAddress binding) as advisory rather than mandatory, and the Tailscale ACL explicitly lists root as a permitted SSH user, normalizing direct root access.  
**Impact:** SSH remaining on 0.0.0.0 exposes it to LAN brute-force, and permitting root login means a successful credential attack yields immediate full host compromise with no privilege escalation step needed.  
**Fix:** Make SSH hardening mandatory in step 02 (PermitRootLogin no, PasswordAuthentication no, ListenAddress <tailscale-ip>), and remove root from the Tailscale SSH ACL users list, relying solely on sudo for privileged operations.

### H-17 — No Host Firewall (UFW) Configured — All Host Ports Unrestricted on LAN
**Location:** 02-host-os-ubuntu.md; 09-connectivity-tailscale.md §5  
**Flagged by:** HOST-2  
**Issue:** UFW ships inactive on Ubuntu Server 24.04 and the guide never enables it, leaving all host ports and any accidentally LAN-bound services reachable from the local network with no OS-level defence.  
**Impact:** Any service that binds to a non-loopback address — including MicroK8s NodePorts, Docker published ports, or misconfigured future containers — is immediately accessible from the LAN without authentication.  
**Fix:** Add a mandatory UFW setup step in step 02 (ufw default deny incoming, allow on Tailscale interface, enable), and document that Docker's iptables rules bypass UFW for published ports, requiring daemon.json iptables: false plus explicit nftables rules for fine-grained control.

### H-18 — No Automatic Security Patching Configured on a 24/7 Internet-Facing Server
**Location:** 02-host-os-ubuntu.md; 14-operations.md  
**Flagged by:** HOST-3  
**Issue:** The guide performs a one-time apt upgrade at setup and mentions manual upgrades in operations, but never installs or configures unattended-upgrades for a server that runs continuously with a public-facing Cloudflare tunnel.  
**Impact:** Known CVEs in OpenSSH, the Linux kernel, or glibc accumulate between manual upgrade runs, leaving the host exploitable during the disclosure-to-patch window.  
**Fix:** Add a mandatory step in step 02 to install and configure unattended-upgrades for security updates, with automatic reboots on kernel updates during a low-traffic maintenance window.

### H-19 — MicroK8s API Server Binds to All Interfaces by Default — LAN-Exposed
**Location:** 16-workspaces.md §1–2; 04-deploy-stack-ubuntu.md  
**Flagged by:** HOST-7  
**Issue:** MicroK8s binds the kube-apiserver to 0.0.0.0:16443 by default, and no step restricts it to the Tailscale interface; combined with the absent host firewall (H-17), the k8s API server is reachable from the LAN.  
**Impact:** LAN-accessible kube-apiserver enables credential enumeration and, if any service account token leaks via a workspace pod breakout, it can be replayed from any LAN host to gain cluster-level access.  
**Fix:** Add a step to set --bind-address=<tailscale-ip> in /var/snap/microk8s/current/args/kube-apiserver and restart MicroK8s, then verify with ss -tlnp | grep 16443; pair with a UFW rule blocking port 16443 from LAN interfaces.

### H-20 — Docker Group Membership Is Effective Root — Unprivileged Escalation Path
**Location:** 02-host-os-ubuntu.md §4  
**Flagged by:** HOST-12  
**Issue:** Step 02 adds the primary user to the docker group, which is equivalent to passwordless root because docker run -v /:/host mounts the entire host filesystem without any further privilege check.  
**Impact:** Any code execution as the server user — via SSH, a kubeconfig leak, or a compromised container exec — can trivially escalate to root, and the systemd service unit running as that user has the same implicit capability.  
**Fix:** Evaluate Docker rootless mode for the inference stack (compatible with recent NVIDIA Container Toolkit), or create a dedicated llm-svc service account for the systemd unit and never add the interactive admin user to the docker group.

### H-21 — Namespace Naming Collision: Crafted Username Can Target Existing Namespaces
**Location:** 16-workspaces.md §5 — Orchestrator namespace creation logic  
**Flagged by:** ORCHESTRATOR-3  
**Issue:** The orchestrator creates namespaces as ws-<preferred_username> with no username validation or blocklist; an Authentik account named llm-core would cause the orchestrator to attempt to create or deploy resources into ws-llm-core, which could collide with or shadow existing infrastructure namespaces.  
**Impact:** A workspace Deployment landed in a wrong namespace inherits that namespace's NetworkPolicy posture rather than workspace-isolation, potentially allowing direct inference access; malformed namespace names can also corrupt orchestrator state.  
**Fix:** Enforce a strict username regex allowlist (e.g. ^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$), maintain a blocklist of reserved prefixes (kube, llm, default), and verify before resource creation that the target namespace carries the managed-by: workspace-orchestrator label.

### H-22 — Workspace Activity API Controlled by the Workspace Pod — Idle TTL Spoofable
**Location:** 16-workspaces.md §5 — Idle TTL polling  
**Flagged by:** ORCHESTRATOR-4  
**Issue:** The orchestrator polls the workspace pod's own HTTP activity endpoint to decide when to scale to zero; a workspace user can trivially serve a fake 'active' response to prevent auto-shutdown indefinitely.  
**Impact:** Users monopolise CPU, memory, and LiteLLM budget allocation indefinitely, starving other users and increasing inference costs with no server-enforced limit.  
**Fix:** Use Kubernetes metrics-server CPU/memory as the primary idle signal (a truly idle container shows near-zero CPU regardless of HTTP responses) and enforce an absolute maximum workspace lifetime independent of activity.

### H-23 — LiteLLM Key Revocation on Workspace Destroy Is Not Atomic — Orphaned Keys Persist
**Location:** 16-workspaces.md §5 — Destroy flow  
**Flagged by:** ORCHESTRATOR-5  
**Issue:** The destroy sequence deletes the Kubernetes Secret before revoking the LiteLLM key; if the orchestrator crashes or the revocation call fails after the Secret is deleted, the key value is irrecoverably lost from Kubernetes but remains valid in LiteLLM's database.  
**Impact:** A user who exfiltrated their workspace key retains full LiteLLM API access with the original budget after workspace destruction, with no audit trail linking orphaned keys to former workspaces.  
**Fix:** Reverse the destroy order to revoke the LiteLLM key first (verify via /key/info returning 404) before deleting the Kubernetes Secret, and store the key alias in the orchestrator database independently so revocation can be retried even if the Secret is gone.

### H-24 — Workspace Resources Keyed on Mutable preferred_username — Identity Confusion on Rename
**Location:** 16-workspaces.md §5 and §6 — PVC persistence; 15-identity-sso.md — OIDC login flow  
**Flagged by:** ORCHESTRATOR-6, ORCHESTRATOR-7  
**Issue:** The orchestrator derives namespace names, PVC names, and all workspace resources from the OIDC preferred_username claim, which is admin-editable in Authentik; renaming a user or recycling a username routes the new account to the previous user's namespace and home PVC.  
**Impact:** A username recycle grants the new user access to the previous user's persistent data, shell history, cached credentials, and any secrets written to the home directory; a compromised Authentik admin can re-route any user's workspace.  
**Fix:** Use the immutable OIDC sub claim as the internal primary key for all orchestrator records and Kubernetes resource names, displaying preferred_username only in the UI.

### H-25 — Orchestrator ClusterRole Grants Namespace Delete Cluster-Wide — Can Destroy llm-core or kube-system
**Location:** 16-workspaces.md §5 RBAC — assets/k8s/llm-platform/orchestrator-rbac.yaml  
**Flagged by:** ORCHESTRATOR-14  
**Issue:** The orchestrator ClusterRole grants delete on namespaces with no restriction, meaning a compromised orchestrator or an injection attack through its API can delete llm-core, llm-platform, or kube-system.  
**Impact:** Deleting kube-system would be catastrophic and potentially unrecoverable; deleting llm-core destroys the LiteLLM and inference pods, causing a full service outage.  
**Fix:** Add a ValidatingAdmissionWebhook (OPA/Gatekeeper) that rejects deletion of any namespace not matching ws-* or not labelled managed-by: workspace-orchestrator, effectively making protected namespaces immutable from the orchestrator's perspective.

### H-26 — cloudflared Is Single Point of Failure with Broad Internal Network Access
**Location:** README.md (service map); assets/docker-compose.yml (cloudflared service); 16-workspaces.md §9  
**Flagged by:** INGRESS-5  
**Issue:** The single cloudflared process fronts all three public hostnames and in the Docker deployment shares llmnet with inference, litellm, open-webui, and authentik, so a container escape gives direct unauthenticated access to every internal service.  
**Impact:** Compromising cloudflared yields full read/write access to all internal services: Open WebUI accounts and chat history, LiteLLM key management, Authentik admin, workspace pods, and the tunnel token for persistent external re-entry.  
**Fix:** In Docker, move cloudflared to a restricted network with only the services it needs to proxy; in MicroK8s, apply an egress NetworkPolicy limiting cloudflared to traefik:80 only, and run cloudflared as a non-root user with a read-only filesystem.

### H-27 — Update Process Performs No Digest Verification Before Deployment
**Location:** 14-operations.md — Updates section  
**Flagged by:** OPS-3  
**Issue:** Step 14 instructs docker compose pull && docker compose up -d with no guidance to verify image digests, compare against a known-good baseline, or perform any staging before deploying to production.  
**Impact:** Combined with floating mutable tags (H-8, H-9), the update process automatically deploys any content served under the configured tag with no human review of what changed, giving a supply chain attacker guaranteed production deployment.  
**Fix:** Record and compare image digests before and after pulling (docker inspect --format='{{index .RepoDigests 0}}'), keep the previous image tagged for rollback, and review changelogs before applying updates.

### H-28 — Backup Archives Written Unencrypted with No Access Controls or Retention Policy
**Location:** 14-operations.md — Backups section  
**Flagged by:** OPS-4  
**Issue:** Backup commands write plaintext .tgz archives of Open WebUI user data and the LiteLLM database to /srv/backups with no documented directory permissions, no encryption, no offsite copy, and no retention limit.  
**Impact:** Physical access or any process with filesystem read access exposes the entire user roster, password hashes, chat history, and API key database in plaintext; unbounded archive growth can also exhaust the model NVMe and crash containers.  
**Fix:** Encrypt backups using restic or GPG before writing to disk, set chmod 700 /srv/backups owned by root, add a cron retention step removing archives older than 30 days, and document an offsite encrypted backup target.

### H-29 — Monitoring Is Manual Log Inspection Only — No Alerting or Anomaly Detection
**Location:** 14-operations.md — Monitoring section  
**Flagged by:** OPS-5  
**Issue:** The entire monitoring strategy is four manual docker logs commands and nvidia-smi, with no log aggregation, no persistent storage, and no automated alerting for credential abuse, container anomalies, or authentication failures.  
**Impact:** Attackers with any foothold have extended undetected dwell time; low-volume credential stuffing, data exfiltration from workspace pods, and Authentik brute-force are all completely invisible without manual log inspection.  
**Fix:** Deploy lightweight log aggregation (Loki + Grafana or equivalent) and configure alerts for LiteLLM 401 rate spikes, unexpected container starts, Authentik failed-auth spikes, and workspace pod egress volume anomalies; retain logs for at least 90 days.

---
## MEDIUM

### M-1 — DNS Egress Rule Allows Port 53 to All Namespaces, Not Just kube-dns
**Location:** 16-workspaces.md §4a — workspace-isolation NetworkPolicy, kube-dns egress rule  
**Flagged by:** NET-4, CONTAINER-12, ORCHESTRATOR-11  
**Issue:** The DNS egress rule uses `namespaceSelector: {}` (matches all namespaces) with no podSelector, allowing workspace pods to reach any pod in any namespace on port 53 UDP/TCP, not only the kube-dns pods in kube-system.  
**Impact:** Workspace pods can use port 53 TCP for DNS tunneling to any pod listening on that port in any namespace, enabling covert data exfiltration or lateral movement via a rogue DNS listener in another ws-* namespace.  
**Fix:** Tighten the rule to `namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}` combined with `podSelector: {matchLabels: {k8s-app: kube-dns}}` so only actual kube-dns pods are reachable on port 53.

### M-2 — Workspace Egress ipBlock Exception List Misses Link-Local and RFC 6598 Ranges
**Location:** 16-workspaces.md §4a — workspace-isolation NetworkPolicy, egress ipBlock except list  
**Flagged by:** NET-5, NET-9, NET-16, AUTH-16  
**Issue:** The egress exception list covers 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, and 100.64.0.0/10, but omits 169.254.0.0/16 (link-local / cloud IMDS), 127.0.0.0/8 (loopback), and 100.0.0.0/10 (lower RFC 6598 CGNAT range); cross-workspace isolation also relies on MicroK8s pod CIDRs falling within the RFC1918 blocks, which is unverified.  
**Impact:** Workspace pods can reach link-local addresses (critical if the host is ever migrated to a cloud VM where 169.254.169.254 is the IMDS credential endpoint), ISP CGNAT infrastructure in 100.0.0.0/10, and potentially each other if the MicroK8s pod CIDR falls outside the excepted ranges.  
**Fix:** Add 169.254.0.0/16, 127.0.0.0/8, and 100.0.0.0/10 to the except list, verify the MicroK8s pod and service CIDRs with `microk8s kubectl cluster-info dump | grep -E 'podCIDR|serviceClusterIP'`, and add those ranges explicitly regardless of RFC1918 overlap.

### M-3 — Inference Pod Has No Egress NetworkPolicy — Full Outbound Access from GPU Process
**Location:** 16-workspaces.md §4b — Inference ingress lock; assets/docker-compose.yml  
**Flagged by:** NET-8  
**Issue:** Only an ingress NetworkPolicy is defined for the inference pod; no egress policy exists, giving the inference process (TabbyAPI / llama-swap) unrestricted outbound access to the LAN, internet, and all other pods.  
**Impact:** A compromised inference process — via malicious model weights, a TabbyAPI/ExLlamaV2 vulnerability, or a supply-chain attack — can exfiltrate user prompts, API keys visible in the environment, or establish a reverse shell to an external C2.  
**Fix:** Apply an egress NetworkPolicy to the inference pod restricting outbound to kube-dns port 53 only, and in the Docker phase add iptables rules preventing the inference container from reaching anything beyond its legitimate callers on llmnet.

### M-4 — api.domain.com Has Cloudflare Access Bypass with Only IP-Based Rate Limiting
**Location:** 08-connectivity-cloudflare.md §4; assets/cloudflare-access-notes.md §3–4  
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
**Location:** 06-gateway-litellm.md §2; 07-webui-open-webui.md  
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

### M-11 — Removing User from grp-api in Authentik Does Not Revoke Their LiteLLM Virtual Key
**Location:** 15-identity-sso.md; 06-gateway-litellm.md  
**Flagged by:** AUTH-8  
**Issue:** LiteLLM virtual keys are minted manually and are not session-bound; removing a user from grp-api in Authentik does not trigger any key revocation in LiteLLM, so the user retains valid API access indefinitely.  
**Impact:** A departing friend whose Authentik account is removed can continue making API calls and consuming GPU budget until an admin manually calls `/key/delete`, contradicting the documented claim that group removal 'revokes access everywhere on next auth'.  
**Fix:** Document that offboarding requires both Authentik group removal and explicit LiteLLM `/key/delete`, and implement a webhook or scheduled script that calls `/key/delete` when a user is removed from grp-api or deleted from Authentik.

### M-12 — Open WebUI OIDC SSO Is Optional — Authentik Removal Does Not Disable WebUI Account
**Location:** 15-identity-sso.md §Setup outline step 5; 07-webui-open-webui.md; 08-connectivity-cloudflare.md §3  
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
**Location:** 08-connectivity-cloudflare.md §3; assets/cloudflare-access-notes.md §2  
**Flagged by:** AUTH-14  
**Issue:** The Cloudflare Access session is configured for 24 hours, so a user removed from the allowlist retains an active browser session for up to a full day.  
**Impact:** Combined with the lack of mandatory Open WebUI OIDC SSO (M-12), a departing user may retain UI access for the maximum session window, especially dangerous if revocation is urgent.  
**Fix:** Reduce the CF Access session duration to 4–8 hours and use Cloudflare's session revocation feature (Zero Trust > Access > Revoke User Sessions) as the first step in any offboarding procedure.

---
## MEDIUM

### M-17 — Tailscale SSH ACL Permits Direct Root Login from Any Admin Device
**Location:** assets/tailscale-acl.json  
**Flagged by:** AUTH-15  
**Issue:** The Tailscale SSH ACL allows autogroup:admin to SSH to the server as `root`, meaning a stolen or malware-infected admin device immediately yields a root shell on the LLM server without requiring any additional credential.  
**Impact:** Full host compromise — all services, secrets, model weights, and user data — collapses to the question of whether a personal admin device is uncompromised.  
**Fix:** Remove `root` from the Tailscale SSH allowed users, require sudo escalation from a non-root account for all administrative actions, and enable Tailscale device posture checks to gate enrollment of admin devices.

### M-18 — Wildcard Workspace Tunnel Route Combined with Non-Unique IDs Risks Hostname Collision and Session Confusion
**Location:** 16-workspaces.md §9; 08-connectivity-cloudflare.md §2  
**Flagged by:** NET-18, INGRESS-6  
**Issue:** The *.ws.domain.com wildcard tunnel route hands all workspace routing to Traefik, and workspace IDs are username-derived rather than cryptographically random, creating a risk of hostname collision if a username is recycled or an ID is reused for a different user.  
**Impact:** A user whose workspace was destroyed and whose ID is reassigned to a new user could — via cached bookmarks or IDE settings — reach the wrong workspace pod; a Traefik routing bug on the wildcard amplifies this into cross-user session access.  
**Fix:** Use UUID4 workspace IDs, enforce global uniqueness in the orchestrator with a persistent ID registry, implement exact-match HTTPRoutes per workspace, and configure Traefik to return 404 for *.ws.domain.com hostnames with no matching HTTPRoute.

---
## LOW

### M-19 — SSH ListenAddress Restriction Is Documented as Optional with No Mandatory Verification Step
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

### M-29 — Workspace Base Dockerfile Installs Unpinned pip Packages as Root
**Location:** assets/workspace-base/Dockerfile lines 7–18; assets/workspace-base/Dockerfile line 3  
**Flagged by:** CONTAINER-14, HOST-22, OPS-11, ORCHESTRATOR-10  
**Issue:** The workspace Dockerfile installs `pip3 install --no-cache-dir aider-chat` (unpinned) as root before switching to the coder user, using a floating `codercom/code-server:latest` base image with no digest pin.  
**Impact:** A compromised aider-chat release or malicious transitive PyPI dependency executes as root during image build and can persist a backdoor (SUID binary, modified entrypoint) that survives the USER coder switch and affects every workspace launched from that image.  
**Fix:** Pin `codercom/code-server` to a specific SHA-256 digest, pin `aider-chat` to a specific version, generate a `requirements.txt` with `pip-compile --generate-hashes`, and use `pip install --require-hashes` to verify all transitive dependencies.

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
**Fix:** Add rotation procedures for all three keys to step 14 (LITELLM_SALT_KEY rotation requires coordinated key reissuance to all users), schedule quarterly rotation for the master key, and document CF_TUNNEL_TOKEN rotation via the Cloudflare dashboard.

### M-47 — LiteLLM Verbose Logging May Write API Keys to Docker Log Files Readable by docker Group
**Location:** 14-operations.md Monitoring; assets/litellm-config.yaml line 23  
**Flagged by:** OPS-6, SECRETS-16  
**Issue:** `set_verbose: false` is commented out in litellm-config.yaml; at verbose log levels LiteLLM logs request headers including bearer tokens, and Docker log files are accessible to any user in the docker group.  
**Impact:** API keys from every request — including accidentally misdirected third-party credentials — may persist indefinitely in /var/lib/docker/containers/ in plaintext and be readable without elevated privileges.  
**Fix:** Explicitly set `set_verbose: false` in litellm-config.yaml, add `LITELLM_LOG=ERROR` to the environment, and configure Docker log rotation (`max-size: 10m, max-file: 3`) for the litellm service.

### M-48 — NVIDIA Container Toolkit Installed Without Version Pinning or GPG Fingerprint Verification
**Location:** 02-host-os-ubuntu.md §5  
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
**Location:** 08-connectivity-cloudflare.md §3; 15-identity-sso.md §3  
**Flagged by:** INGRESS-9  
**Issue:** A Cloudflare Access JWT issued for one ws-* subdomain under the wildcard *.ws.domain.com application may be accepted for any other subdomain in the same wildcard application; a compromised workspace running JavaScript in the code-server context can read and exfiltrate this cookie.  
**Impact:** A stolen CF Access JWT from one workspace could grant access to another workspace subdomain belonging to the same or a different user, valid for up to the configured 24-hour session duration.  
**Fix:** Verify Cloudflare Access's cookie scoping behavior for wildcard applications, shorten workspace application session duration to 1–2 hours, and make per-session code-server `--auth password` mandatory (M-13) so that a stolen CF cookie still cannot reach the IDE without the per-session password.

### M-57 — Docker Group Membership Grants Effective Root Without Acknowledgment in the Guide
**Location:** 02-host-os-ubuntu.md §4; 04-deploy-stack-ubuntu.md §6  
**Flagged by:** OPS-12  
**Issue:** Step 02 adds the operator's account to the `docker` group for convenience, but docker group membership is equivalent to passwordless root (any member can mount the host filesystem via a container) and this is not acknowledged anywhere in the guide.  
**Impact:** Any compromise of the operator's interactive shell session — SSH session hijack, malicious script, CI pipeline — immediately yields host root access via the Docker socket without any additional exploitation step.  
**Fix:** Document explicitly that docker group membership equals effective root, consider running the systemd unit as root rather than a user account that also has interactive SSH access, and evaluate rootless Docker for the inference workload.

---
## INFO

### M-58 — LiteLLM /health and /v1/models Endpoints Publicly Accessible — Software and Model Enumeration
**Location:** 06-gateway-litellm.md §1; 08-connectivity-cloudflare.md §4  
**Flagged by:** AUTH-17, INGRESS-14  
**Issue:** The /health and /v1/models endpoints on api.domain.com are unauthenticated and publicly accessible (CF Access is bypassed), disclosing that LiteLLM is the gateway, its version, and the full list of configured model names.  
**Impact:** Version disclosure enables targeted exploitation of known LiteLLM CVEs; model enumeration reveals the full inference stack to an attacker conducting reconnaissance before attempting key brute-force or API abuse.  
**Fix:** Add Cloudflare WAF rules blocking /health and /v1/models for unauthenticated requests, or restrict these paths to Tailscale-only access via LiteLLM's `allowed_ips` feature.

---
## LOW

### M-59 — Orchestrator Has No Audit Logging for Workspace Lifecycle and Key Minting Events
**Location:** 14-operations.md; 16-workspaces.md  
**Flagged by:** ORCHESTRATOR-17  
**Issue:** The operations guide describes monitoring for inference and LiteLLM logs but documents no structured audit logging for orchestrator actions (workspace launches, key mints, namespace creation/deletion, failed attempts) or Kubernetes API server audit logs for the orchestrator SA.  
**Impact:** Abuse — excessive workspace launches, namespace collision attempts, reconnaissance via failed API calls — and orchestrator compromise are undetectable and unscoped post-incident without a log trail.  
**Fix:** Enable Kubernetes API server audit logging at Metadata level for all orchestrator SA requests and Request level for secrets/namespace operations; implement structured application logging in the orchestrator for every lifecycle event and forward to an immutable host-level log sink.

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
**Location:** 05-inference-tabbyapi-llamaswap.md; README.md step 10 reference  
**Flagged by:** OPS-17  
**Issue:** No guidance is provided on recording or verifying the SHA-256 hashes of downloaded EXL2 model weight files; Hugging Face repositories can be modified after an initial download, and no provenance log is maintained.  
**Impact:** Adversarially modified model weights could cause systematically biased or information-leaking inference outputs for all users, and detection is difficult because a poisoned model appears functionally normal for most queries.  
**Fix:** Record the Hugging Face repository commit SHA and the SHA-256 hash of each weight file at download time, verify against uploader-published checksums where available, and maintain a provenance log with source URL, commit SHA, download date, and file hashes.

