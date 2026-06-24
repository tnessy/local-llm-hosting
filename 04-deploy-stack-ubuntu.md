# 04 — Deploy the container stack (Ubuntu)

← [03 Storage](03-storage-ubuntu.md) · Next: [05 Inference](05-inference-tabbyapi-llamaswap.md)

Deploy the stack defined in [`assets/docker-compose.yml`](assets/docker-compose.yml).

## 1. Stage the project files

```bash
sudo mkdir -p /opt/home-llm
sudo chown $USER:$USER /opt/home-llm
cp -r assets/* /opt/home-llm/
```

The directory should contain:

```
/opt/home-llm/
  docker-compose.yml
  .env.example
  llama-swap-config.yaml
  litellm-config.yaml
  inference/Dockerfile
```

## 2. Create and fill `.env`

```bash
cd /opt/home-llm
cp .env.example .env

# Generate secrets (run once each; use distinct values)
openssl rand -hex 32   # TABBY_API_KEY
openssl rand -hex 32   # LITELLM_SALT_KEY
openssl rand -hex 32   # WEBUI_SECRET_KEY
```

Fill `.env`:
- `CF_TUNNEL_TOKEN` — from [step 01](01-prerequisites.md).
- `LITELLM_MASTER_KEY` — set to `sk-` + a random hex.
- `OPENWEBUI_LITELLM_KEY` — leave blank for now; mint it in
  [step 06](06-gateway-litellm.md), then add it and restart `open-webui`.

## 3. Point the `models` volume at `/srv/models`

In `docker-compose.yml`, replace the named `models` volume with a bind mount to
the NVMe path from [step 03](03-storage-ubuntu.md):

```yaml
    volumes:
      - ./llama-swap-config.yaml:/app/config.yaml:ro
      - /srv/models:/models
```

## 4. Bring the stack up

```bash
cd /opt/home-llm
docker compose build inference   # builds the inference image (~2–5 min first run)
docker compose up -d
```

## 5. Confirm the GPU is visible inside the engine

```bash
docker exec -it inference nvidia-smi
```

You should see the GPU **inside** the container. If not, recheck the NVIDIA
Container Toolkit setup ([step 02](02-host-os-ubuntu.md)) and the
`deploy.resources` GPU stanza in `docker-compose.yml`.

## 6. Enable auto-start on boot

```bash
sudo systemctl enable docker   # Docker itself starts on boot

# Compose stack: create a systemd unit
sudo tee /etc/systemd/system/home-llm.service > /dev/null <<'EOF'
[Unit]
Description=Home LLM stack
After=docker.service
Requires=docker.service

[Service]
WorkingDirectory=/opt/home-llm
ExecStart=/usr/bin/docker compose up
ExecStop=/usr/bin/docker compose down
Restart=on-failure
User=YOUR_USERNAME

[Install]
WantedBy=multi-user.target
EOF

# Replace YOUR_USERNAME with your actual username, then:
sudo systemctl daemon-reload
sudo systemctl enable home-llm
```

## Verification

- `docker ps` shows `inference`, `litellm`, `open-webui`, `cloudflared` up.
- `docker exec -it inference nvidia-smi` sees the GPU.
- `curl -s http://localhost:3000` returns the Open WebUI page (local only).

→ Continue to [05 — Inference](05-inference-tabbyapi-llamaswap.md).
