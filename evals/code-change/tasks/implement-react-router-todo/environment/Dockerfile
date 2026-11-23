FROM mcr.microsoft.com/playwright:v1.64.1-noble
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV PNPM_HOME=/opt/pnpm
ENV PATH="/opt/pnpm/bin:/opt/pnpm-cli:${PATH}"
ARG PNPM_VERSION=12.21.0
ARG CODEX_VERSION=0.171.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && case "$(dpkg --print-architecture)" in \
      amd64) pnpm_arch=x64; sha=84c4773bcf4a217f4083cd7b2a91e4cee6103cf42426c1282ef37d308f55a410 ;; \
      arm64) pnpm_arch=arm64; sha=6c5913a48c93b3a556b71c3bd9bf12c6bf9fbfbbbd2dcbd1d52a85c539751b9e ;; \
      *) exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/pnpm/pnpm/releases/download/v${PNPM_VERSION}/pnpm-linux-${pnpm_arch}.tar.gz" -o /tmp/pnpm.tar.gz \
 && printf '%s  /tmp/pnpm.tar.gz\n' "$sha" | sha256sum --check \
 && mkdir -p /opt/pnpm-cli \
 && tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm-cli \
 && rm /tmp/pnpm.tar.gz \
 && pnpm add --global "@openai/codex@${CODEX_VERSION}" \
 && codex --version

WORKDIR /workspace
COPY base/ /workspace/

RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && rm -rf dist \
 && git init -q -b main \
 && git add -A \
 && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "Initial TypeScript Vite project" \
 && git config --system --add safe.directory /workspace \
 && mkdir -p /output /skills \
 && chmod -R a+rwX /workspace /output /skills
