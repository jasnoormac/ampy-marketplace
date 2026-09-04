# Ampy full stack in one container:
#   seller (FastAPI) :8000, buyer :3001, deal-finder :4747,
#   Next.js frontend on $PORT (the platform-provided public port).
FROM node:22-slim

# uv manages the seller service's Python (downloads the CPython from uv.lock).
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layers first so code edits don't re-run installs.
COPY backend/seller/pyproject.toml backend/seller/uv.lock backend/seller/README.md backend/seller/
RUN cd backend/seller && uv sync --frozen --no-dev --no-install-project

COPY backend/buyer/package.json backend/buyer/package-lock.json backend/buyer/
RUN npm ci --prefix backend/buyer

COPY backend/deal-finder/package.json backend/deal-finder/package-lock.json backend/deal-finder/
RUN npm ci --prefix backend/deal-finder

COPY frontend/package.json frontend/package-lock.json frontend/
# npm ci rejects the macOS-generated lockfile on linux (missing platform-specific
# optional deps — npm/cli#4828), so resolve fresh in-container.
RUN npm install --prefix frontend --no-audit --no-fund

COPY . .

RUN cd backend/seller && uv sync --frozen --no-dev
RUN npm run build --prefix frontend

ENV NODE_ENV=production
EXPOSE 10000

# start.mjs boots seller -> buyer + deal-finder -> frontend, with health gates.
# FRONTEND_CMD swaps the default `next dev` for the production server.
CMD ["sh", "-c", "FRONTEND_PORT=${PORT:-10000} FRONTEND_CMD=\"npm run start -- -p ${PORT:-10000}\" node backend/start.mjs"]
