# Models — Add / Rename / Remove a served model

← [Maintenance index](README.md) · Setup refs: [05 Inference](../05-inference-tabbyapi-llamaswap.md) · [06 Gateway (LiteLLM)](../06-gateway-litellm.md) · [04 Deploy](../04-deploy-stack-ubuntu.md)

> **Overview:** Add a new model to the dropdown/API, rename one clients already
> use, or retire one — by editing the two config assets, re-creating their
> ConfigMaps, and reconciling the places a model **name** is referenced (virtual
> keys and client configs) so nothing 403s or vanishes mid-request.
>
> **Why a runbook:** a model isn't one setting — its **name** is a contract that
> appears in **four** places that fail independently: the `llama-swap-config`
> (engine), the `litellm-config` (gateway), every **virtual key's `models`
> allowlist** (step 06), and each **client config** (step 11). Add is
> low-risk; **rename is a breaking change** across all four. Doing it in order
> (and knowing the graceful alias trick) avoids "the key works but the model
> disappeared" support pings from friends.

## The two names (read this first)

A served model has **two** names, and they're often — but need not be — equal:

| Name | Where it's defined | Who sees it |
|---|---|---|
| **client-facing name** | LiteLLM `model_name` (`litellm-config.yaml`) | friends, virtual-key `models` lists, client configs, Open WebUI dropdown |
| **engine name** | llama-swap model key (`llama-swap-config.yaml`) **and** LiteLLM `model: openai/<engine-name>` | internal only — never leaves the cluster |

LiteLLM maps *client-facing* → *engine*: a request for `model_name` is forwarded
to `openai/<engine-name>` at `http://inference:8080/v1`. In the shipped config
they're identical (`coder`→`openai/coder`), but the split is the key to a
**zero-downtime rename** (§ Rename below): change the client-facing name while the
engine name — and the loaded weights — stay put.

> **Disk folder is a *third*, separate string.** llama-swap's `--model-name
> <folder>` is the directory under `/srv/models`, not the served name. Renaming a
> served model never requires touching weights on disk.

## Scenarios

| Scenario | Touches | Sections |
|---|---|---|
| **Add** a model | new weights + both configs + keys + clients | 1 → 6 |
| **Rename** a served model | both configs (or just gateway) + keys + clients | Rename |
| **Remove** a model | both configs + keys | Remove |

> **Placeholders:** `<host>` (server), `<engine-name>` (internal model key, e.g.
> `coder`), `<client-name>` (what friends request — usually the same), `<folder>`
> (weights dir under `/srv/models`), `<port>` (unique loopback port for the
> backend). Record the real values for this run in `deployments/<host>.md`.

Both config assets are **generic**; the ConfigMap is rebuilt from the asset on
every change, so **edit the repo asset, not the live ConfigMap** — an imperative
`kubectl edit` is reverted on the next `apply` and drifts from git.

---

## Add a model

### 1. Check it fits (VRAM tier)

Before downloading anything, confirm the model + quant fits alongside what's
already resident — see the VRAM tiers and sizing table in
[step 05 §1](../05-inference-tabbyapi-llamaswap.md#1-pick-models-by-vram). On a
single-GPU box only **one model is resident at a time** by default; a new model
doesn't cost VRAM until it's requested (llama-swap loads on demand, unloads after
`ttl`). To keep two loaded **simultaneously**, VRAM must hold both — use a
llama-swap **group** ([step 05 §3](../05-inference-tabbyapi-llamaswap.md#3-wire-the-models-into-llama-swap)).

Record the target's params/quant and the idle/loaded VRAM you expect in
`deployments/<host>.md`.

### 2. Download the weights

On the **host** (not in-pod — the download uses the `hf` CLI over the host
network, so no NetworkPolicy change is needed), pull the EXL2 folder into the
model store, per [step 05 §2](../05-inference-tabbyapi-llamaswap.md#2-download-exl2-weights-to-the-model-store):

```bash
hf download <org>/<model-exl2> --local-dir /srv/models/<folder>
# add --revision <bpw> if the repo publishes each bit-rate as a branch
```

Confirm disk headroom first (`df -h /srv/models`) — EXL2 folders are many GB.
Model weights are **not** in the step-13 backup (they're re-downloadable by
design), so no backup change is needed.

### 3. Add the engine entry (llama-swap)

Edit [`assets/llama-swap-config.yaml`](../assets/llama-swap-config.yaml): add a
model block keyed by `<engine-name>`, pointing at the new `<folder>` on a **unique
loopback `<port>`** (each backend needs its own — `5001`, `5002`, next is `5003`…):

```yaml
  "<engine-name>":
    cmd: >
      python3 /app/main.py
      --model-dir /models
      --model-name <folder>
      --max-seq-len <ctx>
      --disable-auth true
      --host 127.0.0.1 --port <port>
    proxy: "http://127.0.0.1:<port>"
    checkEndpoint: "/health"
```

Size `--max-seq-len` to VRAM after the weights load — it's the **#1 knob** for
usable coding ([step 05 §3 tuning](../05-inference-tabbyapi-llamaswap.md#3-wire-the-models-into-llama-swap)).

### 4. Add the gateway entry (LiteLLM)

Edit [`assets/litellm-config.yaml`](../assets/litellm-config.yaml): add a
`model_list` entry. Keep the `extra_body.stream_options.include_usage` block —
without it TabbyAPI emits no `usage` and LiteLLM budgets/rate-limits under-count
this model ([step 05 token-metering](../05-inference-tabbyapi-llamaswap.md)):

```yaml
  - model_name: <client-name>          # what clients request
    litellm_params:
      model: openai/<engine-name>      # must match the llama-swap key from §3
      api_base: http://inference:8080/v1
      api_key: os.environ/TABBY_API_KEY
      extra_body:
        stream_options:
          include_usage: true
```

### 5. Apply — rebuild ConfigMaps + restart

Editing the assets alone has no effect on running pods; rebuild each ConfigMap
from its asset and restart the consumer ([step 04 "Editing config later"](../04-deploy-stack-ubuntu.md)):

```bash
microk8s kubectl create configmap llama-swap-config -n llm-core --from-file=llama-swap-config.yaml=assets/llama-swap-config.yaml --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl create configmap litellm-config -n llm-core --from-file=litellm-config.yaml=assets/litellm-config.yaml --dry-run=client -o yaml | microk8s kubectl apply -f -
microk8s kubectl rollout restart deploy/inference -n llm-core
microk8s kubectl rollout restart deploy/litellm   -n llm-core
```

Confirm LiteLLM now lists the model (admin path is a Tailscale-gated port-forward,
never the public host — [step 06 §1](../06-gateway-litellm.md#1-confirm-its-running)):

```bash
microk8s kubectl port-forward -n llm-core svc/litellm 4000:4000   # separate terminal
curl -s http://localhost:4000/v1/models | grep <client-name>
```

### 6. Grant access — keys + clients

A model exists but no one can call it until a **virtual key's `models` allowlist**
includes it — keys embed their allowlist at mint time and do **not** pick up new
models automatically:

- **Open WebUI** (so it shows in the dropdown for everyone): the `open-webui` key's
  `models` list must include `<client-name>`. Update it, or re-mint and re-patch
  the `openwebui-credentials` Secret, then restart Open WebUI
  ([step 06 §2](../06-gateway-litellm.md#2-mint-the-open-webui-key)):
  ```bash
  curl -s http://localhost:4000/key/update -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H "Content-Type: application/json" -d '{"key":"sk-<open-webui-key>","models":["coder","chat","<client-name>"]}'
  ```
  (`LITELLM_MASTER_KEY` from the Secret — [step 06 §2](../06-gateway-litellm.md#2-mint-the-open-webui-key).)
- **Per-friend API keys** that should reach the new model: `/key/update` each one's
  `models` list the same way (or mint new keys). Keys you don't update simply can't
  see it — which is a fine way to gate a model to a subset of friends.
- **Clients** (step 11): friends point their tool at `<client-name>` (e.g.
  `aider --model openai/<client-name>`). Nothing to change for existing models.

**Done check:** a chat via Open WebUI **and** an API call with a real key both hit
`<client-name>`; `nvidia-smi` shows it load on first request and free after `ttl`
([step 12](../12-verification.md)).

---

## Rename a served model

The name is a contract in four places. Which you touch depends on **which** name
changes.

### Case A — rename only the client-facing name (recommended, zero-downtime)

The weights and engine stay loaded; you only relabel what clients request. **No
inference restart, no cold reload.**

1. In [`assets/litellm-config.yaml`](../assets/litellm-config.yaml), change
   `model_name:` to the new name but **leave `model: openai/<engine-name>`
   unchanged**.
2. **Graceful window (avoid breaking live keys/clients):** instead of an in-place
   rename, *add* a second `model_list` entry with the new `model_name` pointing at
   the **same** `openai/<engine-name>`. Now both old and new names work.
3. Rebuild the `litellm-config` ConfigMap + restart **litellm only** (§5 above,
   litellm lines).
4. Migrate consumers to the new name: `/key/update` each key's `models` list
   (add new, then drop old), and have friends update their client `--model`.
5. Once nothing uses the old name (watch spend/logs), remove the old entry and
   re-apply.

### Case B — rename the engine name too

Only needed if you want the internal key tidy; it forces a reload.

1. Change the key in [`assets/llama-swap-config.yaml`](../assets/llama-swap-config.yaml)
   **and** the matching `model: openai/<engine-name>` in
   [`assets/litellm-config.yaml`](../assets/litellm-config.yaml) — the two must
   stay equal or LiteLLM routes to a non-existent backend (404 from the engine).
2. Rebuild **both** ConfigMaps + restart **both** deployments (§5). The model
   cold-loads on next request.
3. Reconcile client-facing name + keys + clients as in Case A if the client-facing
   name also changed.

> **Open WebUI chat history:** existing conversations pinned to the old
> client-facing name show "model not found" if you drop the old name. Keep the old
> `model_name` as an alias (Case A step 2) until histories age out, or accept the
> cosmetic break. New chats use the new name from the dropdown once the
> `open-webui` key lists it.

---

## Remove a model

1. Delete its block from **both** [`llama-swap-config.yaml`](../assets/llama-swap-config.yaml)
   and [`litellm-config.yaml`](../assets/litellm-config.yaml).
2. Rebuild both ConfigMaps + restart both deployments (§5).
3. `/key/update` any keys whose `models` list named it (optional — LiteLLM just
   rejects requests for a model it no longer serves, but tidying the allowlists
   keeps `/key/info` honest).
4. Reclaim disk only when sure: `rm -rf /srv/models/<folder>` (re-downloadable, not
   backed up). Keep the folder until the removal has stuck for a few days.

---

## Rollback

Every change here is config, so rollback is `git`-clean:

1. `git checkout` the previous `assets/llama-swap-config.yaml` /
   `assets/litellm-config.yaml`.
2. Rebuild the affected ConfigMap(s) and restart the deployment(s) (§5).
3. Revert any `/key/update` allowlist edits (re-add the old model names).
4. Re-verify a chat + an API call against the model that used to work.

Downloaded weights are harmless if left in place; a half-added model that was
never referenced by a live key is invisible to friends.

## Document the result

Record in `deployments/<host>.md`: the model's client-facing + engine names, HF
repo + `<folder>` + quant/bpw, `<port>`, `--max-seq-len`, its idle/loaded VRAM
figures, which keys were granted access, and — for a rename — the old→new mapping
and the date the alias was removed. That entry is the reference for the next model
change.
