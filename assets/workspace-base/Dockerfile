# Example workspace base image (step 16): code-server + a toolchain +
# preconfigured LLM clients pointing at LiteLLM. Build variants per stack
# (ws-python, ws-node, ...). Launched by the orchestrator as a HARDENED,
# NON-ROOT, GPU-FREE container on the isolated ws-net.

FROM codercom/code-server:latest

USER root

# --- Toolchain (example: Python). Swap per base image. ----------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip python3-venv git curl \
    && rm -rf /var/lib/apt/lists/*

# --- LLM clients preinstalled ----------------------------------------------
# Aider (CLI) + (optionally) the Continue CLI / extension can be added here.
RUN pip3 install --no-cache-dir aider-chat

# --- Preconfigure clients to use LiteLLM ------------------------------------
# OPENAI_API_BASE / OPENAI_API_KEY are injected at launch by the orchestrator
# (scoped per-user LiteLLM virtual key). Aider reads these env vars directly.
# Provide a sane default model.
ENV AIDER_MODEL=openai/coder

# Drop back to the unprivileged code-server user. The orchestrator additionally
# applies: --user (non-root), userns-remap, no-new-privileges, seccomp, dropped
# caps, read-only root + writable /home, cpu/mem/pids limits, no docker socket.
USER coder
WORKDIR /home/coder

# code-server listens on 8080; Traefik routes ws-<id>.ws.domain.com here.
EXPOSE 8080
# Auth is enforced upstream (Cloudflare Access + orchestrator ownership); the
# orchestrator may also pass --auth password with a per-session secret.
CMD ["code-server", "--bind-addr", "0.0.0.0:8080", "--disable-telemetry"]
