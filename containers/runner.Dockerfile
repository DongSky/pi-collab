FROM node:22.19.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/pi
# The application lockfile preserves the same Pi SDK dependency graph in both backends.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY lib/collab/runtime/coordination-extension.ts ./lib/collab/runtime/coordination-extension.ts
COPY lib/collab/question-schema.ts ./lib/collab/question-schema.ts
COPY lib/collab/coordination-schema.ts lib/collab/memory-schema.ts lib/collab/subtask-schema.ts lib/collab/work-intent-schema.ts lib/collab/resource-schema.ts lib/collab/contract-schema.ts ./lib/collab/
COPY lib/collab/runtime/terminal-runner.mjs ./lib/collab/runtime/terminal-runner.mjs
COPY lib/collab/runtime/output-redaction.mjs ./lib/collab/runtime/output-redaction.mjs
COPY lib/collab/runtime/service-runner.mjs ./lib/collab/runtime/service-runner.mjs
COPY containers/bridge-runner.mjs ./bridge-runner.mjs
ENV HOME=/home/agent PI_CODING_AGENT_DIR=/agent PI_OFFLINE=1 PI_TELEMETRY=0
ENTRYPOINT ["node","/opt/pi/bridge-runner.mjs"]
