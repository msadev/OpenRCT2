# OpenRCT2 Web

Play OpenRCT2 (RollerCoaster Tycoon 2 reimplementation) directly in your browser!

## Prerequisites

- Node.js 18+
- Emscripten SDK 3.1.57+ (installed at `C:\emsdk` or `~/emsdk`)
- Ninja build system
- CMake 3.24+

## Quick Start

1. Install dependencies:
   ```bash
   cd web
   npm install
   ```

2. Build the WASM module:
   ```bash
   npm run build:wasm
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```

4. Open http://localhost:3000 in your browser

## Building

### Build WASM only
```bash
npm run build:wasm
```

### Build everything for production
```bash
npm run build:all
```

### Clean build
```bash
npm run build:wasm -- --clean
```

## Development

The development server uses Parcel for hot reloading of the web frontend.
WASM changes require rebuilding with `npm run build:wasm`.

## RCT2 Game Files

You need the original RollerCoaster Tycoon 2 game files to play.
When you first load the game in the browser, you'll be prompted to upload
a ZIP file containing your RCT2 `Data` folder.

## Browser Requirements

- Modern browser with WebAssembly support
- SharedArrayBuffer support (requires COOP/COEP headers)
- WebGL 2.0 support

## Notes

- Network/multiplayer is disabled in the web version
- Save files are stored in browser's IndexedDB
- Performance may vary based on park complexity
