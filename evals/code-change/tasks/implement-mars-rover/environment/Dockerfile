FROM gradle:8.12-jdk21-jammy

RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Pre-bake Node 22 + Codex CLI so Harbor skips per-trial installation.
ARG NODE_VERSION=22.18.0
ARG CODEX_VERSION=0.171.0
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo "Unsupported arch: $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.gz" \
    | tar -xz -C /usr/local --strip-components=1 \
 && npm install -g "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && codex --version

ENV GRADLE_USER_HOME=/opt/gradle-cache

COPY base/ /workspace/
WORKDIR /workspace

# Generate the Gradle wrapper and warm the Kotlin/JUnit cache so trials run fast and offline.
RUN gradle --no-daemon wrapper --gradle-version 8.12 \
 && mkdir -p /workspace/src/main/kotlin /workspace/src/test/kotlin \
 && printf 'import kotlin.test.Test\nimport kotlin.test.assertTrue\nclass WarmupTest { @Test fun ok() { assertTrue(true) } }\n' > /workspace/src/test/kotlin/WarmupTest.kt \
 && ./gradlew --no-daemon test \
 && rm -f /workspace/src/test/kotlin/WarmupTest.kt \
 && rm -rf /workspace/build /workspace/.gradle \
 && printf '/build/\n/.gradle/\n' > /workspace/.gitignore \
 && git -C /workspace init -q -b main \
 && git -C /workspace add -A \
 && git -C /workspace -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "Initial Kotlin Gradle project"

# Agents may run as a non-root user.
RUN git config --system --add safe.directory /workspace \
 && mkdir -p /output /skills \
 && chmod -R a+rwX /workspace /output /skills /opt/gradle-cache
