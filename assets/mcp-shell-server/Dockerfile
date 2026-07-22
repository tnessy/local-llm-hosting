# Custom image for the mcp-bridge-shell deployment (see mcp-bridge-shell.yaml
# and 17-mcp-registry.md). Every other stdio MCP bridge in this cluster runs
# the official supergateway image unmodified and fetches its wrapped tool at
# runtime via `uvx <pkg>` (see mcp-bridge-time.yaml) — deliberately NOT done
# here. A command-execution tool is the "elevated supply-chain sensitivity"
# exception 17-mcp-registry.md already calls out for building a custom image
# instead: baking the package in at build time means no PyPI fetch (and no
# egress requirement tied to that fetch) on every pod restart, and the exact
# installed version is pinned here rather than "whatever PyPI resolves to
# right now" each time the pod restarts.
FROM ghcr.io/supercorp-ai/supergateway@sha256:2ffee900c18d8375096b392c8be15cd344535a05b753a5b182da227ab6306a15
RUN uv pip install --system mcp-shell-server==1.1.2
