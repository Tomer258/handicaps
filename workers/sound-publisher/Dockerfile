# Sound publisher: publish-only LiveKit participant. Mounts finalized sounds read-only; holds no LiveKit secret.
FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --uid 10002 --no-create-home --shell /usr/sbin/nologin publisher
COPY publisher.py .
USER 10002
ENV PYTHONUNBUFFERED=1
CMD ["python", "-I", "/app/publisher.py"]
