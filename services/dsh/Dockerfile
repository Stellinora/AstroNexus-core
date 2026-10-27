# syntax=docker/dockerfile:1
# 基础镜像 digest 待首次可复现构建后固定（docs/15 §4）。
FROM node:24-bookworm-slim

ARG DSH_VERSION=0.2.1-rc.2

ENV DSH_HOME=/home/dsh/.dsh \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends patch ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 上游部分包带 install scripts；npm 11+ 默认拦截，这里显式放行。
RUN npm install -g --no-fund --no-audit \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
      "pnpm@12.15.0" \
 && npm cache clean --force

WORKDIR /opt/astronexus
COPY profile ./profile
COPY bundle ./bundle
COPY patches ./patches

# 仅当 patches/ 下有 .patch 时应用；无 patch 时该步为 no-op。
RUN set -eux; \
    for p in /opt/astronexus/patches/*.patch; do \
      [ -e "$p" ] || continue; \
      patch -p1 -d "$(npm root -g)/@deepseek-ai/dsh" < "$p"; \
    done

RUN set -eux; \
    mkdir -p "${DSH_HOME}/profiles"; \
    cp -R /opt/astronexus/profile "${DSH_HOME}/profiles/astronexus"; \
    dsh plugin --profile astronexus add /opt/astronexus/bundle; \
    dsh --profile astronexus --dump-config > /opt/astronexus/composed.yml; \
    grep -q 'headless-runner' /opt/astronexus/composed.yml

RUN useradd --create-home --uid 10001 dsh \
 && chown -R dsh:dsh /opt/astronexus "${DSH_HOME}"

USER dsh
WORKDIR /workspace
ENTRYPOINT ["dsh", "--profile", "astronexus"]
