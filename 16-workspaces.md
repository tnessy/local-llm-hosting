# 16 — On-demand workspaces (3rd client type)

← [15 Identity & SSO](15-identity-sso.md) · [Back to README](README.md)

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
│  ns: ws-<username>   (one per user, created by orchestrator)                 │
│  ResourceQuota · LimitRange · NetworkPolicy                                  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  workspace pod (code-server)                                          │  │
│  │  env: OPENAI_API_BASE=http://litellm.llm-core.svc.cluster.local:4000 │  │
│  │       OPENAI_API_KEY=<scoped key minted by orchestrator at launch>    │  │
│  │  PVC: ws-<username>-home → /home/user   (persists across restarts)    │  │
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

## 1. MicroK8s add-ons required

Enable these before deploying anything in this step:

```bash
microk8s enable dns
microk8s enable calico          # CNI with NetworkPolicy support
microk8s enable gpu             # NVIDIA device plugin (for llm-core inference)
microk8s enable hostpath-storage  # PVC provisioner for home volumes + service data
microk8s enable helm3           # for Authentik (step 15)
```

**Wait for Calico to be fully ready before proceeding.** Kubernetes silently
accepts NetworkPolicy resources regardless of whether a CNI is enforcing them —
a crash-looping or absent Calico means every policy is a no-op with no error.

```bash
# Wait until ALL calico-node pods are Running and Ready (one per node)
microk8s kubectl rollout status daemonset/calico-node -n kube-system

# Confirm desired == ready (the number in parentheses must match)
microk8s kubectl get daemonset calico-node -n kube-system
# Expected: DESIRED=1  CURRENT=1  READY=1  (on a single-node cluster)
```

Do not create namespaces or workspaces until this check passes. The orchestrator
enforces this programmatically at runtime — see §5.

---

## 2. Namespace structure

```bash
microk8s kubectl create namespace llm-platform
microk8s kubectl create namespace llm-core

# Label them so NetworkPolicy namespaceSelectors resolve correctly
microk8s kubectl label namespace llm-platform kubernetes.io/metadata.name=llm-platform
microk8s kubectl label namespace llm-core     kubernetes.io/metadata.name=llm-core
```

Workspace namespaces (`ws-<username>`) are created dynamically by the
orchestrator at first login — see §5 below.

---

## 3. Traefik Gateway setup

MicroK8s does not ship Traefik by default. Install it with its Helm chart and
configure it as a Gateway API controller:

```bash
microk8s helm3 repo add traefik https://helm.traefik.io/traefik
microk8s helm3 repo update

microk8s helm3 install traefik traefik/traefik \
  --namespace llm-platform \
  --set providers.kubernetesGateway.enabled=true \
  --set providers.kubernetesCRD.enabled=true \
  --set service.type=ClusterIP   # cloudflared reaches it in-cluster; no NodePort needed
```

Create the shared Gateway (all namespaces may attach HTTPRoutes):

```yaml
# assets/k8s/gateway.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: main-gateway
  namespace: llm-platform
spec:
  gatewayClassName: traefik
  listeners:
  - name: web
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: All
```

HTTPRoutes for the core services live in `assets/k8s/llm-core/` (created in
step 04). The orchestrator creates per-workspace HTTPRoutes at launch time
(§5 below).

---

## 4. Network isolation

### 4a. Workspace egress + ingress policy

The orchestrator applies this to every `ws-<username>` namespace it creates.
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
  # kube-dns
  - to:
    - namespaceSelector: {}
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

### 4b. Inference ingress lock

Applied in `llm-core`. Structurally prevents workspace pods from ever reaching
the inference engine directly — even if a workspace NetworkPolicy is
misconfigured.

```yaml
# assets/k8s/llm-core/networkpolicy-inference.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: inference-ingress
  namespace: llm-core
spec:
  podSelector:
    matchLabels:
      app: inference
  policyTypes: [Ingress]
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-core
      podSelector:
        matchLabels:
          app: litellm
```

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
# Tier 2: Role template — applied by the orchestrator to each ws-<username>
# namespace it creates. Never applied to llm-core or llm-platform.
# assets/k8s/llm-platform/orchestrator-ws-role-template.yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: orchestrator-ws
  namespace: ws-<username>   # set per namespace at provisioning time
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
  verbs: ["create", "get", "list", "watch", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: orchestrator-ws
  namespace: ws-<username>
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: orchestrator-ws
subjects:
- kind: ServiceAccount
  name: orchestrator-sa
  namespace: llm-platform
```

> **Bootstrap note:** The `inference-ingress` NetworkPolicy in `llm-core`
> (§4b) is applied once during cluster bootstrap — before the orchestrator
> is deployed — and is not in any namespace the orchestrator can write to.
> This ensures a compromised orchestrator cannot erase the inference
> isolation boundary.

The orchestrator never gets `pods/exec` or `pods/portforward` — no path from
the admin plane into a workspace container.

### What the orchestrator does at workspace launch

0. **Pre-flight (every launch):** verify the Calico DaemonSet is healthy
   before proceeding. If the check fails, reject the launch with a clear
   error — do not allow workspace creation while isolation may be unenforced.
   ```python
   ds = k8s.apps_v1.read_namespaced_daemon_set("calico-node", "kube-system")
   assert ds.status.number_ready == ds.status.desired_number_scheduled, \
       "Calico not fully ready — workspace creation blocked"
   ```
1. **First login for a user:** create `ws-<username>` namespace, apply the
   `workspace-isolation` NetworkPolicy **before** creating any Deployment,
   apply `workspace-quota` ResourceQuota, and create the `orchestrator-ws`
   Role + RoleBinding for this namespace.
2. **Each workspace launch:**
   - Verify `workspace-isolation` NetworkPolicy is present and spec matches
     the expected template; abort if missing or mismatched (race-condition
     guard — policy must exist before any pod can start).
   - Mint a scoped LiteLLM key (`/key/generate` with `max_budget`, `rpm_limit`,
     model allowlist — [step 06](06-gateway-litellm.md)).
   - Store the key in a `Secret` in `ws-<username>`.
   - Create the workspace `Deployment` + `Service` (see §6).
   - Create an `HTTPRoute` for `ws-<id>.ws.domain.com` targeting the Service.
3. **Idle TTL:** poll code-server's activity API; call `kubectl scale --replicas=0`
   on idle. Home PVC is preserved.
4. **Destroy:** delete Deployment, Service, HTTPRoute, Secret. Revoke the
   LiteLLM key. Keep the home PVC unless the user explicitly requests deletion.

---

## 6. Workspace pod spec

Key fields — adapt to your base image and quota tier:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ws-<id>
  namespace: ws-<username>
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ws-<id>
  template:
    metadata:
      labels:
        app: ws-<id>
    spec:
      automountServiceAccountToken: false   # workspaces have no k8s API access
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: code-server
        image: your-registry/ws-python:latest
        ports:
        - containerPort: 8080
        env:
        - name: OPENAI_API_BASE
          value: "http://litellm.llm-core.svc.cluster.local:4000/v1"
        - name: OPENAI_API_KEY
          valueFrom:
            secretKeyRef:
              name: ws-<id>-litellm-key
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
          claimName: ws-<username>-home
      - name: tmp
        emptyDir: {}
```

---

## 7. Resource management

Applied by the orchestrator at namespace creation. Tune values per quota tier
(map tiers to Authentik groups in [step 15](15-identity-sso.md)):

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: workspace-quota
  namespace: ws-<username>
spec:
  hard:
    requests.cpu: "2"
    requests.memory: "4Gi"
    limits.cpu: "4"
    limits.memory: "8Gi"
    count/pods: "2"                  # 1 active workspace + 1 headroom
    persistentvolumeclaims: "1"
---
apiVersion: v1
kind: LimitRange
metadata:
  name: workspace-defaults
  namespace: ws-<username>
spec:
  limits:
  - type: Container
    default:
      cpu: "1"
      memory: "2Gi"
    defaultRequest:
      cpu: "250m"
      memory: "512Mi"
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
  in cloudflared config (step 08 pattern).
- A **Cloudflare Access** application on `*.ws.domain.com` with an Allow policy
  for `grp-workspaces` (federated to Authentik — [step 15](15-identity-sso.md)).
  Unauthenticated users are rejected at the edge before reaching Traefik.
- Defense in depth: CF Access (edge) → workspace NetworkPolicy (ingress from
  Traefik only) → code-server session.

---

## 10. Security caveats

- Containers are **not** a strong boundary against a determined attacker. This
  design is sized for **trusted friends** + the hardening above. For less-trusted
  users, switch the runtime to **Kata/Firecracker microVMs** — the orchestrator,
  NetworkPolicy, and base images carry over unchanged.
- The **orchestrator is cluster-admin-equivalent** via its ClusterRole. Keep it
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

- A `grp-workspaces` user logs in (Authentik), launches `ws-python`, and reaches
  it at `ws-<id>.ws.domain.com` in the browser; Aider inside works against
  LiteLLM with the injected key.
- A non-`grp-workspaces` user is denied at the Cloudflare edge.
- From inside a workspace:
  - `curl http://litellm.llm-core.svc.cluster.local:4000/v1/models` with the
    injected key **succeeds**.
  - `curl http://inference.llm-core.svc.cluster.local:8080/v1/models` **fails**
    (NetworkPolicy blocks it).
  - `curl http://192.168.x.x` (any LAN IP) **fails**.
  - `curl https://pypi.org` **succeeds**.
- Idle workspace auto-stops after TTL; home PVC and `/home/user` contents
  persist across relaunch.
- `kubectl get secret ws-<id>-litellm-key -n ws-<username>` is absent after
  workspace destroy.
- `automountServiceAccountToken` is false: `ls /var/run/secrets` is empty
  inside the workspace pod.
