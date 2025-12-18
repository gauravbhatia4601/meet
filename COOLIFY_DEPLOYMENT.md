# Coolify Deployment Guide for Nebula Meet

## Overview

This guide explains how to deploy Nebula Meet using Coolify, which automatically handles SSL termination and reverse proxy.

## Architecture

Nebula Meet consists of two services:
1. **Frontend**: React/Vite application (served on port 80)
2. **Backend**: Node.js/Socket.io signaling server (runs on port 3001)

## Deployment Options

### Option 1: Deploy as Docker Compose (Recommended)

This is the simplest approach - deploy your entire `docker-compose.yml` as one resource.

#### Steps:

1. **Create a new resource in Coolify:**
   - Type: **Docker Compose**
   - Connect your Git repository
   - Set build pack to use `docker-compose.yml`

2. **Configure domain:**
   - Domain: `meet.technioz.com`
   - SSL: Automatic (Coolify handles this)

3. **Set environment variables:**
   ```
   VITE_SIGNALING_SERVER_URL=https://meet.technioz.com
   CORS_ORIGIN=https://meet.technioz.com
   SERVER_PORT=3001
   FRONTEND_PORT=3000
   ```

4. **Add Custom Nginx Route for WebSocket:**

   In Coolify, go to your resource → **Advanced** → **Custom Nginx Configuration**

   Add this before the default location block:
   ```nginx
   location /socket.io/ {
       # Use the backend service name from docker-compose
       proxy_pass http://server:3001;
       proxy_http_version 1.1;
       
       # WebSocket upgrade headers
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       
       # Standard proxy headers
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       
       # WebSocket timeouts (important for long-lived connections)
       proxy_read_timeout 86400;
       proxy_send_timeout 86400;
       proxy_connect_timeout 86400;
       
       # Disable buffering
       proxy_buffering off;
   }
   ```

5. **Deploy:**
   - Save configuration
   - Coolify will build and deploy both services
   - WebSocket should work automatically

---

### Option 2: Deploy Services Separately

If you prefer to manage services separately:

#### Frontend Service:

1. **Create a new resource:**
   - Type: **Dockerfile**
   - Dockerfile: `Dockerfile.frontend`
   - Build context: Root directory

2. **Environment variables:**
   ```
   VITE_SIGNALING_SERVER_URL=https://meet.technioz.com
   ```

3. **Domain:** `meet.technioz.com`

4. **Custom Nginx Route:**
   ```nginx
   location /socket.io/ {
       # Replace with your backend service's internal URL
       proxy_pass http://<backend-internal-url>:3001;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 86400;
       proxy_send_timeout 86400;
       proxy_connect_timeout 86400;
       proxy_buffering off;
   }
   ```

#### Backend Service:

1. **Create a new resource:**
   - Type: **Dockerfile**
   - Dockerfile: `Dockerfile.server`
   - Build context: `server/` directory (or root with appropriate context)

2. **Environment variables:**
   ```
   NODE_ENV=production
   PORT=3001
   CORS_ORIGIN=https://meet.technioz.com
   MAX_PARTICIPANTS_PER_ROOM=50
   ROOM_TIMEOUT_MINUTES=60
   ```

3. **Port:** `3001` (internal only, not exposed publicly)

4. **Note:** Don't assign a public domain to the backend - it's accessed via the frontend's `/socket.io/` route

---

## Finding Service Internal URLs

When deploying separately, you need to know the backend service's internal URL:

1. Go to your **Backend** resource in Coolify
2. Check the **"Details"** or **"Networking"** section
3. Look for:
   - **Internal URL**: `http://service-name:3001`
   - **Docker Network Name**: `server` (matches docker-compose service name)
   - **Container Name**: `nebula-meet-server`

Common formats:
- Docker service name: `server` or `nebula-meet-server`
- Internal domain: `<resource-name>.coolify.internal:3001`
- Container IP: `172.x.x.x:3001` (less reliable)

**Best practice:** Use the Docker service/container name if they're in the same network.

---

## Testing the Deployment

### 1. Check Frontend:
```bash
curl https://meet.technioz.com
```
Should return the React app HTML.

### 2. Check Backend Health:
```bash
# If backend has a domain:
curl https://api.meet.technioz.com/health

# Or directly (if exposed):
curl http://<backend-ip>:3001/health
```

### 3. Test WebSocket:
```bash
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: test" \
  https://meet.technioz.com/socket.io/?EIO=4&transport=websocket
```

Should return `101 Switching Protocols` if working.

### 4. Browser Console:
Open `https://meet.technioz.com` and check the console:
- ✅ `[SignalingClient] Connected to signaling server` = Success
- ❌ `WebSocket connection failed` = Check custom route configuration

---

## Troubleshooting

### Issue: WebSocket still fails after adding custom route

**Solutions:**
1. **Verify the backend service name**: The `proxy_pass` URL must match exactly
2. **Check if services are in the same network**: Both services should use Coolify's default network
3. **Restart both services**: After adding custom route, redeploy both services
4. **Check Coolify logs**: Look for nginx/proxy errors

### Issue: 502 Bad Gateway on /socket.io/

**Cause:** Backend service not accessible or wrong URL in `proxy_pass`

**Fix:**
1. Verify backend service is running: Check Coolify dashboard
2. Test backend directly: `curl http://server:3001/health` (from frontend container)
3. Update `proxy_pass` URL to match actual backend service name

### Issue: Connection times out

**Cause:** Backend service might be on a different network

**Fix:**
1. Ensure both services are deployed in the same Coolify project
2. Check network settings - they should be on the default Coolify network
3. Try using the full internal URL with domain: `<service-name>.coolify.internal:3001`

---

## Environment Variables Reference

### Frontend (.env or Coolify environment):
```env
VITE_SIGNALING_SERVER_URL=https://meet.technioz.com
```

### Backend (.env or Coolify environment):
```env
NODE_ENV=production
PORT=3001
CORS_ORIGIN=https://meet.technioz.com
MAX_PARTICIPANTS_PER_ROOM=50
ROOM_TIMEOUT_MINUTES=60
```

**Important:** 
- `VITE_SIGNALING_SERVER_URL` should NOT include a port (Coolify handles routing)
- `CORS_ORIGIN` should match your frontend domain exactly

---

## Quick Checklist

- [ ] Both services deployed in Coolify
- [ ] Frontend has domain assigned (`meet.technioz.com`)
- [ ] Custom nginx route added for `/socket.io/` in frontend service
- [ ] `VITE_SIGNALING_SERVER_URL` set to `https://meet.technioz.com` (no port)
- [ ] `CORS_ORIGIN` matches frontend domain
- [ ] Both services restarted after configuration
- [ ] WebSocket connection tested and working

---

## Support

If you encounter issues:
1. Check Coolify resource logs
2. Verify environment variables are set correctly
3. Test WebSocket endpoint manually (see Testing section)
4. Ensure custom nginx route is added and syntax is correct

