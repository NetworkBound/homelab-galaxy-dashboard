# Build from the repository root:
#   podman build -f deploy/k3s/Dockerfile -t registry.local/galaxy-dashboard:latest .
# Multi-arch (Raspberry Pi agents are arm64):
#   podman build --platform linux/arm64,linux/amd64 --manifest registry.local/galaxy-dashboard:latest -f deploy/k3s/Dockerfile .
FROM docker.io/library/python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt \
 && useradd -u 10001 -U -d /opt/dashboard -s /usr/sbin/nologin dashboard \
 && mkdir -p /opt/dashboard /var/lib/homelab-dashboard \
 && chown dashboard:dashboard /opt/dashboard /var/lib/homelab-dashboard
WORKDIR /opt/dashboard
COPY --chown=dashboard:dashboard *.py ./
COPY --chown=dashboard:dashboard templates ./templates
COPY --chown=dashboard:dashboard static ./static
COPY --chown=dashboard:dashboard addons ./addons
COPY --chown=dashboard:dashboard demo ./demo
USER 10001
EXPOSE 8080
CMD ["python3", "app.py"]
