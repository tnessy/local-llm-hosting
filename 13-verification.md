# 13 — Verification (end-to-end)

← [12 Clients](12-clients.md) · Next: [14 Operations](14-operations.md)

Run these after the stack is up and models are loaded. Each persona's happy path
plus the negative tests that prove the restrictions hold.

## Happy paths

### UI friend
- [ ] `https://llm.domain.com` → Cloudflare login (Google/OTP) succeeds.
- [ ] Open WebUI login works; chat returns a reply.
- [ ] Model dropdown switch works (observe a brief cold-load, then speed).

### Coder friend
- [ ] **Aider**: `aider --model openai/coder` against `api.domain.com` completes a
      small multi-file edit.
- [ ] **Continue**: chat + inline autocomplete work in the IDE.
- [ ] **Codex** (Responses) returns output.
- [ ] **Claude Code** (Anthropic via LiteLLM) returns output.

### Admin
- [ ] SSH reachable over **Tailscale**.
- [ ] `docker exec -it inference nvidia-smi` sees the GPU.

## Negative tests (the important ones)

- [ ] A **non-allowlisted email** is rejected at the Cloudflare edge for
      `llm.domain.com` (never reaches Open WebUI).
- [ ] An API call to `api.domain.com` with a **bad/absent key** returns **401**
      from LiteLLM.
- [ ] A **revoked** key (step 06 `key/delete`) stops working immediately.
- [ ] The **inference engine port is unreachable** from the LAN:
      from a LAN host, `curl http://<server-ip>:8080/v1/models` fails/refuses
      (only `127.0.0.1:3000` for Open WebUI is bound locally; nothing else).
- [ ] Host UI / SSH are **not** reachable from a device that is neither on the
      tailnet nor allow-listed in Cloudflare.
- [ ] No inbound ports are forwarded on the router (verify router config).

## Resource / behavior checks

- [ ] During a chat, `nvidia-smi` shows the model loaded; after `ttl` idle, it
      unloads (VRAM frees).
- [ ] A second concurrent request **queues** rather than erroring (single-user
      engine + llama-swap/LiteLLM queueing).

If all boxes are checked, the system meets the design intent: friends reach only
what they should, the engine is private, and admin is Tailscale-only.

→ Continue to [14 — Operations](14-operations.md).
