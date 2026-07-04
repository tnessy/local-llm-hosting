# 04 — Deploy the container stack (Ubuntu)

← [03 Storage](03-storage-ubuntu.md) · Next: [05 Inference](05-inference-tabbyapi-llamaswap.md)

> **Overview:** Stage the project files to `/opt/home-llm` under `llm-svc` ownership, write secrets into a permission-locked `.env`, bind the models volume to `/srv/models`, bring the Docker Compose stack up, and configure systemd auto-start.
>
> **Why:** Directory ownership (`llm-svc:llm-svc`), file permissions (`chmod 600` on `.env`), and the systemd unit configuration set here form the service isolation baseline for the whole stack.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `CF_TUNNEL_TOKEN` | Cloudflare tunnel credential | Cloudflare Zero Trust → Tunnels → your tunnel → copy token (step 01) |

## 1. Stage the project files

```bash
sudo mkdir -p /opt/home-llm
sudo cp -r assets/* /opt/home-llm/
sudo chown -R llm-svc:llm-svc /opt/home-llm
sudo chmod 750 /opt/home-llm
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

## 2. Create and fill `.env` and LiteLLM secret files

### LiteLLM secrets (Docker secrets — not in `.env`)

`LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` are stored as Docker secrets rather
than environment variables. This prevents them appearing in `docker inspect
litellm` output, which is readable by anyone in the `docker` group.

```bash
# Create the secrets directory and files — root-owned, mode 400
sudo mkdir -p /etc/home-llm

# Generate and write the master key (must start with "sk-")
printf 'sk-%s' "$(openssl rand -hex 32)" \
  | sudo install -m 400 -o root -g root /dev/stdin /etc/home-llm/litellm_master_key

# Generate and write the salt key
openssl rand -hex 32 \
  | sudo install -m 400 -o root -g root /dev/stdin /etc/home-llm/litellm_salt_key
```

> **`LITELLM_SALT_KEY` is permanent.** Changing it after setup silently
> invalidates every friend virtual key. Store the value in your password manager
> now. See [step 14](14-operations.md) Key & access hygiene for the full rotation
> procedure if it ever becomes necessary.

To retrieve the master key when you need it for admin operations (e.g. minting
keys in [step 06](06-gateway-litellm.md)):
```bash
sudo cat /etc/home-llm/litellm_master_key
```

### `.env` (remaining config)

```bash
# Create .env owned by llm-svc with mode 600 atomically
sudo install -m 600 -o llm-svc -g llm-svc \
  /opt/home-llm/.env.example /opt/home-llm/.env

# Prevent accidental git commits of secrets
echo ".env" | sudo tee -a /opt/home-llm/.gitignore > /dev/null

# Generate remaining secrets — use sudo nano to edit, not echo/shell substitution
# (shell substitution persists secret values in history files)
openssl rand -hex 32   # TABBY_API_KEY
openssl rand -hex 32   # WEBUI_SECRET_KEY
sudo nano /opt/home-llm/.env
```

Fill `.env`:
- `CF_TUNNEL_TOKEN` — from [step 01](01-prerequisites.md). Moves to a k8s Secret
  in [step 08 §5](08-connectivity-cloudflare.md) after the MicroK8s migration.
- `OPENWEBUI_LITELLM_KEY` — leave blank for now; mint it in
  [step 06](06-gateway-litellm.md), then add it and restart `open-webui`.

> **`docker inspect` exposure:** Docker Compose injects `.env` values as
> environment variables in running containers. Running `sudo docker inspect
> cloudflared` exposes `CF_TUNNEL_TOKEN` in plaintext from the container's `Env`
> array — `chmod 600` on `.env` does not protect the value once injected. This is
> an inherent limitation of the Docker Compose bootstrap phase. After migrating to
> the k8s Secret in [step 08 §5](08-connectivity-cloudflare.md), that step
> instructs you to redact the token from `.env` and stop the Docker Compose
> `cloudflared` container, closing this vector.

## 3. Point the `models` volume at `/srv/models`

In `docker-compose.yml`, replace the named `models` volume with a bind mount to
the NVMe path from [step 03](03-storage-ubuntu.md):

```yaml
    volumes:
      - ./llama-swap-config.yaml:/app/config.yaml:ro
      - /srv/models:/models
```

## 4. Pin image digests

> **Why:** Floating tags like `:latest` and `:main-stable` resolve to different
> content on every pull. Pinning to SHA-256 digests ensures each build and
> restart gets exactly what you verified — a supply-chain compromise that
> replaces upstream image content is caught before it reaches your server.

### Third-party images

Pull the pre-built images first, then record their digests:

```bash
sudo docker compose -f /opt/home-llm/docker-compose.yml pull

sudo docker inspect \
  --format='{{index .RepoDigests 0}}' \
  ghcr.io/berriai/litellm:main-stable \
  ghcr.io/open-webui/open-webui:main \
  cloudflare/cloudflared:latest
```

Each line of output looks like `ghcr.io/berriai/litellm@sha256:abc123...`. Open
`docker-compose.yml` and append `@sha256:<digest>` to each image: line:

```yaml
image: ghcr.io/berriai/litellm:main-stable@sha256:<digest>
image: ghcr.io/open-webui/open-webui:main@sha256:<digest>
image: cloudflare/cloudflared:latest@sha256:<digest>
```

```bash
sudo nano /opt/home-llm/docker-compose.yml
```

### Inference base image

Pull the TabbyAPI base image and record its digest:

```bash
sudo docker pull ghcr.io/theroyallab/tabbyapi:latest
sudo docker inspect \
  --format='{{index .RepoDigests 0}}' \
  ghcr.io/theroyallab/tabbyapi:latest
```

Open `inference/Dockerfile` and replace `:latest` on the `FROM` line with
`:latest@sha256:<digest>`.

### llama-swap binary

The Dockerfile verifies the llama-swap binary against a SHA-256 hash at build
time. Get the hash for the version pinned in `ARG LLAMA_SWAP_VERSION`:

```bash
LLAMA_SWAP_VERSION=v201   # must match ARG LLAMA_SWAP_VERSION in the Dockerfile
curl -fsSL \
  "https://github.com/mostlygeek/llama-swap/releases/download/${LLAMA_SWAP_VERSION}/llama-swap_linux_amd64" \
  | sha256sum
```

Set the resulting hash as the default for `ARG LLAMA_SWAP_SHA256` in
`inference/Dockerfile`:

```dockerfile
ARG LLAMA_SWAP_SHA256=<paste-hash-here>
```

```bash
sudo nano /opt/home-llm/inference/Dockerfile
```

> **When you update:** Step 14 documents how to record digests before pulling,
> compare what changed, and re-pin after reviewing changelogs.

## 5. Build and bring the stack up

```bash
sudo docker compose -f /opt/home-llm/docker-compose.yml build inference   # ~2–5 min first run
sudo docker compose -f /opt/home-llm/docker-compose.yml up -d
```

## 6. Confirm the GPU is visible inside the engine

```bash
sudo docker exec -it inference nvidia-smi
```

You should see the GPU **inside** the container. If not, recheck the NVIDIA
Container Toolkit setup ([step 02](02-host-os-ubuntu.md)) and the
`deploy.resources` GPU stanza in `docker-compose.yml`.

## 7. Enable auto-start on boot

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
User=llm-svc

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable home-llm.service
```

## Verification

- `sudo docker ps` shows `inference`, `litellm`, `open-webui`, `cloudflared` up.
- `sudo docker exec -it inference nvidia-smi` sees the GPU.
- `curl -s http://localhost:3000` returns the Open WebUI page (local only).

→ Continue to [05 — Inference](05-inference-tabbyapi-llamaswap.md).
