# 04a — Deploy the container stack (Unraid)

← [03a Storage (Unraid)](03a-storage-unraid.md) · Next: [05 Inference](05-inference-tabbyapi-llamaswap.md) · Alt: [04b TrueNAS](04b-deploy-stack-truenas.md)

Deploy the stack defined in [`assets/docker-compose.yml`](assets/docker-compose.yml)
using Compose Manager.

## 1. Stage the project files on the server

Copy the whole `docs/assets/` folder to the server, e.g. `/boot/config/home-llm/`
or an appdata path like `/mnt/user/appdata/home-llm/`. You need:

```
home-llm/
  docker-compose.yml
  .env                      # created from .env.example (next step)
  llama-swap-config.yaml
  litellm-config.yaml
  inference/Dockerfile
```

## 2. Create and fill `.env`

```bash
cd /mnt/user/appdata/home-llm
cp .env.example .env
# generate secrets:
openssl rand -hex 32   # use for TABBY_API_KEY, LITELLM_SALT_KEY, WEBUI_SECRET_KEY
```

Fill `.env`:
- `CF_TUNNEL_TOKEN` — from [step 01](01-prerequisites.md).
- `LITELLM_MASTER_KEY` — set to `sk-` + a random hex.
- `OPENWEBUI_LITELLM_KEY` — leave blank for now; you'll mint it in
  [step 06](06-gateway-litellm.md), then add it and restart `open-webui`.

## 3. Point the `models` volume at NVMe

Edit `docker-compose.yml` so the `models` volume uses the share from
[step 03a](03a-storage-unraid.md). Replace the named volume with a bind mount:

```yaml
    volumes:
      - ./llama-swap-config.yaml:/app/config.yaml:ro
      - /mnt/nvme/models:/models
```

## 4. Add the project in Compose Manager

1. **Settings → Compose Manager → Add New Stack** → name `home-llm`.
2. Set its directory to your `home-llm/` folder (or paste the compose content).
3. **Compose Up**. First run builds the `inference` image (a few minutes) and
   pulls the others.

## 5. Confirm the GPU is visible inside the engine

```bash
docker exec -it inference nvidia-smi
```

You should see the GPU **inside** the container. If not, recheck the Nvidia
Driver plugin ([step 02a](02a-host-os-unraid.md)) and the `deploy.resources`
GPU stanza in compose.

## Verification

- `docker ps` shows `inference`, `litellm`, `open-webui`, `cloudflared` up.
- `docker exec -it inference nvidia-smi` sees the GPU.
- `curl -s http://localhost:3000` returns the Open WebUI page (local only).

→ Continue to [05 — Inference](05-inference-tabbyapi-llamaswap.md).
