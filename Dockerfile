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
COPY miclaw.json ./
COPY soul/ soul/

# Web server port
EXPOSE 3456

# Disable CLI by default in container mode — web is the primary channel.
# Override miclaw.json via volume mount to re-enable CLI if needed.
ENV NODE_ENV=production

CMD ["npx", "tsx", "src/index.ts"]
