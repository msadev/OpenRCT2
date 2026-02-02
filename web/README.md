# OpenRCT2 Web

Play OpenRCT2 (RollerCoaster Tycoon 2 reimplementation) directly in your browser!

## Prerequisites

- Node.js 18+
- Emscripten SDK 3.1.57+ (`C:\emsdk` or `~/emsdk`)
- Ninja build system
- CMake 3.24+

## Quick Start

```bash
cd web
npm install
npm run build:wasm
npm run dev
```

Open http://localhost:3000

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build:wasm` | Build WASM module |
| `npm run dev` | Development server |
| `npm run build:all` | Full production build |
| `npm run build:wasm -- --clean` | Clean rebuild |

## RCT2 Files

You need original RCT2 game files. Upload a ZIP containing the `Data` folder.

## Browser Requirements

- WebAssembly + SharedArrayBuffer support
- WebGL 2.0
- Modern Chrome/Firefox/Edge/Safari
