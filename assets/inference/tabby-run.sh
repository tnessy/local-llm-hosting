#!/bin/bash
# Generic TabbyAPI launcher for llama-swap.
#
# WHY THIS EXISTS: llama-swap runs each backend as a child process and does not
# reliably drain the child's stdout/stderr pipe during model *load*. A model that
# prints enough at load (e.g. phi-4-reasoning) fills the ~64 KB pipe buffer, blocks
# on write, and dies "upstream command exited prematurely" at ~4s — even though it
# loads fine when run directly. Redirecting the child's output to a file removes the
# pipe from the equation. See deployments/surtr.md → "Rollout gotchas (2026-07-09)".
#
# USAGE (from a llama-swap `cmd:`), pass the exact args you'd give python3 /app/main.py:
#   bash /usr/local/bin/tabby-run.sh --model-dir /models --model-name <folder> \
#     --max-seq-len <ctx> --cache-mode Q4 --disable-auth true --host 127.0.0.1 --port <port>
#
# Output goes to /tmp/tabby-<port>.log inside the pod. To read it:
#   microk8s kubectl exec deploy/inference -n llm-core -- tail -60 /tmp/tabby-<port>.log

port=8080
prev=""
for a in "$@"; do
  [ "$prev" = "--port" ] && port="$a"
  prev="$a"
done

exec python3 /app/main.py "$@" > "/tmp/tabby-${port}.log" 2>&1
