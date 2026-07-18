# Maintenance runbooks

Operational procedures for a **running** deployment — hardware swaps, upgrades,
recovery, and routine upkeep. These are distinct from the numbered `01`–`16`
**setup** guide: setup is a one-time sequential build; maintenance runbooks are
standalone, run on-demand, and assume the stack is already live.

## Conventions

- **Generic, like the setup guide.** No host-specific hardware, IPs, or version
  numbers inline — use placeholders (`<host>`, `<node>`, `<new-gpu>`). Record the
  actual values and outcomes of a given run in your git-ignored
  `deployments/<host>.md`.
- **No heredocs** in any doc or asset (they break on paste) — ship multi-line
  files as versioned assets under `assets/` instead.
- Each runbook is self-contained but **cross-links** the relevant setup steps so
  you can jump to the authoritative install/config detail.
- Every runbook ends with a **rollback** and a **document-the-result** step.

## Index

| Runbook | Use when |
|---|---|
| [gpu-replace.md](gpu-replace.md) | Replacing, upgrading, or adding a GPU |
| [models.md](models.md) | Adding, renaming, or removing a served model |
| [model-troubleshooting.md](model-troubleshooting.md) | A newly-wired model won't load / 500s / never becomes ready, or tool-calling breaks silently |

<!-- Future runbooks (add as written):
     - driver-update.md      — NVIDIA driver / CUDA upgrade (held back from unattended-upgrades)
     - restore-from-backup.md — recover PVCs / Postgres from the step-13 backups
     - node-patching.md      — OS patch + reboot with graceful workload drain
     - microk8s-upgrade.md   — channel/revision upgrade of the cluster
     - storage-expand.md     — grow the model NVMe / hostpath storage
     - secret-rotation.md    — rotate keys that CAN be rotated (not SECRET_KEY / SALT_KEY) -->
