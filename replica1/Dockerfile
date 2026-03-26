FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source (will be overridden by bind mount in dev)
COPY . .

# uvicorn with --reload watches /app for changes via bind mount
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9001", "--reload"]
