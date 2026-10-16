ARG UAT_BASE_IMAGE
FROM ${UAT_BASE_IMAGE} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --include=dev

FROM ${UAT_BASE_IMAGE} AS builder
WORKDIR /app
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_MAM_UAT_ENABLED
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL} \
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY} \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_MAM_UAT_ENABLED=${NEXT_PUBLIC_MAM_UAT_ENABLED} \
    MAM_UAT_ENABLED=true \
    MAM_APP_ENV=preview \
    MAM_UAT_TARGET=mam-people-hub-uat-v1 \
    MAM_UAT_INTERNAL_SUPABASE_URL=http://uat-gateway:8080 \
    MAM_UAT_BUILD_ONLY=true \
    MAM_PERFORMANCE_REVIEW_ENABLED=true
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json next.config.ts postcss.config.mjs ./
COPY scripts/apply-dayflow-dst-patch.mjs ./scripts/
COPY patches/dayflow-core-3.7.1-dst.json ./patches/
COPY src ./src
COPY public ./public
RUN npm run build
RUN test -s .next/standalone/server.js

FROM ${UAT_BASE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    MAM_UAT_ENABLED=true \
    MAM_UAT_BUILD_ONLY=false \
    MAM_APP_ENV=preview \
    MAM_UAT_TARGET=mam-people-hub-uat-v1 \
    MAM_UAT_INTERNAL_SUPABASE_URL=http://uat-gateway:8080
COPY --from=builder --chown=1000:1000 /app/.next/standalone ./
COPY --from=builder --chown=1000:1000 /app/.next/static ./.next/static
COPY --from=builder --chown=1000:1000 /app/public ./public
RUN mkdir -p /app/.next/cache && chown 1000:1000 /app/.next/cache
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
