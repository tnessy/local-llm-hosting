# 04b — Deploy the container stack (HexOS / TrueNAS)

← [03b Storage (TrueNAS)](03b-storage-truenas.md) · Next: [05 Inference](05-inference-tabbyapi-llamaswap.md) · Alt: [04a Unraid](04a-deploy-stack-unraid.md)

Deploy the stack in [`assets/docker-compose.yml`](assets/docker-compose.yml). Two
paths — the **compose CLI** (simplest, recommended) or the **custom app** UI.

## 1. Stage the project files

Via SSH, copy `docs/assets/` into a dataset path, e.g.
`/mnt/nvme/apps/home-llm/`:

```
home-llm/
  docker-compose.yml
  .env
  llama-swap-config.yaml
  litellm-config.yaml
  inference/Dockerfile
```

## 2. Create and fill `.env`

```bash
cd /mnt/nvme/apps/home-llm
cp .env.example .env
openssl rand -hex 32     # for TABBY_API_KEY, LITELLM_SALT_KEY, WEBUI_SECRET_KEY
```

Set `CF_TUNNEL_TOKEN`, `LITELLM_MASTER_KEY` (`sk-`+hex). Leave
`OPENWEBUI_LITELLM_KEY` blank until [step 06](06-gateway-litellm.md).

## 3. Point the `models` volume at the SSD dataset

Edit `docker-compose.yml` to bind-mount the dataset from
[step 03b](03b-storage-truenas.md):

```yaml
    volumes:
      - ./llama-swap-config.yaml:/app/config.yaml:ro
      - /mnt/nvme/models:/models
```

## 4a. Deploy via compose CLI (recommended)

```bash
cd /mnt/nvme/apps/home-llm
docker compose build inference
docker compose up -d
```

## 4b. — or — deploy via the Apps UI

**Apps → Discover → Custom App → Install via YAML**, paste the compose content,
and deploy. (The CLI path is usually less fiddly for multi-service stacks.)

## 5. Confirm the GPU inside the engine container

```bash
docker exec -it inference nvidia-smi
```

If the GPU isn't visible, recheck the NVIDIA driver
([step 02b](02b-host-os-hexos-truenas.md)) and the `deploy.resources` GPU stanza.

## Verification

- `docker ps` shows `inference`, `litellm`, `open-webui`, `cloudflared` up.
- `docker exec -it inference nvidia-smi` sees the GPU.
- `curl -s http://localhost:3000` returns the Open WebUI page (local only).

→ Continue to [05 — Inference](05-inference-tabbyapi-llamaswap.md).
