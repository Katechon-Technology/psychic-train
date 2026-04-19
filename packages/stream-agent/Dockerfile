FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Static Docker CLI — stream-agent uses it to docker-run spawn containers and
# docker-exec the RTMP start/stop scripts inside vtuber-overlay.
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    | tar xz --strip-components=1 -C /usr/local/bin docker/docker \
    && docker --version

RUN pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic

COPY main.py /app/

ENV PYTHONUNBUFFERED=1
EXPOSE 8090

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8090"]
