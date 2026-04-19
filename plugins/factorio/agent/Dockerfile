FROM python:3.12-slim

WORKDIR /app

RUN pip install --no-cache-dir factorio-rcon-py anthropic httpx

COPY main.py /app/

ENV PYTHONUNBUFFERED=1

CMD ["python", "main.py"]
