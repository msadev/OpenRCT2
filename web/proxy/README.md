# OpenRCT2 WebSocket Proxy

This proxy server allows the OpenRCT2 web version to connect to standard OpenRCT2 game servers by translating WebSocket connections to raw TCP connections.

```
[Browser] --WebSocket--> [Proxy Server] --TCP--> [OpenRCT2 Server]
```

## Quick Start

1. Install dependencies:

```bash
cd web/proxy
npm install
```

2. Start the proxy:

```bash
node websocket-proxy.js 8080
```

## Configure the Web Client

Before starting OpenRCT2 in the browser, set the proxy URL in your page or console:

```js
window.openrct2_websocket_proxy = 'ws://localhost:8080';
// For production (HTTPS) - proxy must have SSL certificate
window.openrct2_websocket_proxy = 'wss://your-proxy.example.com';
```

The web client will automatically route multiplayer connections through the proxy.

## Endpoints

- WebSocket: `ws://proxy:8080/connect/<host>/<port>` - Connect to a game server
- HTTP GET: `http://proxy:8080/servers` - Online server list
- HTTP GET: `http://proxy:8080/health` - Health check

## Security Notes

- The proxy only allows specific ports by default (see `ALLOWED_PORTS` in `websocket-proxy.js`).
- You can restrict to specific servers by adding hostnames/IPs to `ALLOWED_SERVERS`.
- For public deployments, place this proxy behind a reverse proxy (nginx, Caddy) with TLS.
