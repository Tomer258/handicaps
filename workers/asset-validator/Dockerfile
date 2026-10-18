# Asset validator: no network, no secrets, unprivileged, read-only root filesystem (see infra compose).
FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin validator

WORKDIR /app
COPY validator.py .
USER 10001
ENV PYTHONUNBUFFERED=1 STORAGE_ROOT=/data
CMD ["python", "-I", "/app/validator.py"]
