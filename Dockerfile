FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN corepack enable && corepack prepare pnpm@11.28.5 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
COPY apps ./apps
COPY datasets ./datasets

RUN pnpm install --prod --ignore-scripts --node-linker=hoisted --frozen-lockfile

EXPOSE 3000
CMD ["node", "apps/server/src/index.ts"]
