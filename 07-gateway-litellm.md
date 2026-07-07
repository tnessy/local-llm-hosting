# 07 — API gateway: LiteLLM

← [06 Models](06-models.md) · Next: [08 Open WebUI](08-webui-open-webui.md)

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

> **Security:** LiteLLM is never exposed for admin use. All admin operations
> (`/key/*`, `/user/*`, `/model/info`, `/health`) run through a local
> `kubectl port-forward`, which is gated by the Tailscale-restricted kube-apiserver
> ([step 09](09-connectivity-tailscale.md)). These paths are also blocked at the
> Cloudflare WAF on `api.domain.com` — see [step 10](10-connectivity-cloudflare.md).
> Never run admin calls against the public hostname.

## 1. Confirm it's running

Admin calls reach LiteLLM through a local port-forward. Leave this running in a
separate terminal for the rest of this step:

```bash
microk8s kubectl port-forward -n llm-core svc/litellm 4000:4000
```

Then, in another terminal:

```bash
curl -s http://localhost:4000/health
```

## 2. Mint the Open WebUI key

The master key is read from the Kubernetes Secret — it is never a host file or an
env literal:

```bash
LITELLM_MASTER_KEY=$(microk8s kubectl get secret litellm-credentials -n llm-core -o jsonpath='{.data.master-key}' | base64 -d)
```

Open WebUI authenticates to LiteLLM with its own virtual key:

```bash
curl -s http://localhost:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" -d '{"models":["coder","chat"],"key_alias":"open-webui"}'
```

Store the returned key in the `openwebui-credentials` Secret (seeded empty in
step 04 §3) and restart Open WebUI so it picks it up:

```bash
OPENWEBUI_LITELLM_KEY=sk-...        # the "key" value from the response above
microk8s kubectl patch secret openwebui-credentials -n llm-core --type merge -p "{\"stringData\":{\"litellm-key\":\"$OPENWEBUI_LITELLM_KEY\"}}"
microk8s kubectl rollout restart deploy/open-webui -n llm-core
```

## 3. Mint a key per API friend

One key each, with guardrails:

```bash
curl -s http://localhost:4000/key/generate -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" -d '{"models":["coder","chat"],"max_budget":20,"budget_duration":"30d","rpm_limit":60,"key_alias":"alice"}'
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
curl -s http://localhost:4000/v1/chat/completions -H "Authorization: Bearer <a-virtual-key>" -H "Content-Type: application/json" -d '{"model":"coder","messages":[{"role":"user","content":"say hi"}]}'
```

Returns a completion (after the cold-load on first hit). A bad/absent key returns
401 — confirming the gateway is enforcing auth.

## How LiteLLM is deployed

LiteLLM runs in the `llm-core` namespace, deployed in
[step 04 §8](04-deploy-stack-ubuntu.md) from
[`assets/k8s/llm-core/litellm.yaml`](assets/k8s/llm-core/litellm.yaml). Its config
comes from the `litellm-config` ConfigMap; the master key, salt key, and
`TABBY_API_KEY` come from the `litellm-credentials` / `tabby-credentials` Secrets
via `secretKeyRef`.

> **Credentials must use `secretKeyRef` — never literal `value:` fields.** The
> orchestrator (step 16) has cluster-wide `pods: get/list/watch`; any credential
> stored as a plain env var is readable from the pod spec without touching the
> Secrets API. Verify LiteLLM sources its credentials correctly:
>
> ```bash
> microk8s kubectl get pod -n llm-core -l app=litellm >   -o jsonpath='{.items[0].spec.containers[0].env}'
> # Every entry must show valueFrom.secretKeyRef — never a literal value field
> ```

→ Continue to [08 — Open WebUI](08-webui-open-webui.md).
