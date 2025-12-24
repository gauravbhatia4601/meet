# Quick Start Guide

## Prerequisites

- Node.js 20+ installed
- npm or yarn package manager

## Starting the Application

### 1. Install Dependencies

```bash
# Install frontend dependencies
npm install

# Install server dependencies
cd server
npm install
cd ..
```

### 2. Start the Signaling Server

**Important**: The signaling server MUST be running before you can join meetings!

```bash
cd server
npm run dev
```

You should see:
```
🚀 Nebula Meet Signaling Server running on port 3001
📡 CORS enabled for: http://localhost:5173
👥 Max participants per room: 50
⏱️  Room timeout: 60 minutes

📊 Health check: http://localhost:3001/health
📈 Stats: http://localhost:3001/stats
```

### 3. Start the Frontend (in a new terminal)

```bash
npm run dev
```

The frontend will start on `http://localhost:5173` (or another port if 5173 is busy).

## Troubleshooting

### "Cannot connect to signaling server" Error

If you see connection errors:

1. **Check if server is running**:
   ```bash
   lsof -i :3001
   # or
   curl http://localhost:3001/health
   ```

2. **Verify server is listening on correct port**:
   - Check `server/.env` or environment variables
   - Default port is `3001`

3. **Check CORS configuration**:
   - Server CORS must allow your frontend URL
   - Default: `http://localhost:5173` (Vite default)
   - Update `CORS_ORIGIN` in server `.env` if using different port

4. **Firewall/Network Issues**:
   - Ensure port 3001 is not blocked
   - Check if another process is using port 3001

### Environment Variables

Create `server/.env` file:
```env
PORT=3001
CORS_ORIGIN=http://localhost:5173
MAX_PARTICIPANTS_PER_ROOM=50
ROOM_TIMEOUT_MINUTES=60
```

Create `.env` file in root for frontend:
```env
VITE_SIGNALING_SERVER_URL=http://localhost:3001
```

## Production Deployment

See `docker-compose.yml` for Docker deployment or check deployment documentation.

## Common Issues

### Port Already in Use

If port 3001 is already in use:
```bash
# Find process using port 3001
lsof -i :3001

# Kill the process (replace PID with actual process ID)
kill -9 <PID>

# Or change port in server/.env
PORT=3002
```

### WebSocket Connection Failed

- Ensure server is running BEFORE starting frontend
- Check browser console for detailed error messages
- Verify `VITE_SIGNALING_SERVER_URL` matches server URL
- For HTTPS frontend, ensure server URL uses `https://` or `wss://`

