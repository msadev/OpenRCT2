/**
 * OpenRCT2 WebSocket to TCP Proxy
 *
 * This proxy allows web browsers to connect to OpenRCT2 game servers
 * by translating WebSocket connections to raw TCP connections.
 *
 * Usage:
 *   node websocket-proxy.js [port]
 *   LOG_LEVEL=debug node websocket-proxy.js [port]
 *
 * Default port: 8080
 *
 * Endpoints:
 *   WebSocket: ws://proxy:8080/connect/<host>/<port> - Direct TCP connection
 *   HTTP GET:  http://proxy:8080/servers - Online server list
 *   HTTP GET:  http://proxy:8080/health - Health check
 */

import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import net from 'net';

const PROXY_PORT = parseInt(process.argv[2]) || 8080;

// Log levels: 'error' (prod), 'info' (default), 'debug' (dev)
const LOG_LEVEL = process.env.LOG_LEVEL || 'debug';
const LOG_LEVELS = { error: 0, info: 1, debug: 2 };

const MASTER_SERVER_URL = process.env.MASTER_SERVER_URL || 'https://servers.openrct2.io';

// Cache for server list (refresh every 60 seconds)
let serverListCache = null;
let serverListCacheTime = 0;
const CACHE_TTL = 60000;

function log(category, message, data = null, level = 'info') {
  if (LOG_LEVELS[level] > LOG_LEVELS[LOG_LEVEL]) return;

  const timestamp = new Date().toISOString().substring(11, 23);
  const prefix = `[${timestamp}] [${category}]`;
  if (data !== null) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

// Security: List of allowed ports (default OpenRCT2 port + extra range)
const ALLOWED_PORTS = [
  11753, 11754, 11755, 11756, 11757, 11758, 11759, 11760, 11761, 11762, 11763,
];

// Security: Optional allowlist of servers (empty = allow all)
const ALLOWED_SERVERS = [];

// Create HTTP server
const httpServer = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /servers - Return cached server list from master server
  if (req.method === 'GET' && req.url === '/servers') {
    try {
      const now = Date.now();

      if (serverListCache && (now - serverListCacheTime) < CACHE_TTL) {
        log('HTTP', 'Returning cached server list', null, 'debug');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(serverListCache));
        return;
      }

      log('HTTP', `Fetching server list from ${MASTER_SERVER_URL}...`, null, 'info');
      const response = await fetch(MASTER_SERVER_URL, {
        headers: { 'Accept': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      serverListCache = data;
      serverListCacheTime = now;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (err) {
      log('HTTP', `Error fetching server list: ${err.message}`, null, 'error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /health - Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // 404 for other requests
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Max buffer before applying backpressure (64KB)
const MAX_WS_BUFFER = 64 * 1024;

function handleConnection(ws, targetHost, targetPort) {
  const target = `${targetHost}:${targetPort}`;
  log('PROXY', `Connecting to ${target}`, null, 'debug');

  const tcpSocket = net.createConnection({
    host: targetHost,
    port: targetPort,
  });

  // Timeout for connection attempt (10 seconds)
  const connectTimeout = setTimeout(() => {
    if (!connected) {
      log('PROXY', `Connection timeout to ${target}`, null, 'error');
      tcpSocket.destroy();
      if (ws.readyState === ws.OPEN) {
        ws.close(1011, 'Connection timeout');
      }
    }
  }, 10000);

  let connected = false;
  let pendingMessages = [];

  tcpSocket.on('connect', () => {
    clearTimeout(connectTimeout);
    connected = true;
    log('PROXY', `Connected to ${target}`, null, 'debug');

    // Flush any messages that arrived before TCP connected
    for (const msg of pendingMessages) {
      log('PROXY', `WS->TCP ${target}: ${msg.length} bytes (flushed)`, null, 'debug');
      tcpSocket.write(msg);
    }
    pendingMessages = [];
  });

  tcpSocket.on('data', (data) => {
    log('PROXY', `TCP->WS ${target}: ${data.length} bytes`, null, 'debug');
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
      if (ws.bufferedAmount > MAX_WS_BUFFER) {
        tcpSocket.pause();
      }
    }
  });

  ws.on('drain', () => {
    if (!tcpSocket.destroyed) tcpSocket.resume();
  });

  tcpSocket.on('error', (err) => {
    clearTimeout(connectTimeout);
    log('PROXY', `TCP error (${target}): ${err.message}`, null, 'error');
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, `TCP error: ${err.message}`);
    }
  });

  tcpSocket.on('close', () => {
    log('PROXY', `Disconnected from ${target}`, null, 'debug');
    if (ws.readyState === ws.OPEN) {
      ws.close(1000, 'TCP connection closed');
    }
  });

  ws.on('message', (data) => {
    log('PROXY', `WS->TCP ${target}: ${data.length} bytes`, null, 'debug');

    if (!connected) {
      pendingMessages.push(data);
      return;
    }

    if (!tcpSocket.destroyed) {
      const canWrite = tcpSocket.write(data);
      if (!canWrite) {
        ws._socket.pause();
        tcpSocket.once('drain', () => {
          if (ws.readyState === ws.OPEN) ws._socket.resume();
        });
      }
    }
  });

  ws.on('close', () => {
    log('PROXY', `Client disconnected from ${target}`, null, 'debug');
    tcpSocket.destroy();
  });

  ws.on('error', (err) => {
    log('PROXY', `WebSocket error: ${err.message}`, null, 'error');
    tcpSocket.destroy();
  });
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');

  // Handle connections: /connect/<host>/<port>
  if (urlParts.length < 4 || urlParts[1] !== 'connect') {
    log('WS', `Invalid URL: ${req.url}`, null, 'error');
    ws.close(1008, 'Invalid URL format. Use /connect/<host>/<port>');
    return;
  }

  const targetHost = urlParts[2];
  const targetPort = parseInt(urlParts[3]);

  if (!targetHost || isNaN(targetPort)) {
    ws.close(1008, 'Invalid host or port');
    return;
  }

  if (!ALLOWED_PORTS.includes(targetPort)) {
    log('WS', `Rejected: port ${targetPort} not allowed`, null, 'error');
    ws.close(1008, 'Port not allowed');
    return;
  }

  if (ALLOWED_SERVERS.length > 0 && !ALLOWED_SERVERS.includes(targetHost)) {
    log('WS', `Rejected: ${targetHost} not in allowlist`, null, 'error');
    ws.close(1008, 'Server not in allowlist');
    return;
  }

  handleConnection(ws, targetHost, targetPort);
});

httpServer.listen(PROXY_PORT, () => {
  log('SERVER', `OpenRCT2 WebSocket Proxy listening on port ${PROXY_PORT} (LOG_LEVEL=${LOG_LEVEL})`);
});

process.on('SIGINT', () => {
  log('SERVER', 'Shutting down...');
  httpServer.close(() => {
    process.exit(0);
  });
});
