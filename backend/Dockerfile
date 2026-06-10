FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# The 通义 web bridge (app/web_bridge.py) must drive a *real* Google Chrome — consumer
# sites gate uploads against bundled headless Chromium. Install Chrome + its deps, plus
# Xvfb so we can run it headful on a headless server.
# The cloud role does not need a browser; set INSTALL_BROWSER=false to build a lean image.
ARG INSTALL_BROWSER=true
RUN if [ "$INSTALL_BROWSER" = "true" ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends xvfb \
        && rm -rf /var/lib/apt/lists/* \
        && playwright install --with-deps chrome ; \
    fi

COPY app ./app
COPY scripts ./scripts

EXPOSE 8000

# Run behind a virtual X display so real Chrome can launch headful inside the container.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", \
     "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
