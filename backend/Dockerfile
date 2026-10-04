# 基础镜像源：默认走国内可达镜像（docker.io 在部分网络下不可直达）。
# CI 或境外网络可覆盖： docker build --build-arg PY_REGISTRY=docker.io .
ARG PY_REGISTRY=docker.m.daocloud.io
# pip 源同样可覆盖。默认清华镜像（国内快）；
# GitHub Actions 里建议传空值走官方 PyPI，避免跨境拉取反而变慢：
#   docker build --build-arg PIP_INDEX_URL= .
ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
FROM ${PY_REGISTRY}/library/python:3.12-slim

ARG PIP_INDEX_URL

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

# PIP_INDEX_URL 为空时不传 -i，直接使用官方源
COPY requirements.txt /app/requirements.txt
RUN if [ -n "${PIP_INDEX_URL}" ]; then \
      pip install -i "${PIP_INDEX_URL}" --upgrade pip \
      && pip install -i "${PIP_INDEX_URL}" -r /app/requirements.txt; \
    else \
      pip install --upgrade pip \
      && pip install -r /app/requirements.txt; \
    fi

COPY . /app

RUN chmod +x /app/entrypoint.sh || true

EXPOSE 8000

ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
