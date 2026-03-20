FROM node:22-slim

# Claude Code CLI (required runtime dependency)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Copy default config and soul (can be overridden via volume mounts)
COPY miclaw.docker.json miclaw.json
COPY soul/ soul/
COPY cron/ cron/

# Run as non-root user — Claude Code refuses bypassPermissions as root.
# The node:22-slim image ships with a "node" user (uid 1000) which matches most host users.
# Create .claude directory so Claude Code can write its runtime state there.
RUN chown -R node:node /app && \
    mkdir -p /home/node/.claude && \
    chown -R node:node /home/node/.claude
USER node

# Web server port
EXPOSE 3456

ENV NODE_ENV=production

CMD ["npx", "tsx", "src/index.ts"]
