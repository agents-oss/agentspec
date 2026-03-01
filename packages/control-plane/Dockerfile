FROM python:3.12-slim

WORKDIR /app

# Install dependencies first (layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

# JWT_SECRET and DATABASE_URL must be set at runtime
ENV DATABASE_URL="sqlite+aiosqlite:///./agentspec.db"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
