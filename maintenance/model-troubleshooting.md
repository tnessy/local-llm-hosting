# Troubleshooting a model that won't deploy

← [Maintenance index](README.md) · Add/rename/remove: [models.md](models.md) · Setup ref: [05 Inference](../05-inference-tabbyapi-llamaswap.md)

When a newly-wired EXL3/EXL2 model 500s or never becomes ready on the TabbyAPI +
llama-swap stack. Generic — record host-specific values/outcomes in your
`deployments/<host>.md`.

> **First, know where your config lives.** If a host's `assets/*.yaml` were never
> localized (still generic `<placeholder>` names), the **live ConfigMap is the source of
> truth** — do NOT rebuild the ConfigMap from the asset (it would overwrite the running
> models). Reconcile from the live ConfigMap instead:
> `kubectl get configmap llama-swap-config -n llm-core -o "jsonpath={.data.llama-swap-config\.yaml}" > ~/live-llama-swap.yaml`,
> edit that, then `kubectl create configmap … --from-file=llama-swap-config.yaml=~/live-llama-swap.yaml --dry-run=client -o yaml | kubectl apply -f -`.

## Step 0 — get the REAL error (do this first, every time)

llama-swap runs each backend as a child process and **does not forward the child's
stderr to the container log** — through the gateway you only ever see
`500 … upstream command exited prematurely`, and in `kubectl logs deploy/inference` only
llama-swap's own `proxy error: dial tcp …: connection refused` + `exited prematurely`.
That is *not* the cause. Capture the real traceback by running the exact backend command
directly (bypasses llama-swap):

```bash
microk8s kubectl exec deploy/inference -n llm-core -- \
  timeout 120 python3 /app/main.py --model-dir /models --model-name <folder> \
  --max-seq-len <ctx> --cache-mode Q4 --disable-auth true --host 127.0.0.1 --port 5099 2>&1 | tail -60
```

- **Direct run shows a traceback** → match it to the ladder below.
- **Direct run loads + serves, but the gateway 500s** → it's the **stderr-pipe** issue (row 4).

If the backend is launched via the `tabby-run.sh` wrapper, its output is already in a file:
`kubectl exec deploy/inference -- tail -60 /tmp/tabby-<port>.log`.

## Causes → fixes

| Symptom in the direct run | Cause | Fix |
|---|---|---|
| `architectures … not supported` / AttributeError while building the model | Arch not in this ExLlamaV3 build | `grep -A1 architectures <folder>/config.json` and compare to ExLlamaV3's supported-arch list. Newer arch → newer exllamav3 (image rebuild), or it isn't supported yet. |
| `gcc … Python.h: No such file` / `triton … CalledProcessError` at load | **Triton JIT** can't compile its CUDA kernels (missing Python dev headers) | Image needs `python3.12-dev` (in `assets/inference/Dockerfile`). Confirm: `kubectl exec deploy/inference -- ls /usr/include/python3.12/Python.h`. Hits Triton-kernel archs — **Gated-DeltaNet (Qwen 3.5)**, **paged-attention (Gemma 4)**. Precompiled-kernel archs (Phi, GLM-4, Qwen2/2.5) are unaffected. apt can't run *in* the pod (restricted secctx denies `setgroups`) — rebuild on the host. |
| `TemplateSyntaxError … 'generation'` → "Chat completions are disabled" (loads, but chat 500s) | Chat template uses the `{% generation %}` Jinja tag TabbyAPI can't compile | Strip it (a no-op for inference): edit `<folder>/tokenizer_config.json` (back up `.orig`), `re.sub(r"{%-?\s*(?:end)?generation\s*-?%}", "", chat_template)`. Or drop a clean `chat_template.jinja` in the folder. |
| Direct run loads + serves, but the **gateway** says "exited prematurely" | llama-swap's **undrained stderr pipe** fills during a verbose load and the child blocks/dies (~4 s) | Launch via the redirect wrapper: `cmd: bash /usr/local/bin/tabby-run.sh <main.py args>` (`assets/inference/tabby-run.sh`, baked into the image). |
| `CUDA out of memory` during load | Context too large for VRAM | Lower `--max-seq-len`. Linear-attn (Qwen 3.5) is cheap per token; standard-attn (Gemma/Phi/Llama/GLM) costs much more. |
| Load rejects `--cache-mode Q4` | Cache mode unsupported for this model | Drop the flag (FP16 cache) and lower `--max-seq-len` to fit. |
| Gateway 404 for a model that "exists" | llama-swap key ≠ LiteLLM `model: openai/<name>` target | Make them byte-identical. (`model_name` may differ; the **`openai/` target must equal the llama-swap key**.) |

## Tool calls print as raw text instead of executing

Model loads and serves chat fine, but a tool call comes back as literal text in the
response instead of executing — e.g. Gemma-4: `<|tool_call>call:list_knowledge{}<tool_call|>`;
Qwen3-Coder/Qwen3.5: `<tool_call>\n<function=list_knowledge_bases>\n</function>\n</tool_call>`.
This looks like an Open WebUI bug — toggling Function Calling Default→Native→Default is
a widely-cited workaround for Gemma-4 specifically (open-webui/open-webui#23863) — but it
doesn't fix this variant.

**Cause:** TabbyAPI only parses a model's tool-call output into a structured `tool_calls`
response if `tool_format` is explicitly set **per model** — it's not auto-detected from the
chat template, and it can't be passed via the `--model-name ...` CLI flags in
`tabby-run.sh`/llama-swap's `cmd:`. Without it the model attempts the call fine, but
TabbyAPI passes the raw completion straight through unparsed. The break is entirely
server-side — Open WebUI never gets a usable response to parse.

**Fix:** drop a `tabby_config.yml` inside the model's own directory (in-pod mount path
varies by host — confirm with `kubectl exec deploy/inference -n llm-core -- ls /models`;
e.g. surtr mounts at `/models`, not the generic `/srv/models` used elsewhere in this doc).
No in-pod editor, so copy one of the versioned templates in
[`assets/inference/`](../assets/inference/) straight in — `tabby_config-gemma4.yml` for
Gemma-4 (12B/31B-it), `tabby_config-qwen3_coder.yml` for Qwen3-Coder/Qwen3.5 (aliases
`qwen3_5`, `step3_5`, `step3_7`):

```bash
POD=$(microk8s kubectl get pods -n llm-core -l app=inference -o jsonpath='{.items[0].metadata.name}')
microk8s kubectl cp assets/inference/tabby_config-<family>.yml \
  llm-core/$POD:/models/<folder>/tabby_config.yml
microk8s kubectl rollout restart deploy/inference -n llm-core
```

Read at model-load time only — a currently-loaded process won't pick it up without a
reload/restart. Full family list: TabbyAPI wiki, "10. Tool Calling".

Confirmed fixes (2026-07-12): `gemma-4-12b-it-exl3-4.50bpw` and `gemma-4-31b-it-exl3-4.00bpw`
→ `tabby_config-gemma4.yml`; Qwen3-Coder/Qwen3.5 models → `tabby_config-qwen3_coder.yml`.

## Reading the signals

- **`500` + `nvidia-smi` ≈ 9 MiB used** = the backend **crashed before allocating** (arch /
  Triton / template / pipe) — **not** OOM. OOM instead shows VRAM climbing during load, then
  the error.
- **curl `HTTP 000`** = curl timed out (`--max-time`) or the **port-forward died**
  (restarting `litellm` kills any `kubectl port-forward` to it) — not a model failure.
- A request logged as `1h40m … 200 0` = llama-swap kept retrying a crash-looping backend
  long after curl gave up; `rollout restart deploy/inference` clears the retry state.
- Watch `kubectl get pods -n llm-core` for a stuck old pod (`ContainerStatusUnknown`) after a
  rollout; force-delete it so it can't confuse things.

## Escalation ladder (cheapest first)

1. **Config-only** (name/port/context/cache flag) → re-apply the ConfigMap, no rebuild.
2. **Model-data** (chat-template strip, `tabby_config.yml` for `tool_format`) → edit/add
   files under the model's folder, no rebuild.
3. **Wrapper** (`tabby-run.sh`) → already in the image; use it in the `cmd:`.
4. **Image rebuild** (new exllamav3 / new system dep) → edit `assets/inference/Dockerfile`,
   `sudo docker build … -t localhost:32000/home-llm-inference:<tag> assets/inference/`, push,
   `kubectl set image deploy/inference inference=…`, then re-verify.

## Document the result

Record the model, the failure mode, and the fix in `deployments/<host>.md` so the next
deploy is faster. Rollback = re-apply the pre-change ConfigMap snapshot + `rollout restart`.
