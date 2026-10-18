# Ops monitor: standard library only, no inbound ports, no secrets except the alert webhook URL.
FROM python:3.13.16-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

RUN useradd --uid 10004 --no-create-home --shell /usr/sbin/nologin monitor
WORKDIR /app
COPY monitor.py .
USER 10004
ENV PYTHONUNBUFFERED=1
HEALTHCHECK --interval=60s --timeout=3s --retries=3 \
    CMD ["python", "-I", "-c", "import os,sys,time; sys.exit(time.time() - os.path.getmtime('/tmp/heartbeat') > 180)"]
CMD ["python", "-I", "/app/monitor.py"]
