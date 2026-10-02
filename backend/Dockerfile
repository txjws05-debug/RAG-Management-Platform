# 基础镜像源：默认走国内可达镜像（docker.io 在部分网络下不可直达）。
# 构建时可覆盖： docker compose build --build-arg PY_REGISTRY=docker.io
ARG PY_REGISTRY=docker.m.daocloud.io
FROM ${PY_REGISTRY}/library/python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    TZ=Asia/Shanghai

WORKDIR /app

# 构建期使用清华镜像加速；不需要可删除 -i 参数
COPY requirements.txt /app/requirements.txt
RUN pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --upgrade pip \
 && pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r /app/requirements.txt

COPY . /app

RUN chmod +x /app/entrypoint.sh || true

EXPOSE 8000

ENTRYPOINT ["/bin/bash", "/app/entrypoint.sh"]
