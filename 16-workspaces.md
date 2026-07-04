# 16 — On-demand workspaces (3rd client type)

← [15 Identity & SSO](15-identity-sso.md) · [Back to README](README.md)

> **Overview:** Install MicroK8s, write the workspace orchestrator (an OIDC-authenticated API that provisions isolated Kubernetes pods per user), configure namespace isolation with NetworkPolicy and RBAC, and expose workspaces via Cloudflare Tunnel and Access.
>
> **Why:** Each workspace is a fully isolated Linux dev environment. Namespace RBAC, NetworkPolicy, and per-workspace LiteLLM keys ensure one user's workspace cannot reach another's data, the host's service plane, or the LAN.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<tailscale-ip>` | Server's Tailscale IPv4 address | `tailscale ip -4` (from step 09) |
> | `<domain.com>` | Your registered domain | From step 08 |

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

**Pin snap auto-refresh to a maintenance window.** MicroK8s is distributed as a
snap. Uncontrolled snap auto-updates can briefly restart the `calico-node`
DaemonSet during working hours, creating a window where running workspace pods
have no NetworkPolicy enforcement:

```bash
# Restrict snap updates to 01:00–03:00 local time, max once per week
sudo snap set system refresh.schedule="tue,01:00-03:00"

# Verify
snap get system refresh.schedule
```

This does not prevent updates; it moves them to a low-traffic window. The
Calico watchdog in §5 will suspend workspace pods if Calico becomes degraded
during any update window.

**Restrict API server access to Tailscale.** MicroK8s binds the kube-apiserver
to `0.0.0.0:16443` by default. The bind-address is intentionally left as-is —
`--bind-address` takes a single IP, so binding to the Tailscale IP would break
local `microk8s kubectl` which uses `127.0.0.1` over loopback. UFW
`default deny incoming` (step 02 §4) blocks all LAN access to port 16443;
`ufw allow in on tailscale0` (step 09 §1) permits Tailscale-based remote access.

Verify the apiserver is listening and that UFW has no explicit LAN allow for it:

```bash
ss -tlnp | grep 16443           # confirms apiserver is running (0.0.0.0:16443 expected)
sudo ufw status | grep 16443    # should return nothing — port is covered by default deny
```

For remote `kubectl` from your admin devices, use the server's Tailscale IP:

```bash
microk8s config | sed 's/127.0.0.1/<tailscale-ip>/' > ~/.kube/microk8s-tailscale.config
export KUBECONFIG=~/.kube/microk8s-tailscale.config
kubectl get nodes   # verify connectivity from your laptop over Tailscale
```

If Tailscale is unavailable, SSH into the server and run `microk8s kubectl`
locally — loopback access to `127.0.0.1:16443` is always available from the host.

**Enable Secrets encryption at rest.** MicroK8s does not encrypt Kubernetes
Secrets on disk by default — they are base64-encoded plaintext in the dqlite
data directory, readable by any process with host filesystem access. Enable
`secretbox` (XSalsa20 + Poly1305 AEAD) encryption so that all Secret values
are encrypted before being written to the datastore.

Generate the encryption key and write the `EncryptionConfiguration`:

```bash
# Generate a 32-byte key (base64-encoded — Kubernetes decodes it at load time)
ENC_KEY=$(openssl rand -base64 32)

# Write the EncryptionConfiguration — root-only, mode 400
sudo tee /var/snap/microk8s/current/args/encryption-config.yaml > /dev/null <<EOF
apiVersion: apiserver.config.k8s.io/v1
kind: EncryptionConfiguration
resources:
- resources:
  - secrets
  providers:
  - secretbox:
      keys:
      - name: key1
        secret: ${ENC_KEY}
  - identity: {}
EOF
sudo chmod 400 /var/snap/microk8s/current/args/encryption-config.yaml
sudo chown root:root /var/snap/microk8s/current/args/encryption-config.yaml
```

**Back up the key to your password manager now.** If this file is lost, every
Secret in the cluster becomes unreadable and all workspaces must be
re-provisioned from scratch.

Register the config with the kube-apiserver:

```bash
# Append the flag to the kube-apiserver args file
echo '--encryption-provider-config=/var/snap/microk8s/current/args/encryption-config.yaml' \
  | sudo tee -a /var/snap/microk8s/current/args/kube-apiserver > /dev/null

# Restart MicroK8s to pick up the new flag
sudo snap restart microk8s
```

Wait for the apiserver to come back up:

```bash
microk8s kubectl get nodes   # Ready = apiserver is up
```

Re-encrypt all existing Secrets so that any created before this step are also
encrypted (the `identity: {}` fallback in the config handles reading them
during this one-time pass):

```bash
microk8s kubectl get secrets --all-namespaces -o json \
  | microk8s kubectl replace -f -
```

Verify encryption is active — the raw dqlite value for any Secret should now
be an opaque ciphertext blob, not a base64 string:

```bash
# Pull a known Secret and confirm the apiserver can still decode it
microk8s kubectl get secret -n kube-system -o json \
  $(microk8s kubectl get secrets -n kube-system -o name | head -1 | cut -d/ -f2) \
  | jq '.data | keys'
# Should return a list of key names without error — decryption is working
```

> **Key rotation:** if the encryption key ever needs to be rotated, add a new
> key entry (`name: key2`) above the existing `key1` entry in the
> `EncryptionConfiguration`, restart MicroK8s, run the `kubectl replace` pipe
> again to re-encrypt all Secrets under the new key, then remove `key1` and
> restart once more. Never remove the old key before re-encrypting.

---

## 2. Namespace structure

```bash
microk8s kubectl create namespace llm-platform
microk8s kubectl create namespace llm-core

# Label them so NetworkPolicy namespaceSelectors resolve correctly
microk8s kubectl label namespace llm-platform kubernetes.io/metadata.name=llm-platform
microk8s kubectl label namespace llm-core     kubernetes.io/metadata.name=llm-core
```

Workspace namespaces (`ws-<sub>`) are created dynamically by the
orchestrator at first provisioning — see §5 below. The orchestrator
applies two labels at namespace creation time:

```bash
# Applied by orchestrator — do not apply manually to permanent namespaces
microk8s kubectl label namespace ws-<sub> kubernetes.io/metadata.name=ws-<sub>
microk8s kubectl label namespace ws-<sub> workspace=true
```

The `workspace=true` label is the namespaceSelector anchor used by the
litellm-policy (§4d) to allow workspace pods to call LiteLLM, and by the
traefik-policy (§4e) to allow Traefik to route to workspace Services.
Every ws-* namespace must carry this label before any pod is created in it.

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

Create two Gateways — one for core services, one for workspace subdomains.
Neither allows routes from `ws-*` namespaces directly.

```yaml
# assets/k8s/llm-platform/core-gateway.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: core-gateway
  namespace: llm-platform
spec:
  gatewayClassName: traefik
  listeners:
  - name: ui
    hostname: "llm.domain.com"
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: In
            values: [llm-platform, llm-core]
  - name: api
    hostname: "api.domain.com"
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: In
            values: [llm-platform, llm-core]
  - name: admin
    hostname: "admin.domain.com"
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: In
            values: [llm-platform]
  - name: auth
    hostname: "auth.domain.com"
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: In
            values: [llm-platform]
---
# assets/k8s/llm-platform/workspace-gateway.yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: workspace-gateway
  namespace: llm-platform
spec:
  gatewayClassName: traefik
  listeners:
  - name: workspaces
    hostname: "*.ws.domain.com"
    port: 80
    protocol: HTTP
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchExpressions:
          - key: kubernetes.io/metadata.name
            operator: In
            values: [llm-platform]   # orchestrator creates HTTPRoutes here only
```

HTTPRoutes for the core services (`llm.domain.com`, `api.domain.com`) live in
`assets/k8s/llm-platform/` attached to `core-gateway`. The orchestrator creates
per-workspace HTTPRoutes in `llm-platform` (not in `ws-*` namespaces) at launch
time — see §5 below.

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

### 4b. Default-deny baseline for llm-core and llm-platform

Apply these **before** any other policy in each namespace. With no default-deny,
any pod added to either namespace — a debug container, a sidecar injected by
mistake, a future service — inherits unrestricted ingress and egress. The
explicit allow policies in §4c and §4d layer on top of this baseline.

```yaml
# assets/k8s/llm-core/default-deny.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: llm-core
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
---
# assets/k8s/llm-platform/default-deny.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: llm-platform
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
```

### 4c. llm-core explicit allow policies

```yaml
# assets/k8s/llm-core/networkpolicies.yaml

# inference: ingress from litellm only; egress to kube-dns only (H-4, M-3)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: inference-policy
  namespace: llm-core
spec:
  podSelector:
    matchLabels:
      app: inference
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: litellm
    ports:
    - port: 8080
      protocol: TCP
  egress:
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
---
# litellm: ingress from all authorised callers; egress to inference + dns (H-4)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: litellm-policy
  namespace: llm-core
spec:
  podSelector:
    matchLabels:
      app: litellm
  policyTypes: [Ingress, Egress]
  ingress:
  # traefik/cloudflared path (api.domain.com) + admin-ui + orchestrator
  # (key mint/revoke) — all in llm-platform
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-platform
    ports:
    - port: 4000
      protocol: TCP
  # open-webui chat path — same namespace
  - from:
    - podSelector:
        matchLabels:
          app: open-webui
    ports:
    - port: 4000
      protocol: TCP
  # workspace pods — namespaces labeled workspace=true by orchestrator at creation
  - from:
    - namespaceSelector:
        matchLabels:
          workspace: "true"
    ports:
    - port: 4000
      protocol: TCP
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: inference
    ports:
    - port: 8080
      protocol: TCP
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
---
# open-webui: ingress from traefik + admin-ui (llm-platform); egress to litellm + dns
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: open-webui-policy
  namespace: llm-core
spec:
  podSelector:
    matchLabels:
      app: open-webui
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-platform
    ports:
    - port: 8080
      protocol: TCP
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: litellm
    ports:
    - port: 4000
      protocol: TCP
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

> **`inference-policy` protection:** applied once at cluster bootstrap in
> `llm-core`, which the orchestrator has no write access to. This structurally
> prevents workspace pods from reaching inference even if a workspace
> NetworkPolicy is misconfigured — the deny is enforced at the destination, not
> only at the source. Protection against accidental admin deletion is process
> only; Kyverno immutability is the upgrade path if the threat model expands.

### 4d. llm-platform explicit allow policies

**Pre-apply validation — verify the k8s API server ClusterIP before applying
traefik-policy and orchestrator-policy:**

```bash
microk8s kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}'
# Default in MicroK8s: 10.96.0.1
# Update the ipBlock cidr in traefik-policy and orchestrator-policy below
# if the value on your cluster differs before applying either policy.
```

```yaml
# assets/k8s/llm-platform/networkpolicies.yaml

# cloudflared: no ingress (outbound tunnel); egress to Cloudflare edge + traefik + dns
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: cloudflared-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app: cloudflared
  policyTypes: [Ingress, Egress]
  egress:
  # Cloudflare edge — outbound tunnel connection (no inbound ports required)
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
          - 100.64.0.0/10
          - 169.254.0.0/16
          - 127.0.0.0/8
          - 100.0.0.0/10
    ports:
    - port: 443
      protocol: TCP
  # Traefik — forward decapsulated requests in-cluster
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: traefik
    ports:
    - port: 80
      protocol: TCP
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
---
# traefik: ingress from cloudflared; egress to backends + k8s API + dns
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: traefik-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: traefik
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app: cloudflared
    ports:
    - port: 80
      protocol: TCP
  egress:
  # llm-core backends (open-webui :8080, litellm :4000)
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-core
    ports:
    - port: 4000
      protocol: TCP
    - port: 8080
      protocol: TCP
  # workspace pods (code-server :8080)
  - to:
    - namespaceSelector:
        matchLabels:
          workspace: "true"
    ports:
    - port: 8080
      protocol: TCP
  # admin-ui and authentik-server (intra-namespace)
  - to:
    - podSelector:
        matchLabels:
          app: admin-ui
    ports:
    - port: 8080
      protocol: TCP
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: server
    ports:
    - port: 9000
      protocol: TCP
  # k8s API server — Traefik watches HTTPRoutes and Services
  # Verify ClusterIP with: kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}'
  - to:
    - ipBlock:
        cidr: 10.96.0.1/32
    ports:
    - port: 443
      protocol: TCP
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
---
# authentik-server: ingress from traefik + orchestrator + admin-ui;
# egress to postgres + redis + internet (email/OAuth) + dns
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: authentik-server-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: authentik
      app.kubernetes.io/component: server
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: traefik
    - podSelector:
        matchLabels:
          app: orchestrator
    - podSelector:
        matchLabels:
          app: admin-ui
    ports:
    - port: 9000
      protocol: TCP
  egress:
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: postgresql
    ports:
    - port: 5432
      protocol: TCP
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: redis
    ports:
    - port: 6379
      protocol: TCP
  # External email delivery (SMTP/TLS) and any external OAuth provider
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
          - 100.64.0.0/10
          - 169.254.0.0/16
          - 127.0.0.0/8
          - 100.0.0.0/10
    ports:
    - port: 443
      protocol: TCP
    - port: 587
      protocol: TCP
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
---
# authentik-worker: no ingress; egress to postgres + redis + internet + dns
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: authentik-worker-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: authentik
      app.kubernetes.io/component: worker
  policyTypes: [Ingress, Egress]
  egress:
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: postgresql
    ports:
    - port: 5432
      protocol: TCP
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: redis
    ports:
    - port: 6379
      protocol: TCP
  - to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
          - 100.64.0.0/10
          - 169.254.0.0/16
          - 127.0.0.0/8
          - 100.0.0.0/10
    ports:
    - port: 443
      protocol: TCP
    - port: 587
      protocol: TCP
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
---
# authentik-postgres: ingress from server + worker only; no external egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: authentik-postgres-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: authentik
      app.kubernetes.io/component: postgresql
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: server
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: worker
    ports:
    - port: 5432
      protocol: TCP
  egress:
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
---
# authentik-redis: ingress from server + worker only; no external egress
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: authentik-redis-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: authentik
      app.kubernetes.io/component: redis
  policyTypes: [Ingress, Egress]
  ingress:
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: server
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: worker
    ports:
    - port: 6379
      protocol: TCP
  egress:
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
```

> **Authentik label note:** the `app.kubernetes.io/name` and
> `app.kubernetes.io/component` labels above match the official Authentik Helm
> chart defaults. Verify the actual labels on your deployment with
> `kubectl get pods -n llm-platform --show-labels` before applying these
> policies if you use a custom deployment or a different chart version.

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

> **Bootstrap note:** The `inference-ingress` NetworkPolicy in `llm-core`
> (§4b) is applied once during cluster bootstrap — before the orchestrator
> is deployed — and is not in any namespace the orchestrator can write to.
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
   assert ds.status.number_ready == ds.status.desired_number_scheduled, \
       "Calico not fully ready — workspace creation blocked"
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
            DESIRED=$(kubectl get daemonset calico-node -n kube-system \
              -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null)
            READY=$(kubectl get daemonset calico-node -n kube-system \
              -o jsonpath='{.status.numberReady}' 2>/dev/null)
            if [ -n "$DESIRED" ] && [ "$READY" -lt "$DESIRED" ]; then
              echo "$(date -u) Calico degraded ($READY/$DESIRED) — suspending workspace pods"
              for ns in $(kubectl get ns --no-headers \
                  -o custom-columns=':metadata.name' | grep '^ws-'); do
                kubectl scale deployment --all --replicas=0 -n "$ns" 2>/dev/null \
                  && echo "$(date -u) Suspended $ns"
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
        image: your-registry/ws-python:latest
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
(map tiers to Authentik groups in [step 15](15-identity-sso.md)):

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
