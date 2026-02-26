# Garmin MCP — Docker Deployment

Hosts the Garmin MCP server with OAuth 2.0 security, ready to connect to claude.ai.

## Architecture

```
claude.ai → nginx (443) → oauth-proxy (8101) → supergateway (8100) → garmin_mcp
```

- **supergateway** wraps the Garmin MCP stdio server as Streamable HTTP
- **oauth-proxy** adds OAuth 2.0 client credentials auth in front
- **nginx** handles SSL termination

## Port Allocation

| Port | Service |
|------|---------|
| 8101 | oauth-proxy + supergateway (internal) |
| 443  | nginx (public HTTPS) |

## Prerequisites

- Docker + Docker Compose installed on your VPS
- nginx + certbot installed
- Domain pointing to your VPS IP

## Deployment

### 1. Clone this repo on your VPS

```bash
git clone <your-repo> garmin-mcp
cd garmin-mcp
```

### 2. Set up environment variables

```bash
cp .env.example .env
nano .env
```

Generate strong secrets:
```bash
openssl rand -hex 32  # run twice, use for CLIENT_ID and CLIENT_SECRET
```

### 3. Build the Docker image

```bash
docker compose build
```

### 4. Authenticate with Garmin (one-time setup)

```bash
chmod +x auth.sh
./auth.sh
```

This opens an interactive prompt for your Garmin email, password, and MFA code.
Tokens are stored in a Docker volume and persist across container restarts.

### 5. Start the service

```bash
docker compose up -d
```

Check it's running:
```bash
docker compose ps
docker compose logs -f
```

Test the health endpoint:
```bash
curl http://localhost:8101/health
```

### 6. Set up SSL certificate

```bash
sudo systemctl stop nginx
sudo certbot certonly --standalone -d garmin.yourdomain.com
sudo systemctl start nginx
```

Set up auto-renewal hooks:
```bash
sudo nano /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
# Add: systemctl stop nginx

sudo nano /etc/letsencrypt/renewal-hooks/post/start-nginx.sh  
# Add: systemctl start nginx

sudo chmod +x /etc/letsencrypt/renewal-hooks/pre/stop-nginx.sh
sudo chmod +x /etc/letsencrypt/renewal-hooks/post/start-nginx.sh

sudo certbot renew --dry-run
```

### 7. Configure nginx

```bash
sudo cp nginx-garmin.conf /etc/nginx/sites-available/garmin-mcp
# Edit the file and replace yourdomain.com with your actual domain
sudo nano /etc/nginx/sites-available/garmin-mcp

sudo ln -s /etc/nginx/sites-available/garmin-mcp /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 8. Add to claude.ai

Settings → Integrations → Add custom connector:

- **Name:** Garmin
- **Remote MCP server URL:** `https://garmin.yourdomain.com/mcp`
- **OAuth Client ID:** your CLIENT_ID from .env
- **OAuth Client Secret:** your CLIENT_SECRET from .env

## Maintenance

### Re-authenticate Garmin (when tokens expire)

```bash
./auth.sh
docker compose restart
```

### View logs

```bash
docker compose logs -f
```

### Update to latest garmin_mcp

```bash
docker compose build --no-cache
docker compose up -d
```

### Stop / restart

```bash
docker compose stop
docker compose restart
```
