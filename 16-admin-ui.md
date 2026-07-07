# 16 — Admin UI

← [15 Workspaces](15-workspaces.md) · [Back to README](README.md)

> **Overview:** Design and implement a unified admin web UI that surfaces friend key lifecycle, Authentik user management, Open WebUI account operations, and workspace status — calling the orchestrator and service APIs as backends.
>
> **Why:** Centralises operational tasks that would otherwise require direct CLI access to multiple systems, reducing operational surface area and the risk of misconfiguration through ad-hoc commands.

A separate web service that provides a unified management surface for all
operational tasks: friend API key lifecycle, Authentik user provisioning, Open
WebUI accounts, and workspace status. The orchestrator ([step 15](15-workspaces.md))
remains a self-contained workspace lifecycle engine; the Admin UI is the
operator's control plane that calls the orchestrator's internal API as one of
several backends.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  ADMIN BROWSER                                                               │
│  admin.domain.com                                                            │
│    └ CF Access: Allow, grp-admin emails only, 4h session (refreshes on use) │
└──────────────────────────────────────────────────────────────────┬──────────┘
                                                                   │
┌──────────────────────────────────────────────────────────────────▼──────────┐
│  ns: llm-platform                                                            │
│                                                                              │
│  cloudflared ──► Traefik (core-gateway, admin listener)                      │
│                   └──► admin-ui pod                                          │
│                         │  Authentik OIDC login (grp-admin check)           │
│                         │  4h session, refreshes while active               │
│                         │                                                    │
│                         │ server-side calls only — browser never touches     │
│                         │ internal APIs directly                             │
│                         │                                                    │
│                         ├──► orchestrator :8000  (workspace ops)            │
│                         ├──► litellm :4000       (friend key management)    │
│                         ├──► authentik :9000      (user provisioning)       │
│                         └──► open-webui :8080     (UI user management)      │
└─────────────────────────────────────────────────────────────────────────────┘
```

The Admin UI is a **server-side proxy**. Every internal API call originates from
the admin-ui backend process. The browser receives only what the Admin UI
explicitly returns — internal service URLs, credentials, and raw API responses
are never forwarded to the client.

---

## Responsibility boundary

### Admin UI owns
- **Friend API keys** — mint, revoke, reissue, view spend/usage, adjust
  budget and rate limits via LiteLLM `/key/*` endpoints
- **Authentik users** — create accounts, assign to groups (`grp-ui`,
  `grp-api`, `grp-workspaces`), deactivate/delete
- **Open WebUI accounts** — create, disable, delete
- **LiteLLM model configuration** — view configured models, update routing
- **Workspace visibility** — view active workspaces, their status, and
  resource usage via the orchestrator API
- **Workspace admin operations** — force-stop, deprovision (calls orchestrator)
- **Audit log** — every admin action logged with timestamp, operator identity,
  and outcome

### Orchestrator owns (Admin UI calls its API, never bypasses it)
- Workspace namespace creation and deletion (`ws-<sub>`)
- Workspace pod/deployment/service lifecycle
- PVC management (`home-<sub>`)
- Workspace-scoped LiteLLM key mint/revoke
- HTTPRoute and ReferenceGrant provisioning
- Hostname registry (`hostname_slug → sub`)

The orchestrator API is a **ClusterIP service with no public route**. It is
reachable only from within `llm-platform` via in-cluster DNS. It is never
exposed through cloudflared or through any HTTPRoute. See §Network isolation.

---

## Access model

### Layer 1 — Cloudflare Access (edge)
- Application: `admin.domain.com`, Self-hosted
- Policy: **Allow**, rule type **Emails** — list admin email addresses only
- Session: **4 hours**, with cookie refresh on active use
- Login method: Authentik OIDC (same IdP used by all other services)

### Layer 2 — Authentik OIDC (application)
- The Admin UI validates the OIDC token on every request
- Checks `groups` claim for `grp-admin` membership; rejects with 403 if absent
- Short-lived access tokens; refresh token bound to the CF Access session

Two independent gates: CF Access rejects unknown identities at the edge;
the app-level OIDC check ensures only `grp-admin` members reach any
admin function even if CF Access is misconfigured.

---

## Network isolation

### MicroK8s

The orchestrator service is ClusterIP only. These two policies work alongside
the default-deny baseline in llm-platform ([step 04 §8](04-deploy-stack-ubuntu.md))
— without default-deny, ingress and egress not covered here would remain
unrestricted.

```yaml
# assets/k8s/llm-platform/orchestrator-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: orchestrator-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app: orchestrator
  policyTypes: [Ingress, Egress]
  ingress:
  # Only the admin-ui pod may call the orchestrator API
  - from:
    - podSelector:
        matchLabels:
          app: admin-ui
    ports:
    - protocol: TCP
      port: 8000
  egress:
  # k8s API server — namespace/deployment/NetworkPolicy management
  # Verify ClusterIP: kubectl get svc kubernetes -n default -o jsonpath='{.spec.clusterIP}'
  # (MicroK8s default is 10.152.183.1; kubeadm default is 10.96.0.1)
  - to:
    - ipBlock:
        cidr: 10.152.183.1/32
    ports:
    - port: 443
      protocol: TCP
  # LiteLLM — workspace-scoped key mint and revoke
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-core
      podSelector:
        matchLabels:
          app: litellm
    ports:
    - protocol: TCP
      port: 4000
  # Authentik — OIDC token validation and user group lookups
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: server
    ports:
    - protocol: TCP
      port: 9000
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
---
# assets/k8s/llm-platform/admin-ui-policy.yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: admin-ui-policy
  namespace: llm-platform
spec:
  podSelector:
    matchLabels:
      app: admin-ui
  policyTypes: [Ingress, Egress]
  ingress:
  # Only Traefik may reach the Admin UI
  - from:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: traefik
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: orchestrator
    ports:
    - protocol: TCP
      port: 8000
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-core
      podSelector:
        matchLabels:
          app: litellm
    ports:
    - protocol: TCP
      port: 4000
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: llm-core
      podSelector:
        matchLabels:
          app: open-webui
    ports:
    - protocol: TCP
      port: 8080
  - to:
    - podSelector:
        matchLabels:
          app.kubernetes.io/name: authentik
          app.kubernetes.io/component: server
    ports:
    - protocol: TCP
      port: 9000
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

---

## Credentials the Admin UI holds

| Secret | Used for | Stored as |
|---|---|---|
| `LITELLM_MASTER_KEY` | Friend key management, model config, spend queries | k8s Secret (`secretKeyRef`) |
| Authentik admin API token | User creation, group assignment, deactivation | k8s Secret (`secretKeyRef`) |
| Open WebUI admin credentials | Account management | k8s Secret (`secretKeyRef`) |

The Admin UI does **not** hold the orchestrator API credential — in-cluster
network isolation is the access control for the orchestrator. If a token is
added in future, it would be stored the same way.

These secrets are distinct from the orchestrator's copy of `LITELLM_MASTER_KEY`.
The Admin UI's copy is scoped to friend/system operations; the orchestrator's
copy is used only for workspace-scoped key mint/revoke during launch and destroy.

---

## Operations exposed

### User provisioning
- **Add API friend**: create Authentik account → add to `grp-api` → mint
  LiteLLM virtual key (with budget, rpm limit, model allowlist) → display key
  once for the operator to communicate out-of-band
- **Add UI friend**: create Authentik account → add to `grp-ui` → (optional)
  create Open WebUI account
- **Add workspace user**: create Authentik account → add to `grp-workspaces`
  (workspace provisioned automatically at first login via orchestrator)
- **Deprovision any user**: remove from all groups → revoke LiteLLM key →
  call orchestrator deprovision → delete/disable Authentik account

### Key management
- View all active LiteLLM keys with owner, spend, remaining budget, last used
- Revoke a key immediately
- Reissue a new key for a friend (revoke old, mint new, display once)
- Adjust budget or rate limit on an existing key

### Workspace management (via orchestrator API)
- View all active workspaces: owner display name, hostname, status, resource usage
- Force-stop a workspace (scales deployment to 0)
- Deprovision a user's workspace (calls orchestrator deprovision flow)

### Audit log
Every action records: timestamp, authenticated admin (from OIDC sub), operation
type, target (user sub or key alias), and outcome. Logs are written to a
persistent volume and forwarded to the external Loki instance ([step 13](13-operations.md) monitoring).

---

## MicroK8s deployment

The Admin UI runs as a Deployment in `llm-platform` with a ClusterIP Service, an
HTTPRoute on `core-gateway` for `admin.domain.com`, and the `orchestrator-policy`
NetworkPolicy above. Non-OIDC config is plain env; every credential comes from a
Secret via `secretKeyRef` — never a literal `value:`. The image reference and
values below are illustrative (build your Admin UI image and push it to the
MicroK8s registry, as with inference — step 04 §5):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: admin-ui
  namespace: llm-platform
  labels:
    app: admin-ui
spec:
  replicas: 1
  selector:
    matchLabels:
      app: admin-ui
  template:
    metadata:
      labels:
        app: admin-ui
    spec:
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: admin-ui
        image: localhost:32000/admin-ui:latest   # pin to digest — step 04 §6
        ports:
        - containerPort: 8080
        env:
        - name: LITELLM_URL
          value: http://litellm.llm-core:4000
        - name: AUTHENTIK_URL
          value: http://authentik-server.llm-platform:9000
        - name: OPENWEBUI_URL
          value: http://open-webui.llm-core:8080
        - name: OIDC_ISSUER
          value: https://auth.domain.com/application/o/admin-ui/
        - name: REQUIRED_GROUP
          value: grp-admin
        - name: SESSION_DURATION_HOURS
          value: "4"
        - name: LITELLM_MASTER_KEY
          valueFrom: { secretKeyRef: { name: litellm-credentials, key: master-key } }
        - name: AUTHENTIK_TOKEN
          valueFrom: { secretKeyRef: { name: admin-ui-credentials, key: authentik-token } }
        - name: OPENWEBUI_ADMIN_KEY
          valueFrom: { secretKeyRef: { name: admin-ui-credentials, key: openwebui-admin-key } }
        - name: OIDC_CLIENT_ID
          valueFrom: { secretKeyRef: { name: admin-ui-credentials, key: oidc-client-id } }
        - name: OIDC_CLIENT_SECRET
          valueFrom: { secretKeyRef: { name: admin-ui-credentials, key: oidc-client-secret } }
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
---
apiVersion: v1
kind: Service
metadata:
  name: admin-ui
  namespace: llm-platform
spec:
  selector:
    app: admin-ui
  ports:
  - port: 8080
    targetPort: 8080
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: admin-ui
  namespace: llm-platform
spec:
  parentRefs:
  - name: core-gateway
    namespace: llm-platform
    sectionName: admin
  hostnames:
  - "admin.domain.com"
  rules:
  - backendRefs:
    - name: admin-ui
      port: 8080
```

---

## Security notes

- The Admin UI is the highest-privilege service in the stack after the host OS
  itself — it holds the LiteLLM master key and Authentik admin credentials.
  Keep it patched, monitored, and audited.
- All secrets are mounted via k8s Secrets (`secretKeyRef`) — never plaintext env
  literals readable from the pod spec by anything with `pods:get` (H-12 pattern).
- If the Admin UI is unavailable (cloudflared down, pod crash), fall back to
  Tailscale + direct curl to LiteLLM and Authentik admin APIs. Document the
  curl equivalents for each operation in the operations runbook (step 13).
- `grp-admin` should have the fewest members of any group — ideally only the
  server operator(s).

---

## Verification

- Navigate to `https://admin.domain.com`: CF Access login prompt appears; a
  non-`grp-admin` account is rejected at the CF edge.
- Log in with a `grp-admin` Authentik account: Admin UI dashboard loads.
- A `grp-ui`-only account that somehow passes CF Access is rejected with 403
  at the OIDC group check.
- Mint a new friend key: key appears in LiteLLM `/key/list` and is usable at
  `api.domain.com`; revoke it from the Admin UI and confirm 401 on the next
  inference call.
- Deprovision a workspace user: orchestrator destroy flow runs, namespace
  deleted, hostname slug released.
- All above operations appear in the audit log with correct operator identity.
