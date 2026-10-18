# Sound publisher: publish-only LiveKit participant. Mounts finalized sounds read-only; holds no LiveKit secret.
FROM python:3.13.16-slim@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f

WORKDIR /app
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --only-binary=:all: -r requirements.lock \
    && useradd --uid 10002 --no-create-home --shell /usr/sbin/nologin publisher
COPY publisher.py .
USER 10002
ENV PYTHONUNBUFFERED=1
CMD ["python", "-I", "/app/publisher.py"]
