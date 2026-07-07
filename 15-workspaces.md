# 15 — On-demand workspaces (3rd client type)

← [14 Identity & SSO](14-identity-sso.md) · [Back to README](README.md)

> **Overview:** Install MicroK8s, write the workspace orchestrator (an OIDC-authenticated API that provisions isolated Kubernetes pods per user), configure namespace isolation with NetworkPolicy and RBAC, and expose workspaces via Cloudflare Tunnel and Access.
>
> **Why:** Each workspace is a fully isolated Linux dev environment. Namespace RBAC, NetworkPolicy, and per-workspace LiteLLM keys ensure one user's workspace cannot reach another's data, the host's service plane, or the LAN.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<tailscale-ip>` | Server's Tailscale IPv4 address | `tailscale ip -4` (from step 08) |
> | `<domain.com>` | Your registered domain | From step 09 |

The 3rd client type: the host spins up **on-demand Linux dev environments**
(hardened pods) that users reach **from anywhere** via a browser IDE, with
**LiteLLM access baked in**. Decision **D12**: a **custom orchestrator** managing
**hardened MicroK8s pods**, browser IDE (code-server).

> ⚠️ A workspace is **arbitrary code execution by design**, with network reach to
> LiteLLM. Treat every workspace as semi-hostile: isolate it from the LAN, the
> management plane, and other workspaces. The NetworkPolicy specs below are
> mandatory, not optional hardening. If trust ever drops below "trusted friend",
> the upgrade path is microVMs (Kata/Firecracker) with the same orchestrator.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  EXTERNAL                                                                    │
│  Workspace user ──► ws-<id>.ws.domain.com                                   │
│                      └ CF Access (OIDC → Authentik) ──► CF Tunnel           │
└──────────────────────────────────────────────────────────────────┬──────────┘
                                                                   │
┌──────────────────────────────────────────────────────────────────▼──────────┐
│  ns: llm-platform                                                            │
│                                                                              │
│  cloudflared ──► Traefik (Gateway API)                                       │
│                   Gateway: main-gateway                                       │
│                   HTTPRoute: *.ws.domain.com ────────────────────────────►  │
└──────────────────────────────────────────────────────────────────┬──────────┘
                                                                   │
┌──────────────────────────────────────────────────────────────────▼──────────┐
│  ns: ws-<sub>   (one per user, keyed on immutable OIDC sub UUID)             │
│  ResourceQuota · LimitRange · NetworkPolicy                                  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  workspace pod (code-server)                                          │  │
│  │  env: OPENAI_API_BASE=http://litellm.llm-core.svc.cluster.local:4000 │  │
│  │       OPENAI_API_KEY=<scoped key minted by orchestrator at launch>    │  │
│  │  PVC: home-<sub> → /home/user   (persists across restarts)           │  │
│  │  emptyDir → /tmp                                                      │  │
│  │  securityContext: runAsNonRoot, readOnlyRootFilesystem,               │  │
│  │                   allowPrivilegeEscalation:false, drop:ALL            │  │
│  └────────────────────────────────────┬──────────────────────────────────┘  │
│                                       │                                      │
│  NetworkPolicy egress:                │ in-cluster, no public internet hop   │
│    ✅ llm-core/litellm :4000  ◄───────┘ (auth + budget enforced by LiteLLM) │
│    ✅ 0.0.0.0/0 except RFC1918 + Tailscale  (pip / npm / git)               │
│    ✅ kube-dns :53                                                           │
│    ❌ llm-core/inference :8080  (structurally blocked at network layer)      │
│    ❌ llm-platform (management plane)                                        │
└──────────────────────────────────────────────────────────────────┬──────────┘
                                                                   │ port 4000 only
┌──────────────────────────────────────────────────────────────────▼──────────┐
│  ns: llm-core                                                                │
│                                                                              │
│  litellm  ◄── all ws-* traffic (virtual-key auth · budgets · rate limits)   │
│     │                                                                        │
│     │  NetworkPolicy: litellm pods in llm-core → inference ALLOWED          │
│     │                 ws-* → inference DENIED (inference ingress policy)     │
│     ▼                                                                        │
│  inference (TabbyAPI + llama-swap)                                           │
│    resources: nvidia.com/gpu: 1                                              │
│    hostPath: /srv/models → /models                                           │
│    ConfigMap: llama-swap-config.yaml                                         │
└─────────────────────────────────────────────────────────────────────────────┘

  Orchestrator (ns: llm-platform)
    OIDC login via Authentik · reads group claims for RBAC + quota tier
    k8s API (ClusterRole) → creates ns, ResourceQuota, NetworkPolicy,
                             Deployment, Service, HTTPRoute, PVC
    mints scoped LiteLLM key on launch · revokes on destroy
    idle TTL auto-stop · manual stop/start · destroy (keep home PVC)
    admin-only: Tailscale + grp-admin · NO Docker socket
```

---

## 1. Prerequisites

This step assumes the cluster and core stack from
[step 04](04-deploy-stack-ubuntu.md) are already running — MicroK8s plus its
add-ons (Calico, GPU, hostpath-storage, Helm, registry), Secrets encryption at
rest, Traefik with the `core-gateway`, and the `llm-core` / `llm-platform`
namespaces with their default-deny baselines and core NetworkPolicies. It also
assumes Authentik is deployed and hardened per [step 14](14-identity-sso.md).

This step adds only the workspace-specific pieces: per-user `ws-<sub>`
namespaces, the workspace Gateway, per-workspace isolation, and the orchestrator.

---

## 2. Workspace namespaces

The permanent namespaces (`llm-core`, `llm-platform`) and their labels are created
in [step 04 §3](04-deploy-stack-ubuntu.md). Workspace namespaces (`ws-<sub>`) are
created dynamically by the orchestrator at first provisioning (§5). The
orchestrator applies two labels at namespace creation time:

```bash
# Applied by orchestrator — never applied manually to permanent namespaces
microk8s kubectl label namespace ws-<sub> kubernetes.io/metadata.name=ws-<sub>
microk8s kubectl label namespace ws-<sub> workspace=true
```

The `workspace=true` label is the namespaceSelector anchor used by the
`litellm-policy` (step 04) to allow workspace pods to call LiteLLM, and by the
`traefik-policy` (step 04) to allow Traefik to route to workspace Services. Every
ws-* namespace must carry this label before any pod is created in it.

---

## 3. Workspace Gateway

Traefik and the `core-gateway` are installed in
[step 04 §7](04-deploy-stack-ubuntu.md). Add the **workspace-gateway** for the
wildcard workspace subdomains. It accepts routes only from `llm-platform`, where
the orchestrator creates one HTTPRoute per workspace at launch (§5) — never from
`ws-*` namespaces directly.

```bash
# assets/k8s/llm-platform/workspace-gateway.yaml — replace domain.com first
microk8s kubectl apply -f assets/k8s/llm-platform/workspace-gateway.yaml
```

---

## 4. Network isolation

### 4a. Workspace egress + ingress policy

The orchestrator applies this to every `ws-<sub>` namespace it creates.
Workspaces reach LiteLLM in-cluster on port 4000; all other RFC1918 and
cluster-internal addresses are denied. General internet egress is allowed for
package managers and git.

```yaml
# Applied by orchestrator to each ws-* namespace
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: workspace-isolation
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress:
  # Only Traefik (in llm-platform) may reach workspace pods
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-platform
      podSelector:
        matchLabels:
          app.kubernetes.io/name: traefik
  egress:
  # In-cluster LiteLLM — enforcement point for auth, budgets, rate limits
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-core
      podSelector:
        matchLabels:
          app: litellm
    ports:
    - port: 4000
      protocol: TCP
  # Public internet (pip, npm, git, package registries)
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
        - 10.0.0.0/8
        - 172.16.0.0/12
        - 192.168.0.0/16
        - 100.64.0.0/10     # Tailscale CGNAT range
  # kube-dns — scoped to kube-dns pods only, not all namespaces (M-1)
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

### 4b. Core-plane policies (applied in earlier steps)

The default-deny baselines for `llm-core` and `llm-platform`, and the explicit
allow policies for `inference`, `litellm`, `open-webui`, `cloudflared`, and
`traefik`, are all applied in [step 04 §8](04-deploy-stack-ubuntu.md) — their
`workspace=true` clauses already anticipate the namespaces this step creates. The
Authentik policies are applied in [step 14](14-identity-sso.md) from
`assets/k8s/llm-platform/authentik-networkpolicies.yaml`.

The only network policy this step introduces is the per-workspace
`workspace-isolation` policy (§4a), which the orchestrator applies to every
`ws-<sub>` namespace it creates.

---

## 5. Orchestrator

### RBAC

The orchestrator uses a **two-tier** permission model. A ClusterRole covers
only the resources that are genuinely cluster-scoped (namespaces, nodes,
PersistentVolumes). All namespace-scoped operations — including secrets and
NetworkPolicies — are granted exclusively inside each `ws-*` namespace via a
per-namespace Role that the orchestrator bootstraps at first login.

This prevents a compromised orchestrator from reading credentials in
`llm-core` or `llm-platform`, and from erasing NetworkPolicies outside the
workspaces it manages (C-3, C-4).

```yaml
# assets/k8s/llm-platform/orchestrator-rbac.yaml

# Tier 1: ClusterRole — cluster-scoped resources only
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: orchestrator-cluster
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["create", "get", "list", "watch", "patch", "delete"]
- apiGroups: [""]
  resources: ["nodes"]
  verbs: ["get", "list", "watch"]
- apiGroups: [""]
  resources: ["persistentvolumes"]
  verbs: ["get", "list", "watch"]
# Read-only cluster-wide for the consumption/availability dashboard
- apiGroups: [""]
  resources: ["resourcequotas", "pods"]
  verbs: ["get", "list", "watch"]
# Required to bootstrap orchestrator-ws Role+RoleBinding into each new ws-* namespace.
# rolebindings:create is cluster-wide in RBAC; Kubernetes's built-in privilege
# escalation prevention prevents the orchestrator from binding to any role that
# grants permissions it does not already hold, limiting the practical blast radius.
- apiGroups: ["rbac.authorization.k8s.io"]
  resources: ["roles", "rolebindings"]
  verbs: ["create", "get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: orchestrator-cluster
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: orchestrator-cluster
subjects:
- kind: ServiceAccount
  name: orchestrator-sa
  namespace: llm-platform
```

```yaml
# Tier 2: Role template — applied by the orchestrator to each ws-<sub>
# namespace it creates. Never applied to llm-core or llm-platform.
# assets/k8s/llm-platform/orchestrator-ws-role-template.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orchestrator-ws
  namespace: ws-<sub>   # set per namespace at provisioning time
rules:
- apiGroups: [""]
  resources: ["resourcequotas", "limitranges", "services",
              "persistentvolumeclaims", "configmaps", "secrets", "pods"]
  verbs: ["create", "get", "list", "watch", "patch", "delete"]
- apiGroups: ["apps"]
  resources: ["deployments", "replicasets"]
  verbs: ["create", "get", "list", "watch", "patch", "delete"]
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["httproutes"]
  verbs: ["create", "get", "list", "watch", "patch", "delete"]
- apiGroups: ["networking.k8s.io"]
  resources: ["networkpolicies"]
  # patch and delete intentionally omitted — orchestrator creates workspace-isolation
  # once at provisioning time; any modification or deletion is an admin-only
  # operation performed directly via Tailscale, not through the orchestrator
  verbs: ["create", "get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: orchestrator-ws
  namespace: ws-<sub>
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: orchestrator-ws
subjects:
- kind: ServiceAccount
  name: orchestrator-sa
  namespace: llm-platform
```

> **Bootstrap note:** The `inference-policy` NetworkPolicy in `llm-core`
> ([step 04 §8](04-deploy-stack-ubuntu.md)) is applied at cluster bootstrap —
> before the orchestrator is deployed — and is not in any namespace the
> orchestrator can write to.
> The orchestrator ClusterRole has no networkpolicy write verbs; the per-namespace
> Role only exists in `ws-*` namespaces. A compromised orchestrator has no
> direct write path to `llm-core`.

> **RBAC bootstrap constraint:** `rolebindings: create` is cluster-wide because
> standard Kubernetes RBAC cannot scope RoleBinding creation to namespace name
> patterns. The practical blast radius is limited by Kubernetes's built-in
> privilege escalation prevention: the orchestrator cannot bind to any role that
> grants permissions it does not already hold. Admission-level scoping (Kyverno)
> is available as a future hardening step if the threat model expands.

The orchestrator never gets `pods/exec` or `pods/portforward` — no path from
the admin plane into a workspace container.

### Orchestrator identity model

The orchestrator uses the OIDC `sub` claim as the immutable primary key for
all workspace resources. `preferred_username` is cached as `display_name` and
used only for the workspace hostname slug — it is refreshed at each login but
never used to name or locate Kubernetes resources.

```
workspaces table:
  sub                TEXT PRIMARY KEY   -- OIDC sub UUID, never changes
  display_name       TEXT               -- cached preferred_username, updated at login
  hostname_slug      TEXT UNIQUE        -- e.g. "alice", set once at provisioning
  namespace          TEXT               -- "ws-<sub>"
  pvc                TEXT               -- "home-<sub>"
  litellm_key_alias  TEXT               -- written at key mint; enables revocation retry
                                        -- if the k8s Secret is gone (H-23)
  launched_at        TIMESTAMP          -- set on each launch; drives hard max-lifetime
                                        -- enforcement independent of activity (H-22)

hostname_registry table:
  slug       TEXT PRIMARY KEY
  sub        TEXT NOT NULL REFERENCES workspaces(sub)
  status     TEXT NOT NULL          -- "active" | "reserved" | "released"
  claimed_at TIMESTAMP
```

`hostname_slug` does not auto-update when `preferred_username` changes in
Authentik — the workspace URL stays stable across renames. An admin can
request a slug rename via an explicit orchestrator operation, which checks
availability and updates the HTTPRoute atomically.

### What the orchestrator does at workspace launch

0. **Pre-flight (every launch):** verify the Calico DaemonSet is healthy
   before proceeding. If the check fails, reject the launch with a clear
   error — do not allow workspace creation while isolation may be unenforced.
   ```python
   ds = k8s.apps_v1.read_namespaced_daemon_set("calico-node", "kube-system")
   assert ds.status.number_ready == ds.status.desired_number_scheduled, "Calico not fully ready — workspace creation blocked"
   ```
1. **First provisioning for a user** (`sub` not in workspaces table):
   - Derive proposed `hostname_slug` from `preferred_username` (sanitise to
     a valid DNS label: lowercase, alphanumeric + hyphens, max 63 chars).
   - **Collision check:** `SELECT FROM hostname_registry WHERE slug = $proposed
     AND status != 'released'`. If a row exists owned by a different `sub`,
     reject with an error for admin resolution before proceeding.
   - Create `ws-<sub>` namespace, apply `workspace-isolation` NetworkPolicy
     **before** creating any Deployment, apply `workspace-quota` ResourceQuota,
     and create the `orchestrator-ws` Role + RoleBinding.
   - Create PVC `home-<sub>`.
   - INSERT into `workspaces` and `hostname_registry` (status: `active`).
2. **Each workspace launch** (returning user, `sub` already provisioned):
   - Refresh `display_name` from current `preferred_username` in the token.
   - Verify `workspace-isolation` NetworkPolicy is present and spec matches
     the expected template; abort if missing or mismatched (race-condition
     guard — policy must exist before any pod can start).
   - Mint a scoped LiteLLM key (`/key/generate` with `max_budget`, `rpm_limit`,
     model allowlist — [step 06](06-gateway-litellm.md)).
   - **Write the key alias to `workspaces.litellm_key_alias` and set
     `launched_at = now()` before creating the k8s Secret.** The DB record is
     the authoritative source for revocation — if the orchestrator crashes before
     or after Secret creation, the alias is still available to retry the revoke
     call on recovery (H-23).
   - Store the key in a `Secret` named `litellm-key` in `ws-<sub>`.
   - Create the workspace `Deployment` + `Service` in `ws-<sub>` (see §6).
   - Create a `ReferenceGrant` in `ws-<sub>` permitting HTTPRoutes in
     `llm-platform` to reference Services in `ws-<sub>`.
   - Create an `HTTPRoute` in `llm-platform` (attached to `workspace-gateway`)
     for `<hostname_slug>.ws.domain.com` targeting the Service in `ws-<sub>`.
     Workspace namespaces cannot self-register routes — all routing is owned
     by the orchestrator in its own namespace.
3. **Idle TTL and hard max lifetime:**
   - **Idle signal:** poll Kubernetes metrics-server CPU for the workspace pod.
     A truly idle container shows near-zero CPU regardless of any HTTP responses
     it serves — this signal cannot be spoofed from inside the pod (H-22).
     Scale to zero (`kubectl scale --replicas=0`) when CPU stays below threshold
     for the full TTL window.
   - **Hard maximum lifetime:** also enforce a configurable absolute limit (default
     24 h from `launched_at`). At the hard limit the workspace is stopped and the
     user must relaunch — regardless of CPU activity. This prevents indefinite
     resource monopolization by a workspace that stays busy.
   - Home PVC and `hostname_registry` entry are preserved across both stops.
4. **Workspace destroy** (temporary — idle TTL, hard max lifetime, or manual stop):
   - Read the key alias from `workspaces.litellm_key_alias` (the DB record, not
     the k8s Secret — the Secret may be absent if recovering from a crash).
   - Call `/key/delete` with the alias. Verify via `/key/info` returning 404
     before proceeding. **If revocation fails, halt and surface an error — do
     not delete the Secret with an unrevoked key outstanding.**
   - Clear `litellm_key_alias` in the DB after confirmed revocation.
   - Delete Deployment, Service, Secret in `ws-<sub>`.
   - Delete HTTPRoute and ReferenceGrant in `llm-platform`.
   - Keep PVC `home-<sub>`. UPDATE `hostname_registry` SET status = `reserved`
     (slug remains owned by this user, same URL on next launch).
5. **Deprovision** (user removed from `grp-workspaces` or deleted in Authentik):
   - Read alias from `workspaces.litellm_key_alias`; revoke and verify 404 (same
     sequence as destroy). Halt if revocation fails.
   - Clear `litellm_key_alias` in the DB after confirmed revocation.
   - Delete HTTPRoute and ReferenceGrant in `llm-platform`.
   - Delete Deployment, Service, Secret, PVC `home-<sub>`, namespace `ws-<sub>`.
   - UPDATE `hostname_registry` SET status = `released` — slug available for
     a future user.

> **Recovery:** on orchestrator startup, query for rows where
> `litellm_key_alias IS NOT NULL` and no active Deployment exists in the
> corresponding namespace. These are orphaned keys from a crashed destroy
> sequence. Retry `/key/delete` for each, then clear `litellm_key_alias`
> on success. Log any that fail (the key may have already been manually
> deleted) and alert for admin review.

### Calico watchdog

The pre-flight check at step 0 blocks new workspace launches when Calico is
unhealthy. It does **not** protect workspaces already running if Calico crashes
after launch. Deploy this continuous Deployment (not a CronJob) to cover the
running-workspace case — it polls every 5 seconds and scales down all workspace
Deployments within seconds of detecting Calico degradation.

A CronJob was considered but rejected: it has up to a 60-second scheduling gap
plus `concurrencyPolicy: Forbid` can silently skip a run, leaving a 90–180 second
window of unprotected access. A long-running Deployment eliminates both problems.

The ClusterRole is scoped to the minimum necessary: it can only read DaemonSet
status, list namespaces and deployments, and write to the `deployments/scale`
subresource — it cannot modify deployment specs, secrets, or any other resource.

```yaml
# assets/k8s/kube-system/calico-watchdog.yaml
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: calico-watchdog-sa
  namespace: kube-system
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: calico-watchdog
rules:
- apiGroups: ["apps"]
  resources: ["daemonsets"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["list"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["list"]
# deployments/scale is a subresource — allows only reading and patching the
# replica count; does not grant access to the deployment spec or template
- apiGroups: ["apps"]
  resources: ["deployments/scale"]
  verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: calico-watchdog
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: calico-watchdog
subjects:
- kind: ServiceAccount
  name: calico-watchdog-sa
  namespace: kube-system
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: calico-watchdog
  namespace: kube-system
spec:
  replicas: 1
  selector:
    matchLabels:
      app: calico-watchdog
  template:
    metadata:
      labels:
        app: calico-watchdog
    spec:
      serviceAccountName: calico-watchdog-sa
      containers:
      - name: watchdog
        # Pin to a digest before production use:
        #   docker pull bitnami/kubectl:1.29
        #   docker inspect --format='{{index .RepoDigests 0}}' bitnami/kubectl:1.29
        image: bitnami/kubectl:1.29
        command:
        - /bin/sh
        - -c
        - |
          while true; do
            DESIRED=$(kubectl get daemonset calico-node -n kube-system -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null)
            READY=$(kubectl get daemonset calico-node -n kube-system -o jsonpath='{.status.numberReady}' 2>/dev/null)
            if [ -n "$DESIRED" ] && [ "$READY" -lt "$DESIRED" ]; then
              echo "$(date -u) Calico degraded ($READY/$DESIRED) — suspending workspace pods"
              for ns in $(kubectl get ns --no-headers -o custom-columns=':metadata.name' | grep '^ws-'); do
                kubectl scale deployment --all --replicas=0 -n "$ns" 2>/dev/null && echo "$(date -u) Suspended $ns"
              done
            fi
            sleep 5
          done
        resources:
          requests:
            cpu: "50m"
            memory: "32Mi"
          limits:
            cpu: "100m"
            memory: "64Mi"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
```

```bash
microk8s kubectl apply -f assets/k8s/kube-system/calico-watchdog.yaml

# Verify the watchdog pod is running
microk8s kubectl get deployment calico-watchdog -n kube-system
microk8s kubectl logs -l app=calico-watchdog -n kube-system --tail=5
```

> **Bypass gap (accepted):** a direct `kubectl` call by an admin bypasses the
> orchestrator pre-flight. The watchdog still catches the result (pods running
> without Calico) within 5 seconds regardless of how they were created. Admission-
> level enforcement (Kyverno) is the upgrade path if the threat model expands.

---

## 6. Workspace pod spec

Build the workspace base image from
[`assets/workspace-base/Dockerfile`](assets/workspace-base/Dockerfile) and push it
to the MicroK8s registry — same flow as the inference image
([step 04 §5](04-deploy-stack-ubuntu.md)):

```bash
cd /opt/home-llm/assets/workspace-base
sudo docker build -t localhost:32000/ws-python:latest .
sudo docker push localhost:32000/ws-python:latest
```

Key fields — adapt to your base image and quota tier:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: workspace
  namespace: ws-<sub>
spec:
  replicas: 1
  selector:
    matchLabels:
      app: workspace
  template:
    metadata:
      labels:
        app: workspace
    spec:
      automountServiceAccountToken: false   # workspaces have no k8s API access
      terminationGracePeriodSeconds: 5      # fast scale-down when watchdog fires
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: code-server
        image: localhost:32000/ws-python:latest   # pin to digest — step 04 §6
        ports:
        - containerPort: 8080
        env:
        - name: OPENAI_API_BASE
          value: "http://litellm.llm-core.svc.cluster.local:4000/v1"
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-key
              key: api-key
        resources:
          requests:
            cpu: "500m"
            memory: "1Gi"
          limits:
            cpu: "2"
            memory: "4Gi"
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: home
          mountPath: /home/user
        - name: tmp
          mountPath: /tmp
      volumes:
      - name: home
        persistentVolumeClaim:
          claimName: home-<sub>
      - name: tmp
        emptyDir:
          sizeLimit: "500Mi"    # caps disk use in /tmp; eviction begins at this threshold
```

---

## 7. Resource management

Applied by the orchestrator at namespace creation. Tune values per quota tier
(map tiers to Authentik groups in [step 14](14-identity-sso.md)):

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: workspace-quota
  namespace: ws-<sub>
spec:
  hard:
    requests.cpu: "2"
    requests.memory: "4Gi"
    limits.cpu: "4"
    limits.memory: "8Gi"
    requests.ephemeral-storage: "1Gi"  # total across all containers; keeps /tmp fills from exhausting node
    count/pods: "2"                    # 1 active workspace + 1 headroom
    persistentvolumeclaims: "1"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: workspace-defaults
  namespace: ws-<sub>
spec:
  limits:
  - type: Container
    default:
      cpu: "1"
      memory: "2Gi"
      ephemeral-storage: "500Mi"
    defaultRequest:
      cpu: "250m"
      memory: "512Mi"
      ephemeral-storage: "100Mi"
```

The orchestrator's consumption dashboard queries `kubectl top nodes` and
`kubectl get resourcequota --all-namespaces` to show overall
availability vs. allocated capacity.

---

## 8. LLM access from inside a workspace

Workspace pods reach LiteLLM **in-cluster** — no public internet hop:

```
ws pod → litellm.llm-core.svc.cluster.local:4000 → inference
```

All enforcement happens in LiteLLM regardless of the traffic path:
- **Virtual key auth** — checked on every request
- **Budget + rate limits** — enforced in-process
- **Model allowlist** — per-key, set at mint time

The public `api.domain.com` endpoint remains for external coder friends
(Continue, Aider, Claude Code on their own machines) — that path is unchanged.
Workspace pods never use it.

---

## 9. Access (from anywhere)

- Add a **wildcard tunnel route** `*.ws.domain.com → http://traefik.llm-platform.svc.cluster.local:80`
  in cloudflared config (step 09 pattern).
- A **Cloudflare Access** application on `*.ws.domain.com` with an Allow policy
  for `grp-workspaces` (federated to Authentik — [step 14](14-identity-sso.md)).
  Unauthenticated users are rejected at the edge before reaching Traefik.
- Defense in depth: CF Access (edge) → workspace NetworkPolicy (ingress from
  Traefik only) → code-server session.

---

## 10. Security caveats

- Containers are **not** a strong boundary against a determined attacker. This
  design is sized for **trusted friends** + the hardening above. For less-trusted
  users, switch the runtime to **Kata/Firecracker microVMs** — the orchestrator,
  NetworkPolicy, and base images carry over unchanged.
- The **orchestrator's ClusterRole is intentionally narrow** — cluster-scoped
  read on namespaces/nodes/PVs, plus `rolebindings: create` for bootstrapping
  per-namespace Roles. It is **not** cluster-admin-equivalent: it cannot read
  Secrets or write NetworkPolicies in `llm-core` or `llm-platform` — these
  restrictions are structural (the two-tier RBAC in §5 never grants those verbs
  outside `ws-*` namespaces). The `namespaces: delete` permission covers all
  namespaces by RBAC necessity; design intent limits it to `ws-*` on workspace
  deprovision, enforced operationally rather than at the admission layer (accepted
  residual — a ValidatingAdmissionWebhook such as Kyverno is the upgrade path if
  the threat model expands beyond trusted operators). Keep the orchestrator
  admin-only (Tailscale + `grp-admin`), patched, and audited.
- `automountServiceAccountToken: false` on workspace pods means they cannot
  call the k8s API at all — even if a workspace is compromised, the attacker
  has no path to the control plane.

---

## Reference: adopting a platform instead

If the custom orchestrator build grows heavy, these map onto the same design:

| This design | Coder | Kasm |
|---|---|---|
| Orchestrator + UI | Coderd + Terraform templates | Kasm manager |
| Base images | Workspace templates | Kasm images |
| AuthN/AuthZ | Built-in OIDC + RBAC | Built-in OIDC + RBAC |
| Browser IDE | code-server / web IDE | Streamed desktop/app |
| Quotas / TTL | Built-in | Built-in |

Either replaces most of §5 with configuration. Revisit **D12** in the
[README](README.md) if the custom UI scope balloons.

---

## Verification

- A `grp-workspaces` user logs in (Authentik), launches a workspace, and reaches
  it at `<hostname_slug>.ws.domain.com` in the browser; Aider inside works
  against LiteLLM with the injected key.
- A non-`grp-workspaces` user is denied at the Cloudflare edge.
- From inside a workspace:
  - `curl http://litellm.llm-core.svc.cluster.local:4000/v1/models` with the
    injected key **succeeds**.
  - `curl http://inference.llm-core.svc.cluster.local:8080/v1/models` **fails**
    (NetworkPolicy blocks it).
  - `curl http://192.168.x.x` (any LAN IP) **fails**.
  - `curl https://pypi.org` **succeeds**.
- Idle workspace auto-stops after TTL; PVC `home-<sub>` and `/home/user` contents
  persist across relaunch. The hostname slug is retained (status: `reserved`) —
  the user gets the same URL on next launch.
- `kubectl get secret litellm-key -n ws-<sub>` is absent after workspace destroy.
- `automountServiceAccountToken` is false: `ls /var/run/secrets` is empty
  inside the workspace pod.
- Renaming a user in Authentik updates `display_name` in the orchestrator DB
  but does not change `hostname_slug` or any Kubernetes resource name — the
  workspace URL is stable.
