FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Pre-bake Codex CLI so Harbor skips per-trial installation.
ARG CODEX_VERSION=0.171.0
RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && codex --version

# Fixture repository: `main` holds the base commit, `feature` the change under review.
COPY base/ /workspace/
RUN git -C /workspace init -q -b main \
 && git -C /workspace add -A \
 && git -C /workspace -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "Add order pricing"
COPY change/ /workspace/
RUN git -C /workspace checkout -q -b feature \
 && git -C /workspace add -A \
 && git -C /workspace -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "Add shipping charges"

# Agents may run as a non-root user.
RUN git config --system --add safe.directory /workspace \
 && mkdir -p /output /skills \
 && chmod -R a+rwX /workspace /output /skills

WORKDIR /workspace
