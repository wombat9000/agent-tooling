FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 \
 && rm -rf /var/lib/apt/lists/*

# Fixture repository: `main` holds the base commit, `feature` the change under review.
COPY base/ /workspace/
RUN git -C /workspace init -q -b main \
 && git -C /workspace add -A \
 && git -C /workspace -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "Add product catalog"
COPY change/ /workspace/
RUN git -C /workspace checkout -q -b feature \
 && git -C /workspace add -A \
 && git -C /workspace -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "Import products from CSV"

# Agents may run as a non-root user.
RUN git config --system --add safe.directory /workspace \
 && mkdir -p /output /skills \
 && chmod -R a+rwX /workspace /output /skills

WORKDIR /workspace
