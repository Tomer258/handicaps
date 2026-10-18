# Authorization watchdog: standard library only, no inbound ports. Holds a dedicated LiveKit key used for
# ListRooms/DeleteRoom; writes the edge's "closed" flag into a directory shared read-only with Caddy.
FROM python:3.13.16-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

RUN useradd --uid 10003 --no-create-home --shell /usr/sbin/nologin watchdog
WORKDIR /app
COPY watchdog.py .
USER 10003
ENV PYTHONUNBUFFERED=1
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD ["python", "-I", "-c", "import os,sys,time; sys.exit(time.time() - os.path.getmtime('/tmp/heartbeat') > 30)"]
CMD ["python", "-I", "/app/watchdog.py"]
