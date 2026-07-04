# 06 — API gateway: LiteLLM

← [05 Inference](05-inference-tabbyapi-llamaswap.md) · Next: [07 Open WebUI](07-webui-open-webui.md)

> **Overview:** Configure LiteLLM as the single API gateway — issue a virtual key per friend with spend limits and model allowlists, enable dialect translation so Codex (Responses API) and Claude Code (Anthropic Messages) route to the OpenAI-compatible inference engine, and wire up the LiteLLM admin UI.
>
> **Why:** LiteLLM is the authentication and isolation boundary between all external clients and the inference engine. Every client gets their own revocable key with a budget ceiling — the master key is never distributed to friends.

LiteLLM (decision **D5**) is the single API front door. It:

- issues a **virtual key per friend**, each with budget / rate-limit / model
  allowlist,
- translates dialects so **Codex** (Responses API) and **Claude Code**
  (Anthropic Messages) work against the OpenAI-compatible engine,
- routes every model to `http://inference:8080/v1` (llama-swap).

Config: [`assets/litellm-config.yaml`](assets/litellm-config.yaml).

> **Security:** All admin operations (`/key/*`, `/user/*`, `/model/info`,
> `/health`) must be performed **via Tailscale only** (direct to
> `http://<server>:4000` on the tailnet). These paths are blocked at the
> Cloudflare WAF on `api.domain.com` — see [step 08](08-connectivity-cloudflare.md).
> Never run admin calls against the public hostname.

## 1. Confirm it's running

```bash
# Run from your Tailscale-connected machine or directly on the server
curl -s http://<server>:4000/health
```

## 2. Mint the Open WebUI key

Open WebUI authenticates to LiteLLM with its own virtual key:

```bash
curl -s http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"models":["coder","chat"],"key_alias":"open-webui"}'
```

Open `.env` with a text editor and add the returned key as `OPENWEBUI_LITELLM_KEY`
(use an editor, not shell redirection — shell substitution persists the value in history):

```bash
nano /opt/home-llm/.env             # add: OPENWEBUI_LITELLM_KEY=sk-...
docker compose up -d open-webui     # restart so it picks up the key
```

## 3. Mint a key per API friend

One key each, with guardrails:

```bash
curl -s http://localhost:4000/key/generate \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "models": ["coder","chat"],
        "max_budget": 20,
        "budget_duration": "30d",
        "rpm_limit": 60,
        "key_alias": "alice"
      }'
```

Give each friend their `sk-...` key (used in [step 12](12-clients.md)).

- **Revoke:** `POST /key/delete` with `{"keys":["sk-..."]}`.
- **Inspect spend:** `GET /key/info?key=sk-...`.
- **Allowlist:** `models` restricts which models that key may call.

## 4. Dialect endpoints (used by clients in step 12)

LiteLLM exposes, on `https://api.domain.com`:

| Dialect | Path | Used by |
|---|---|---|
| OpenAI Chat Completions | `/v1/chat/completions` | Continue, opencode, JetBrains, most |
| OpenAI Responses | `/v1/responses` | Codex |
| Anthropic Messages | `/v1/messages` | Claude Code |

All authenticate with the same per-friend virtual key.

## Verification

```bash
curl -s http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer <a-virtual-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"coder","messages":[{"role":"user","content":"say hi"}]}'
```

Returns a completion (after the cold-load on first hit). A bad/absent key returns
401 — confirming the gateway is enforcing auth.

## MicroK8s deployment (llm-core namespace)

When running in MicroK8s, LiteLLM lives in the `llm-core` namespace. Credentials
**must** use `secretKeyRef` — never literal `value:` fields. The orchestrator
has cluster-wide `pods: get/list/watch`; any credential stored as a plain env
var is readable from the pod spec without touching the Secrets API.

```bash
# Create the Secret first — fill in real values
microk8s kubectl create secret generic litellm-credentials \
  --namespace llm-core \
  --from-literal=master-key=sk-$(openssl rand -hex 32) \
  --from-literal=salt-key=$(openssl rand -hex 32)
```

```yaml
# assets/k8s/llm-core/litellm-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: litellm
  namespace: llm-core
spec:
  replicas: 1
  selector:
    matchLabels:
      app: litellm
  template:
    metadata:
      labels:
        app: litellm
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        seccompProfile:
          type: RuntimeDefault
      containers:
      - name: litellm
        image: ghcr.io/berriai/litellm:main-latest
        args: ["--config", "/app/config.yaml"]
        ports:
        - containerPort: 4000
        env:
        - name: LITELLM_MASTER_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-credentials
              key: master-key
        - name: LITELLM_SALT_KEY
          valueFrom:
            secretKeyRef:
              name: litellm-credentials
              key: salt-key
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: config
          mountPath: /app/config.yaml
          subPath: litellm-config.yaml
          readOnly: true
      volumes:
      - name: config
        configMap:
          name: litellm-config
---
apiVersion: v1
kind: Service
metadata:
  name: litellm
  namespace: llm-core
spec:
  selector:
    app: litellm
  ports:
  - port: 4000
    targetPort: 4000
```

```bash
microk8s kubectl apply -f assets/k8s/llm-core/litellm-deployment.yaml

# Verify credentials are sourced from the Secret, not inline
microk8s kubectl get pod -n llm-core -l app=litellm -o jsonpath='{.items[0].spec.containers[0].env}'
# Output must show valueFrom.secretKeyRef entries — never a literal value field
```

→ Continue to [07 — Open WebUI](07-webui-open-webui.md).
