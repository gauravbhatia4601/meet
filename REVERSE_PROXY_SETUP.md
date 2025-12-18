# Reverse Proxy Setup Guide

## Problem: WebSocket Connection Fails

If you're seeing errors like:
```
WebSocket connection to 'wss://meet.technioz.com/socket.io/?EIO=4&transport=websocket' failed
```

This means your reverse proxy is not properly routing WebSocket traffic to the Docker backend.

## Solution

Your reverse proxy (nginx, Caddy, Traefik, etc.) needs to:

1. **Route `/socket.io/` to the Docker server container**
2. **Handle WebSocket upgrades correctly**
3. **Pass the correct headers**

## Configuration Examples

### Nginx (Recommended)

Add this to your nginx configuration for `meet.technioz.com`:

```nginx
server {
    listen 443 ssl http2;
    server_name meet.technioz.com;

    # ... SSL configuration ...

    # Frontend - Route root to frontend container
    location / {
        proxy_pass http://localhost:3000;  # Or your Docker frontend port
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend WebSocket - Socket.io endpoint
    location /socket.io/ {
        proxy_pass http://localhost:3001;  # Your Docker server port
        proxy_http_version 1.1;
        
        # CRITICAL: WebSocket upgrade headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket timeouts
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_connect_timeout 86400;
        
        # Disable buffering
        proxy_buffering off;
    }
}
```

### Important Notes:

1. **Port Mapping**: Replace `localhost:3000` and `localhost:3001` with the actual ports where your Docker containers are exposed:
   - Frontend: Usually port `3000` (from `docker-compose.yml`)
   - Server: Usually port `3001` (from `docker-compose.yml`)

2. **Docker Network**: If your reverse proxy is on the host machine (not in Docker), use `localhost:PORT`. If it's in the same Docker network, use the service names (`frontend:80`, `server:3001`).

3. **Path Matching**: The `/socket.io/` location block must come **before** the `/` location block in nginx, or use a more specific prefix match.

## Testing

After updating your reverse proxy configuration:

1. **Restart your reverse proxy**:
   ```bash
   sudo nginx -t  # Test configuration
   sudo systemctl reload nginx  # Reload nginx
   ```

2. **Test WebSocket endpoint**:
   ```bash
   curl -i -N \
     -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" \
     -H "Sec-WebSocket-Key: test" \
     https://meet.technioz.com/socket.io/?EIO=4&transport=websocket
   ```
   
   You should see a `101 Switching Protocols` response if WebSocket is working.

3. **Check browser console**: After refreshing your app, you should see `[SignalingClient] Connected to signaling server` instead of connection errors.

## Common Issues

### Issue 1: "Connection refused" or "timeout"
- **Cause**: Reverse proxy isn't routing to the correct port
- **Fix**: Verify Docker containers are running and ports are exposed:
  ```bash
  docker ps
  docker-compose ps
  ```

### Issue 2: "404 Not Found"
- **Cause**: `/socket.io/` path not being matched by reverse proxy
- **Fix**: Ensure the `/socket.io/` location block is defined and comes before the `/` block

### Issue 3: "502 Bad Gateway"
- **Cause**: Backend server not running or not accessible
- **Fix**: Check if the server container is healthy:
  ```bash
  curl http://localhost:3001/health
  ```

### Issue 4: WebSocket connects but immediately disconnects
- **Cause**: Missing or incorrect WebSocket upgrade headers
- **Fix**: Ensure `Upgrade` and `Connection` headers are set correctly in the reverse proxy config

## Using the Docker Nginx Service (Alternative)

If you want to use the Docker nginx service instead of a host-level reverse proxy:

1. Uncomment the `nginx` service in `docker-compose.yml`
2. Update the SSL certificate paths in the volume mount
3. Remove port mappings from `frontend` and `server` services (nginx handles external access)
4. Restart containers: `docker-compose up -d`

This is useful if you don't have an existing reverse proxy setup.

