# =====================================================================
# 知识库管理平台前端（Next.js 16 App Router，output: standalone）
# 三阶段构建：deps → builder → runner
#
# 说明：这里刻意不使用 `# syntax=docker/dockerfile:1` 指令 ——
# 该指令会让 BuildKit 去 Docker Hub 拉取 dockerfile 前端镜像，
# 在无法直达 Docker Hub 的网络下会直接构建失败，而本文件并不需要它。
#
# NODE_REGISTRY：基础镜像源（docker.io 在部分网络下不可直达，默认走国内镜像）
#   docker compose build --build-arg NODE_REGISTRY=docker.io
# NPM_REGISTRY：npm 包源
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmjs.org
# =====================================================================
ARG NODE_REGISTRY=docker.m.daocloud.io
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ---------- 1) 依赖安装 ----------
FROM ${NODE_REGISTRY}/library/node:24-alpine AS deps
ARG NPM_REGISTRY
WORKDIR /app
# 只复制依赖清单，最大化利用镜像层缓存
COPY package.json package-lock.json* ./
# 有 lock 文件走 npm ci（可复现），否则回退 npm install
RUN npm config set registry ${NPM_REGISTRY} \
 && (npm ci --no-audit --no-fund || npm install --no-audit --no-fund)

# ---------- 2) 构建 ----------
FROM ${NODE_REGISTRY}/library/node:24-alpine AS builder
WORKDIR /app
# 构建期注入「浏览器可见」的 API 前缀（默认同源 /api，由 Nginx 反代到 api:8000）
ARG NEXT_PUBLIC_API_BASE=/api
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 3) 运行时 ----------
FROM ${NODE_REGISTRY}/library/node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# 非 root 运行
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# standalone 产物自带最小化的 node_modules 与 server.js
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
