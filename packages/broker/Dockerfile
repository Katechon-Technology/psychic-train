FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Docker CLI — static binary, no engine. Needed because the broker spawns
# env/agent/stream-client/vtuber containers via `docker run` through the
# mounted /var/run/docker.sock. apt's `docker.io` pulls in the full engine
# and is flaky in slim images; the static CLI is 40MB and reliable.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && docker --version

COPY pyproject.toml /app/
RUN pip install --no-cache-dir \
      fastapi "uvicorn[standard]" "sqlalchemy[asyncio]" asyncpg redis httpx pydantic python-dotenv pyyaml

COPY app /app/app
COPY main.py /app/

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
