# 07 — Web UI: Open WebUI

← [06 LiteLLM](06-gateway-litellm.md) · Next: [08 Tailscale](08-connectivity-tailscale.md)

> **Overview:** Configure Open WebUI as the browser chat interface — create the admin account, disable open signup, and confirm the LiteLLM backend connection before the UI is publicly exposed.
>
> **Why:** The first account created becomes admin. Open signup must be disabled before step 09 exposes the URL publicly — one wrong setting here allows anonymous account creation by anyone with the link.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `OPENWEBUI_LITELLM_KEY` | LiteLLM virtual key for Open WebUI's backend connection | Minted and patched into the `openwebui-credentials` Secret in [step 06 §2](06-gateway-litellm.md) |

Open WebUI (decision **D6**) is the browser chat UI for non-technical friends and
your **application-layer auth boundary** (accounts + signup disabled), sitting
behind Cloudflare Access.

It's already wired to LiteLLM by the
[`open-webui.yaml`](assets/k8s/llm-core/open-webui.yaml) manifest:
`OPENAI_API_BASE_URL=http://litellm.llm-core:4000/v1` with the key from
[step 06](06-gateway-litellm.md).

## 1. First-run admin account

1. Reach the UI via a local port-forward (it isn't public until
   [step 09](09-connectivity-cloudflare.md)):
   ```bash
   microk8s kubectl port-forward -n llm-core svc/open-webui 3000:8080
   ```
   Then browse to `http://localhost:3000`.
2. The **first account you create becomes the admin** — this is you.

## 2. Lock down signup

The `open-webui.yaml` manifest already sets `ENABLE_SIGNUP=false`, so no one can
self-register. Confirm under **Admin Panel → Settings → Authentication** that new
sign-ups are disabled and default role is `user`.

## 3. Create friend accounts

**Admin Panel → Users → Add User** for each UI friend (email + initial
password). Keep them role `user`, not `admin`.

> Two layers of auth now protect the UI: Cloudflare Access (edge identity, step
> 08) **and** these Open WebUI accounts.

## 4. Confirm the models appear

The model dropdown should list `coder` and `chat` (served via LiteLLM →
llama-swap). If empty:
- check `OPENWEBUI_LITELLM_KEY` is set and valid,
- **Admin Panel → Settings → Connections** shows the OpenAI connection to
  `http://litellm.llm-core:4000/v1`,
- models exist (after [step 05](05-inference-tabbyapi-llamaswap.md)).

## 5. (Optional) image generation

If you add ComfyUI ([step 10](10-optional-comfyui-tabby.md)): **Admin Panel →
Settings → Images**, set engine to ComfyUI, base URL `http://comfyui:8188`. UI
friends can then generate images from chat.

## Verification

- Logging in as a non-admin friend works; that user **cannot** see the admin
  panel.
- Sending a message returns a reply (first one triggers a model cold-load).
- A logged-out browser cannot reach any chat.

→ Continue to [08 — Connectivity: admin (Tailscale)](08-connectivity-tailscale.md).
