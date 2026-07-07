# 13 — Operations

← [12 Verification](12-verification.md) · [Back to README](README.md)

> **Overview:** Routine maintenance reference — scheduled backups, OS and container update procedures, credential rotation hygiene, centralized off-server monitoring with Grafana + Loki, CVE scanning with Trivy Operator, and a common-issues table.
>
> **Why:** Security patches, backup integrity, and key rotation are ongoing responsibilities. The deliberate image update procedure (record digests, review changelogs, then deploy) is the operational defence against unnoticed supply chain compromise. Off-server monitoring ensures that security events — credential abuse, failed auth spikes, new CVEs — generate alerts even if the LLM server itself is compromised; an on-server alerting system is the first thing an attacker disables.
>
> **Placeholders to gather before starting:**
>
> | Placeholder | What it is | Where to find it |
> |---|---|---|
> | `<grafana-host-lan-ip>` | LAN IP of the machine running Grafana/Loki | Router DHCP table; assign a static lease for this machine |
> | `<llm-server-lan-ip>` | LAN IP of the LLM server | From step 02, or `ip addr show` on the server |

## Backups (do these)

Two stateful volumes hold the crown jewels:

- **`openwebui-data`** — user accounts, per-user keys, chat history.
- **`litellm-db`** — virtual keys, budgets, spend.

> **`LITELLM_SALT_KEY` and `litellm.db` are inseparable.** The salt key hashes
> every virtual key in the database — restoring the database without the matching
> salt renders the entire key table unverifiable and requires re-issuing keys to
> all friends. Back it up separately (see below).

Models don't need backup (re-downloadable), but note which EXL2 folders you used.

### First-time setup

```bash
# Restrict the backup directory to root only
sudo mkdir -p /srv/backups
sudo chown root:root /srv/backups
sudo chmod 700 /srv/backups

# Generate a backup passphrase (root-only)
sudo openssl rand -hex 32 | sudo tee /root/.backup-passphrase > /dev/null
sudo chmod 600 /root/.backup-passphrase
```

**Copy `/root/.backup-passphrase` to your password manager now.** Without it,
no encrypted backup can be restored.

### Run backups

Archives are GPG-encrypted before hitting disk. Run on a schedule or before
any major maintenance:

Tar each PVC from inside its running pod and pipe straight into GPG:

```bash
BACKUP_DATE=$(date +%F)

# Open WebUI data (accounts, per-user keys, chats)
microk8s kubectl exec -n llm-core deploy/open-webui -- tar cz -C /app/backend/data . | sudo gpg --batch --symmetric --cipher-algo AES256 --passphrase-file /root/.backup-passphrase --output /srv/backups/openwebui-${BACKUP_DATE}.tgz.gpg

# LiteLLM DB (virtual keys, budgets, spend)
microk8s kubectl exec -n llm-core deploy/litellm -- tar cz -C /app/db . | sudo gpg --batch --symmetric --cipher-algo AES256 --passphrase-file /root/.backup-passphrase --output /srv/backups/litellm-${BACKUP_DATE}.tgz.gpg
```

> Run backups during low activity — the SQLite DB is copied live. For a
> point-in-time-consistent copy, scale LiteLLM to zero first
> (`microk8s kubectl scale deploy/litellm -n llm-core --replicas=0`), back up via
> a temporary pod mounting the `litellm-db` PVC, then scale back to 1.

> **`LITELLM_SALT_KEY` backup:** the salt key lives in the `litellm-credentials`
> Kubernetes Secret (encrypted at rest — [step 04 §2](04-deploy-stack-ubuntu.md)),
> **not** in any file and **not** in the volume backups above. It is required to
> restore `litellm.db` — without it the whole key table is unverifiable. Extract it
> and store it in your **password manager**:
> ```bash
> microk8s kubectl get secret litellm-credentials -n llm-core >   -o jsonpath='{.data.salt-key}' | base64 -d; echo
> ```
> Keep it off `/srv/backups` — storing the key beside the encrypted archives halves
> the protection if that disk is stolen.

### Retention

```bash
# Remove archives older than 30 days — run after each backup session, or via cron
sudo find /srv/backups -name '*.tgz.gpg' -mtime +30 -delete
```

### Restore

```bash
# Restore the DB into the running pod, then restart litellm to reload it cleanly
sudo gpg --batch --decrypt --passphrase-file /root/.backup-passphrase --output - /srv/backups/litellm-2026-01-15.tgz.gpg | microk8s kubectl exec -n llm-core -i deploy/litellm -- tar xz -C /app/db

microk8s kubectl rollout restart deploy/litellm -n llm-core
```

## Updates

- **Security patches (automatic):** `unattended-upgrades` applies Ubuntu security
  updates nightly and reboots at the configured maintenance window (step 02 §2).
  Check what was applied:
  ```bash
  cat /var/log/unattended-upgrades/unattended-upgrades.log
  ```
- **Non-security OS packages (manual):** Run periodically and deliberately:
  ```bash
  sudo apt upgrade
  ```
- **NVIDIA driver (manual, verify after):** Blacklisted from automatic updates —
  apply manually and always confirm GPU access afterwards:
  ```bash
  sudo apt upgrade nvidia-* libnvidia-*
  sudo reboot
  microk8s kubectl exec -n llm-core deploy/inference -- nvidia-smi   # must show the GPU
  ```
- **Containers:** update deliberately — record what changed, review changelogs,
  then re-pin digests in the manifests before deploying:

  ```bash
  cd /opt/home-llm

  # 1. Record current digests pulled into the cluster
  microk8s ctr images ls | grep -E 'litellm|open-webui|cloudflared' | tee /tmp/digests-before.txt

  # 2. Pull the moving tags fresh
  for img in ghcr.io/berriai/litellm:main-stable ghcr.io/open-webui/open-webui:main cloudflare/cloudflared:latest ; do
    microk8s ctr images pull "$img"
  done

  # 3. See what actually changed
  microk8s ctr images ls | grep -E 'litellm|open-webui|cloudflared' | diff /tmp/digests-before.txt -
  ```

  For each image whose digest changed, review the upstream changelog before
  proceeding. LiteLLM (`main-stable`) ships frequently and occasionally has
  breaking changes to virtual-key handling.

  ```bash
  # 4. Update the @sha256 digests in the manifests (step 04 §6)
  sudo nano assets/k8s/llm-core/litellm.yaml       # and open-webui.yaml, cloudflared.yaml

  # 5. Apply and roll out
  microk8s kubectl apply -f assets/k8s/llm-core/ -f assets/k8s/llm-platform/
  # If broken: revert the digest in the manifest and re-apply — Kubernetes rolls
  # the Deployment back to healthy pods.
  ```

  For inference engine updates (TabbyAPI base or llama-swap version bump), rebuild
  the image and push it to the registry, then re-pin:
  ```bash
  cd /opt/home-llm/assets/inference
  # If bumping LLAMA_SWAP_VERSION, recompute its SHA-256 (see step 04 §5).
  # Update the FROM digest + LLAMA_SWAP_SHA256 in the Dockerfile, then:
  sudo docker build --build-arg LLAMA_SWAP_SHA256=<hash> -t localhost:32000/home-llm-inference:latest .
  sudo docker push localhost:32000/home-llm-inference:latest
  sudo docker inspect --format='{{index .RepoDigests 0}}' localhost:32000/home-llm-inference:latest
  # Set the new @sha256 in assets/k8s/llm-core/inference.yaml, then:
  microk8s kubectl apply -f /opt/home-llm/assets/k8s/llm-core/inference.yaml
  microk8s kubectl rollout restart deploy/inference -n llm-core
  ```

  Always test Aider + Claude Code after inference or LiteLLM version changes.

## Key & access hygiene

- **Rotate** the per-friend LiteLLM keys periodically; revoke immediately when
  someone no longer needs access (`/key/delete`).
- **Cloudflare allowlist** is the other half — remove a departed friend's email
  from the `llm.` Access policy.
- **`LITELLM_SALT_KEY` — treat as permanent.** This key hashes every virtual key
  in the database; changing it instantly and silently invalidates all friend keys
  with no warning. If rotation ever becomes necessary (e.g. suspected salt leak):
  1. Notify all users of a maintenance window.
  2. List every active key via LiteLLM `/key/list` and record the aliases.
  3. Patch `salt-key` in the `litellm-credentials` Secret and restart LiteLLM:
     ```bash
     microk8s kubectl patch secret litellm-credentials -n llm-core --type merge -p "{\"stringData\":{\"salt-key\":\"$(openssl rand -hex 32)\"}}"
     microk8s kubectl rollout restart deploy/litellm -n llm-core
     ```
  4. Re-mint a replacement key for every friend and send them the new values.

  For routine hygiene, rotate `master-key` instead — that affects admin access
  only and does not touch friend virtual keys.
- Keep the `litellm-credentials` Secret values in your password manager; they are
  encrypted at rest in the cluster and never written to disk in plaintext.
- Tailscale: review devices; the server node has key-expiry disabled, your
  personal devices should keep expiry on.

## Monitoring

> **Why off-server:** A monitoring system running on the server it watches will not alert you after a breach. Logs shipped to a separate LAN machine before analysis give you a tamper-resistant audit trail that survives a full server compromise.

### Architecture

```
Monitoring host (192.168.x.x) ──────────────────────────────────
│  Grafana      dashboards + alert rules                         │
│  Loki         log storage, 90-day retention                    │
│  Prometheus   scrapes CVE metrics                              │
───────┬─────────────────────────────┬──────────────────────────
       │ ← Promtail pushes logs       │ ← Prometheus scrapes NodePort
LLM server (192.168.x.x) ──────────────────────────────────────
│  Promtail       ships cluster pod logs  → Loki                 │
│  Trivy Operator continuous image CVE scan → metrics :32000     │
│  Trivy CronJob  nightly host OS scan → stdout → Loki           │
────────────────────────────────────────────────────────────────
```

### 1. External monitoring host

On the Grafana machine (`<grafana-host-lan-ip>`), create the directory layout and generate a Grafana admin password:

```bash
sudo mkdir -p /opt/monitoring /etc/monitoring
openssl rand -hex 32 | sudo install -m 400 -o root -g root /dev/stdin /etc/monitoring/grafana_admin_password
```

**Copy the admin password to your password manager now** — you will need it every time you open the Grafana UI.

Create `/opt/monitoring/docker-compose.yml`:

```yaml
name: monitoring

services:
  loki:
    image: grafana/loki:2.9.0       # pin to digest — step 04 §4 procedure
    container_name: loki
    restart: unless-stopped
    ports:
      - "3100:3100"   # Promtail push from LLM server
    volumes:
      - loki-data:/loki
      - ./loki-config.yaml:/etc/loki/local-config.yaml:ro
    command: -config.file=/etc/loki/local-config.yaml

  prometheus:
    image: prom/prometheus:v2.48.0  # pin to digest
    container_name: prometheus
    restart: unless-stopped
    # No host port — Grafana reaches it via Docker network (http://prometheus:9090)
    volumes:
      - prometheus-data:/prometheus
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.retention.time=90d

  grafana:
    image: grafana/grafana:10.2.0   # pin to digest
    container_name: grafana
    restart: unless-stopped
    ports:
      - "3000:3000"   # LAN access from admin machines
    volumes:
      - grafana-data:/var/lib/grafana
    environment:
      - GF_SECURITY_ADMIN_PASSWORD__FILE=/run/secrets/grafana_admin_password
      - GF_USERS_ALLOW_SIGN_UP=false
    secrets:
      - grafana_admin_password
    depends_on: [loki, prometheus]

secrets:
  grafana_admin_password:
    file: /etc/monitoring/grafana_admin_password

volumes:
  loki-data:
  prometheus-data:
  grafana-data:
```

Create `/opt/monitoring/loki-config.yaml`:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    instance_addr: 127.0.0.1
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 2160h   # 90 days

compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
```

Create `/opt/monitoring/prometheus.yml` — replace `<llm-server-lan-ip>`:

```yaml
global:
  scrape_interval: 60s

scrape_configs:
  - job_name: trivy-operator
    static_configs:
      - targets: ['<llm-server-lan-ip>:32000']   # Trivy NodePort — set up in §3
```

Bring up the stack:

```bash
cd /opt/monitoring && sudo docker compose up -d
```

### 2. Promtail on the LLM server (DaemonSet)

Promtail runs as a MicroK8s **DaemonSet** in a dedicated `monitoring` namespace,
tailing every pod's logs from `/var/log/pods` and shipping them to the external
Loki. The scrape config sets the `namespace` and `container` labels the alert
rules key on (e.g. `{container="litellm"}`). Full manifest:
[`assets/k8s/monitoring/promtail.yaml`](assets/k8s/monitoring/promtail.yaml).

Point it at your monitoring host and apply:

```bash
# Set the external Loki URL in the ConfigMap, then deploy
sed -i 's/<grafana-host-lan-ip>/192.168.x.x/' assets/k8s/monitoring/promtail.yaml
microk8s kubectl apply -f assets/k8s/monitoring/promtail.yaml
```

### 3. Trivy Operator (MicroK8s)

Trivy Operator continuously scans every container image in the cluster and exposes CVE counts as Prometheus metrics.

```bash
microk8s enable helm3
microk8s helm3 repo add aquasecurity https://aquasecurity.github.io/helm-charts/
microk8s helm3 repo update

microk8s helm3 install trivy-operator aquasecurity/trivy-operator --namespace trivy-system --create-namespace --set metrics.enabled=true --set trivyOperator.scanJobTimeout=10m0s
```

Expose the metrics endpoint as a NodePort so the Prometheus on the monitoring host can scrape it:

```bash
microk8s kubectl apply -f assets/k8s/monitoring/trivy-metrics-nodeport.yaml
```

Port 32000 is reachable at `<llm-server-lan-ip>:32000` from any machine on the LAN. If you want to restrict it to the monitoring host only, add a UFW rule on the LLM server:

```bash
sudo ufw allow from <grafana-host-lan-ip> to any port 32000
sudo ufw deny 32000
```

View scan results manually:

```bash
microk8s kubectl get vulnerabilityreports -A
microk8s kubectl describe vulnerabilityreport <name> -n llm-core
```

**Host OS scan CronJob** — scans the Ubuntu host filesystem nightly at 02:00. The `hostPath: /` mount is an intentional privileged exception for the security scanning role. `automountServiceAccountToken: false` removes all cluster API access from the pod.

```bash
microk8s kubectl apply -f assets/k8s/monitoring/trivy-host-scan.yaml
```

Trivy output goes to the CronJob pod's stdout. Promtail ships it to Loki automatically from `/var/log/pods/trivy-system_trivy-host-scan-*/trivy/*.log`.

Trigger a manual run to test the full pipeline end to end:

```bash
microk8s kubectl create job trivy-host-scan-manual --from=cronjob/trivy-host-scan -n trivy-system
microk8s kubectl logs -l job-name=trivy-host-scan-manual -n trivy-system --follow
```

### 4. Grafana: data sources and alert rules

Open Grafana at `http://<grafana-host-lan-ip>:3000`.

**Add data sources (Connections → Data sources → Add new):**

- **Loki** — URL: `http://loki:3100`
- **Prometheus** — URL: `http://prometheus:9090`

**Alert rules (Alerting → Alert rules → New alert rule):**

*LiteLLM 401 spike* — more than 0.5 auth failures/second over 5 minutes (data source: Loki):
```
sum(rate({container="litellm"} |= "\" 401" [5m])) > 0.5
```

*Authentik failed auth spike* — more than 5 failed logins in 5 minutes (Loki):
```
count_over_time({container="authentik-server"} |= "Failed to authenticate" [5m]) > 5
```

*Trivy image CRITICAL CVE* — any CRITICAL CVE found across cluster images (data source: Prometheus):
```
sum(trivy_image_vulnerabilities{severity="CRITICAL"}) > 0
```

*Trivy image HIGH CVE new* — HIGH CVE count increased in the last hour (Prometheus):
```
increase(trivy_image_vulnerabilities{severity="HIGH"}[1h]) > 0
```

*Host OS CVE found* — Trivy host scan output contains CRITICAL or HIGH; 25 h window covers the nightly cadence (Loki):
```
count_over_time({namespace="trivy-system", container="trivy"} |= "CRITICAL" [25h]) > 0
```

*Promtail canary* — no pod logs arriving from the LLM server for 15 minutes (Loki); fires on monitoring pipeline failure or server downtime:
```
sum(rate({job="kubernetes"}[10m])) == 0
```

Set up a contact point (Alerting → Contact points) to deliver alerts by email or another channel of your choice.

### Verification

```bash
# LLM server: confirm Promtail is connecting and sending
microk8s kubectl logs -n monitoring ds/promtail 2>&1 | grep -i "send\|error"

# LLM server: list Trivy CVE scan results
microk8s kubectl get vulnerabilityreports -A

# Monitoring host: confirm Loki received logs from the LLM server
curl -s 'http://localhost:3100/loki/api/v1/query_range' --data-urlencode 'query={container="litellm"}' --data-urlencode 'limit=1' | jq '.data.result[0].values[-1]'

# Monitoring host: confirm Prometheus is scraping Trivy metrics
curl -s 'http://localhost:9090/api/v1/query?query=trivy_image_vulnerabilities' | jq '.data.result | length'
```

**Quick on-server checks (not a substitute for the above):**
- `microk8s kubectl logs -f -n llm-core deploy/litellm` — real-time auth failures and spend
- LiteLLM `/key/info?key=...` — per-friend spend/usage
- Cloudflare Zero Trust logs — who authenticated, what was blocked at the edge
- `nvidia-smi -l 2` — live VRAM/utilization while tuning context/models

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Model "dumb"/forgets context | `--max-seq-len` too small | Raise it (step 05), watch VRAM |
| 524 from Cloudflare | Long non-streamed response | Ensure streaming; for SD use ComfyUI queue API |
| 401 on API | Bad/expired virtual key | Re-issue (step 06) |
| Engine has no models | llama-swap placeholders not filled | Step 10 |
| GPU not seen in pod | Driver / GPU device plugin | Steps 02/04 |
| Slow first response | Cold model load (expected) | Raise `ttl`; keep model warm |

## Changing a decision later

See the **Decisions log** in the [README](README.md). Each decision links to its
step file; because LiteLLM fronts the backend, swapping the engine or models
needs no client changes.
