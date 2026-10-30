FROM python:3.12-slim
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY requirements.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt
RUN python -m playwright install --with-deps chromium-headless-shell && chmod -R a+rX /ms-playwright
COPY . .
RUN pip install --no-cache-dir --no-deps .
RUN useradd --create-home --uid 1000 appuser && chown -R appuser:appuser /app
USER appuser
EXPOSE 8000
CMD ["uvicorn", "app.main_v2:app", "--host", "0.0.0.0", "--port", "8000"]
