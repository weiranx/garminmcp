FROM node:20-slim

# Install Python and uv dependencies
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Pre-install supergateway
RUN npm install -g supergateway

# Pre-fetch garmin_mcp so it's cached in the image
RUN uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp --help || true

WORKDIR /app

# Copy OAuth proxy
COPY oauth-proxy.js .
COPY package.json .
RUN npm install

# Garmin tokens volume mount point
VOLUME ["/root/.garminconnect"]

EXPOSE 8101

CMD ["node", "oauth-proxy.js"]
