# 14 — Operations

← [13 Verification](13-verification.md) · [Back to README](README.md)

Keeping the box healthy, secure, and recoverable.

## Backups (do these)

Two stateful volumes hold the crown jewels:

- **`openwebui-data`** — user accounts, per-user keys, chat history.
- **`litellm-db`** — virtual keys, budgets, spend.

Back them up on a schedule (cron + `tar`, or `restic` for incremental):

```bash
docker run --rm -v home-llm_openwebui-data:/d -v /srv/backups:/b \
  alpine tar czf /b/openwebui-$(date +%F).tgz -C /d .
docker run --rm -v home-llm_litellm-db:/d -v /srv/backups:/b \
  alpine tar czf /b/litellm-$(date +%F).tgz -C /d .
```

Models themselves don't need backup (re-downloadable), but keep a note of which
EXL2 folders you used.

## Updates

- **Containers:** pull and recreate periodically:
  ```bash
  docker compose pull && docker compose up -d
  docker compose build --pull inference   # rebuild engine image (new llama-swap/TabbyAPI)
  ```
  Pin to known-good tags if a release breaks dialect translation; test Aider +
  Codex + Claude Code after engine/LiteLLM updates.
- **Host OS / NVIDIA driver:** `sudo apt upgrade` keeps both current. After a
  driver update re-run `docker exec -it inference nvidia-smi` to confirm the
  container still sees the GPU.

## Key & access hygiene

- **Rotate** the per-friend LiteLLM keys periodically; revoke immediately when
  someone no longer needs access (`/key/delete`).
- **Cloudflare allowlist** is the other half — remove a departed friend's email
  from the `llm.` Access policy.
- Keep `LITELLM_MASTER_KEY` and `.env` secret; never commit `.env`.
- Tailscale: review devices; the server node has key-expiry disabled, your
  personal devices should keep expiry on.

## Monitoring

- `docker logs -f inference` — model load/unload + errors.
- `docker logs -f litellm` — auth failures, spend, rate-limits.
- LiteLLM `/key/info?key=...` — per-friend spend/usage.
- Cloudflare Zero Trust logs — who authenticated, what was blocked at the edge.
- `nvidia-smi -l 2` — live VRAM/utilization while tuning context/models.

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Model "dumb"/forgets context | `--max-seq-len` too small | Raise it (step 10), watch VRAM |
| 524 from Cloudflare | Long non-streamed response | Ensure streaming; for SD use ComfyUI queue API |
| 401 on API | Bad/expired virtual key | Re-issue (step 06) |
| Engine has no models | llama-swap placeholders not filled | Step 10 |
| GPU not seen in container | Driver/compose GPU stanza | Steps 02/04 |
| Slow first response | Cold model load (expected) | Raise `ttl`; keep model warm |

## Changing a decision later

See the **Decisions log** in the [README](README.md). Each decision links to its
step file; because LiteLLM fronts the backend, swapping the engine or models
needs no client changes.
