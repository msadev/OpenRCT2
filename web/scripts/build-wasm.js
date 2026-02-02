#!/usr/bin/env node

/**
 * OpenRCT2 WASM Build Script
 * Builds OpenRCT2 for WebAssembly using Emscripten SDK
 * No Docker required - uses local emsdk installation
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const WEB_DIR = join(__dirname, '..');
const BUILD_WASM_DIR = join(ROOT_DIR, 'build-wasm');
const DEPS_DIR = join(ROOT_DIR, 'build-wasm-deps');
const DIST_DIR = join(WEB_DIR, 'static');

const IS_WINDOWS = platform() === 'win32';
const EMSDK_VERSION = '3.1.57';

// Dependency versions
const DEPS = {
  speexdsp: {
    url: 'https://github.com/xiph/speexdsp/archive/refs/tags/SpeexDSP-1.2.1.tar.gz',
    dir: 'speexdsp-SpeexDSP-1.2.1',
    version: '1.2.1'
  },
  icu: {
    url: 'https://github.com/nicolo-ribaudo/nicolo-nicolo-nicolo.nicolo/nicolo-nicolo-releases/download/release-74-2/icu4c-74_2-src.tgz',
    // ICU is complex - we'll use Emscripten's port instead
    version: '74.2'
  },
  libzip: {
    url: 'https://github.com/nih-at/libzip/releases/download/v1.10.1/libzip-1.10.1.tar.gz',
    dir: 'libzip-1.10.1',
    version: '1.10.1'
  },
  zstd: {
    url: 'https://github.com/facebook/zstd/releases/download/v1.5.5/zstd-1.5.5.tar.gz',
    dir: 'zstd-1.5.5',
    version: '1.5.5'
  },
  nlohmann_json: {
    // Header-only, just download
    url: 'https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp',
    version: '3.11.3'
  }
};

// Common emsdk locations
const EMSDK_PATHS = IS_WINDOWS
  ? [
      join(homedir(), 'emsdk'),
      'C:\\emsdk',
      join(process.env.LOCALAPPDATA || '', 'emsdk'),
      join(ROOT_DIR, 'emsdk')
    ]
  : [
      join(homedir(), 'emsdk'),
      '/opt/emsdk',
      '/usr/local/emsdk',
      join(ROOT_DIR, 'emsdk')
    ];

let EMSDK_DIR = null;

/**
 * Execute a command and stream output
 */
function exec(command, options = {}) {
  console.log(`\n> ${command}\n`);
  try {
    const mergedEnv = { ...process.env, ...options.env };
    execSync(command, {
      stdio: 'inherit',
      cwd: options.cwd || ROOT_DIR,
      shell: true,
      env: mergedEnv,
      ...options
    });
    return true;
  } catch (e) {
    if (options.ignoreError) return false;
    console.error(`Command failed: ${command}`);
    process.exit(1);
  }
}

/**
 * Execute and return output
 */
function execOutput(command, options = {}) {
  try {
    const mergedEnv = { ...process.env, ...options.env };
    return execSync(command, {
      cwd: options.cwd || ROOT_DIR,
      shell: true,
      encoding: 'utf8',
      env: mergedEnv,
      ...options
    }).trim();
  } catch (e) {
    if (options.debug) {
      console.error('execOutput error:', e.message);
    }
    return null;
  }
}

/**
 * Find emsdk installation
 */
function findEmsdk() {
  // Check if emcc is already in PATH
  const emccPath = execOutput(IS_WINDOWS ? 'where emcc 2>nul' : 'which emcc 2>/dev/null');
  if (emccPath) {
    console.log(`Found emcc in PATH: ${emccPath}`);
    return 'PATH';
  }

  // Check common locations
  for (const path of EMSDK_PATHS) {
    const emsdkScript = IS_WINDOWS
      ? join(path, 'emsdk.bat')
      : join(path, 'emsdk');

    if (existsSync(emsdkScript)) {
      console.log(`Found emsdk at: ${path}`);
      return path;
    }
  }

  return null;
}

/**
 * Activate emsdk (Windows)
 */
function activateEmsdk() {
  if (EMSDK_DIR === 'PATH' || !IS_WINDOWS) {
    return;
  }

  console.log('Activating emsdk...');
  const emsdk = join(EMSDK_DIR, 'emsdk.bat');

  // Activate the installed version
  try {
    execSync(`"${emsdk}" activate ${EMSDK_VERSION}`, {
      cwd: EMSDK_DIR,
      stdio: 'inherit',
      shell: 'cmd.exe'
    });
  } catch (e) {
    console.warn('emsdk activate warning (may be already active)');
  }
}

/**
 * Get emsdk environment variables
 */
function getEmsdkEnv() {
  if (EMSDK_DIR === 'PATH') {
    return process.env;
  }

  const env = { ...process.env };

  if (IS_WINDOWS) {
    // Build emsdk environment manually for Windows
    const emscriptenDir = join(EMSDK_DIR, 'upstream', 'emscripten');
    const llvmDir = join(EMSDK_DIR, 'upstream', 'bin');

    // Find node directory (version may vary)
    let nodeDir = '';
    const nodePath = join(EMSDK_DIR, 'node');
    if (existsSync(nodePath)) {
      const nodeDirs = readdirSync(nodePath).filter(d => d.includes('64bit'));
      if (nodeDirs.length > 0) {
        nodeDir = join(nodePath, nodeDirs[0], 'bin');
      }
    }

    // Find python directory
    let pythonDir = '';
    const pythonPath = join(EMSDK_DIR, 'python');
    if (existsSync(pythonPath)) {
      const pythonDirs = readdirSync(pythonPath).filter(d => d.includes('64bit'));
      if (pythonDirs.length > 0) {
        pythonDir = join(pythonPath, pythonDirs[0]);
      }
    }

    // Prepend emsdk paths to PATH (Windows uses 'Path' not 'PATH')
    const emsdkPaths = [emscriptenDir, llvmDir, nodeDir, pythonDir, EMSDK_DIR].filter(Boolean);
    const currentPath = env.PATH || env.Path || '';
    env.PATH = emsdkPaths.join(';') + ';' + currentPath;
    // Also set Path for Windows compatibility
    env.Path = env.PATH;

    // Set emsdk environment variables
    env.EMSDK = EMSDK_DIR;
    env.EMSDK_NODE = nodeDir ? join(nodeDir, 'node.exe') : '';
    env.EM_CONFIG = join(EMSDK_DIR, '.emscripten');

    console.log('Configured emsdk environment manually');
    console.log('Emscripten dir:', emscriptenDir);
  } else {
    const envScript = join(EMSDK_DIR, 'emsdk_env.sh');

    if (!existsSync(envScript)) {
      console.error('emsdk_env script not found');
      return process.env;
    }

    const envOutput = execOutput(`source "${envScript}" && env`, { cwd: EMSDK_DIR });

    if (!envOutput) return process.env;

    for (const line of envOutput.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.substring(0, idx);
        const value = line.substring(idx + 1);
        env[key] = value;
      }
    }
  }

  return env;
}

/**
 * Install emsdk
 */
async function installEmsdk() {
  const installDir = join(ROOT_DIR, 'emsdk');

  console.log('\n=== Installing Emscripten SDK ===\n');
  console.log(`Installing to: ${installDir}`);

  if (!existsSync(installDir)) {
    exec(`git clone https://github.com/emscripten-core/emsdk.git "${installDir}"`);
  }

  const emsdk = IS_WINDOWS ? 'emsdk.bat' : './emsdk';

  exec(`${emsdk} install ${EMSDK_VERSION}`, { cwd: installDir });
  exec(`${emsdk} activate ${EMSDK_VERSION}`, { cwd: installDir });

  return installDir;
}

/**
 * Download and extract a dependency
 */
async function downloadDep(name, url, destDir) {
  const { default: fetch } = await import('node-fetch');
  const { createWriteStream } = await import('fs');
  const { pipeline } = await import('stream/promises');

  console.log(`\nDownloading ${name}...`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${name}: ${response.statusText}`);
  }

  const fileName = url.split('/').pop();
  const filePath = join(destDir, fileName);

  await pipeline(response.body, createWriteStream(filePath));

  // Extract
  if (fileName.endsWith('.tar.gz') || fileName.endsWith('.tgz')) {
    exec(`tar -xzf "${fileName}"`, { cwd: destDir });
  } else if (fileName.endsWith('.zip')) {
    exec(`unzip "${fileName}"`, { cwd: destDir });
  }

  return filePath;
}

/**
 * Build dependencies for Emscripten
 */
async function buildDependencies(env) {
  console.log('\n=== Building Dependencies ===\n');

  if (!existsSync(DEPS_DIR)) {
    mkdirSync(DEPS_DIR, { recursive: true });
  }

  const emscriptenDir = EMSDK_DIR === 'PATH'
    ? execOutput('dirname $(which emcc)', { env })
    : join(EMSDK_DIR, 'upstream', 'emscripten');

  const toolchainFile = join(emscriptenDir, 'cmake', 'Modules', 'Platform', 'Emscripten.cmake').replace(/\\/g, '/');

  // Build zstd
  const zstdDir = join(DEPS_DIR, 'zstd');
  const zstdLibPath = join(zstdDir, 'build', 'lib', 'libzstd.a');
  if (!existsSync(zstdLibPath)) {
    console.log('\n--- Building zstd ---\n');
    if (!existsSync(zstdDir)) {
      exec(`git clone --depth 1 --branch v1.5.5 https://github.com/facebook/zstd.git "${zstdDir}"`);
    }
    const zstdBuildDir = join(zstdDir, 'build', 'cmake', 'build');
    mkdirSync(zstdBuildDir, { recursive: true });
    exec([
      'emcmake cmake ..',
      '-G Ninja',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DZSTD_BUILD_PROGRAMS=OFF',
      '-DZSTD_BUILD_TESTS=OFF',
      '-DZSTD_BUILD_SHARED=OFF'
    ].join(' '), { cwd: zstdBuildDir, env });
    exec('ninja', { cwd: zstdBuildDir, env });
    // Copy library to expected location
    mkdirSync(join(zstdDir, 'build', 'lib'), { recursive: true });
    copyFileSync(join(zstdBuildDir, 'lib', 'libzstd.a'), zstdLibPath);
  } else {
    console.log('zstd already built, skipping...');
  }

  // Build libzip
  const libzipDir = join(DEPS_DIR, 'libzip');
  const libzipLibPath = join(libzipDir, 'build', 'lib', 'libzip.a');
  if (!existsSync(libzipLibPath)) {
    console.log('\n--- Building libzip ---\n');
    if (!existsSync(libzipDir)) {
      exec(`git clone --depth 1 --branch v1.10.1 https://github.com/nih-at/libzip.git "${libzipDir}"`);
    }
    const libzipBuildDir = join(libzipDir, 'build');
    mkdirSync(libzipBuildDir, { recursive: true });
    exec([
      'emcmake cmake ..',
      '-G Ninja',
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DBUILD_DOC=OFF',
      '-DBUILD_EXAMPLES=OFF',
      '-DBUILD_REGRESS=OFF',
      '-DBUILD_TOOLS=OFF',
      '-DENABLE_BZIP2=OFF',
      '-DENABLE_LZMA=OFF',
      '-DENABLE_ZSTD=OFF',
      '-DENABLE_OPENSSL=OFF'
    ].join(' '), { cwd: libzipBuildDir, env });
    exec('ninja', { cwd: libzipBuildDir, env });
  } else {
    console.log('libzip already built, skipping...');
  }

  // Build speexdsp
  const speexdspDir = join(DEPS_DIR, 'speexdsp');
  const speexdspLibPath = join(speexdspDir, 'libspeexdsp', '.libs', 'libspeexdsp.a');
  if (!existsSync(speexdspLibPath)) {
    console.log('\n--- Building speexdsp ---\n');
    if (!existsSync(speexdspDir)) {
      exec(`git clone --depth 1 --branch SpeexDSP-1.2.1 https://github.com/xiph/speexdsp.git "${speexdspDir}"`);
    }
    // speexdsp uses autotools
    exec('./autogen.sh', { cwd: speexdspDir, env, ignoreError: true });
    exec([
      'emconfigure ./configure',
      '--disable-shared',
      '--enable-static',
      '--disable-examples'
    ].join(' '), { cwd: speexdspDir, env });
    exec('emmake make -j4', { cwd: speexdspDir, env });
  } else {
    console.log('speexdsp already built, skipping...');
  }

  // nlohmann/json - header only
  const jsonDir = join(DEPS_DIR, 'nlohmann');
  const jsonHeader = join(jsonDir, 'json.hpp');
  if (!existsSync(jsonHeader)) {
    console.log('\n--- Downloading nlohmann/json ---\n');
    mkdirSync(jsonDir, { recursive: true });
    exec(`curl -L -o "${jsonHeader}" https://github.com/nlohmann/json/releases/download/v3.11.3/json.hpp`);
  } else {
    console.log('nlohmann/json already present, skipping...');
  }

  return {
    zstdLib: zstdLibPath.replace(/\\/g, '/'),
    zstdInclude: join(zstdDir, 'lib').replace(/\\/g, '/'),
    libzipLib: libzipLibPath.replace(/\\/g, '/'),
    libzipInclude: join(libzipDir, 'lib').replace(/\\/g, '/'),
    speexdspLib: speexdspLibPath.replace(/\\/g, '/'),
    speexdspInclude: join(speexdspDir, 'include').replace(/\\/g, '/'),
    jsonInclude: DEPS_DIR.replace(/\\/g, '/')
  };
}

/**
 * Build WASM module
 */
function buildWasm(env, depsPaths) {
  console.log('\n=== Building WASM Module ===\n');

  if (!existsSync(BUILD_WASM_DIR)) {
    mkdirSync(BUILD_WASM_DIR, { recursive: true });
  }

  const emscriptenDir = EMSDK_DIR === 'PATH'
    ? execOutput('dirname $(which emcc)', { env })
    : join(EMSDK_DIR, 'upstream', 'emscripten');

  const toolchainFile = join(emscriptenDir, 'cmake', 'Modules', 'Platform', 'Emscripten.cmake').replace(/\\/g, '/');

  // Emscripten flags from OpenRCT2's build script
  const emscriptenFlags = '-sUSE_SDL=2 -sUSE_ZLIB=1 -sUSE_BZIP2=1 -sUSE_LIBPNG=1 -pthread -O3';
  const emscriptenExportedFunctions = '_GetVersion,_main';
  const emscriptenLdFlags = [
    '-Wno-pthreads-mem-growth',
    '-sSAFE_HEAP=0',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sMAXIMUM_MEMORY=4GB',
    '-sINITIAL_MEMORY=2GB',
    '-sSTACK_SIZE=8388608',
    '-sMIN_WEBGL_VERSION=2',
    '-sMAX_WEBGL_VERSION=2',
    '-sPTHREAD_POOL_SIZE=120',
    '-pthread',
    '-sEXPORTED_RUNTIME_METHODS=ccall,FS,callMain,UTF8ToString,stringToNewUTF8',
    '-lidbfs.js',
    '--use-preload-plugins',
    '-sMODULARIZE=1',
    '-sEXPORT_NAME="OPENRCT2_WEB"',
    '-Wl,--export-if-defined=LoadGameCallback'
  ].join(' ');

  const cmakeCmd = [
    'emcmake cmake ..',
    '-G Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DDISABLE_NETWORK=ON',
    '-DDISABLE_OPENGL=ON',
    '-DDISABLE_HTTP=ON',
    '-DDISABLE_TTF=ON',
    '-DDISABLE_FLAC=ON',
    '-DDISABLE_DISCORD_RPC=ON',
    `-DSPEEXDSP_INCLUDE_DIR="${depsPaths.speexdspInclude}"`,
    `-DSPEEXDSP_LIBRARY="${depsPaths.speexdspLib}"`,
    `-DLIBZIP_LIBRARIES="${depsPaths.libzipLib}"`,
    `-DLIBZIP_INCLUDE_DIRS="${depsPaths.libzipInclude}"`,
    `-DZSTD_LIBRARIES="${depsPaths.zstdLib}"`,
    `-DZSTD_INCLUDE_DIRS="${depsPaths.zstdInclude}"`,
    `-DEMSCRIPTEN_FLAGS="${emscriptenFlags}"`,
    `-DEMSCRIPTEN_EXPORTED_FUNCTIONS="${emscriptenExportedFunctions}"`,
    `-DEMSCRIPTEN_LDFLAGS="${emscriptenLdFlags}"`
  ].join(' ');

  exec(cmakeCmd, { cwd: BUILD_WASM_DIR, env });

  // Build
  exec('ninja', { cwd: BUILD_WASM_DIR, env });
}

/**
 * Copy build artifacts to web directory
 */
function copyArtifacts() {
  console.log('\n=== Copying Build Artifacts ===\n');

  if (!existsSync(DIST_DIR)) {
    mkdirSync(DIST_DIR, { recursive: true });
  }

  const artifacts = [
    'openrct2.js',
    'openrct2.wasm',
    'openrct2.worker.js'
  ];

  let copied = 0;

  for (const file of artifacts) {
    const src = join(BUILD_WASM_DIR, file);
    const dest = join(DIST_DIR, file);

    if (existsSync(src)) {
      console.log(`Copying ${file}...`);
      copyFileSync(src, dest);
      copied++;
    } else {
      console.warn(`Warning: ${file} not found`);
    }
  }

  // Also copy any .data files
  if (existsSync(BUILD_WASM_DIR)) {
    const dataFiles = readdirSync(BUILD_WASM_DIR).filter(f =>
      f.endsWith('.data') || (f.startsWith('openrct2') && !artifacts.includes(f))
    );
    for (const file of dataFiles) {
      const src = join(BUILD_WASM_DIR, file);
      const dest = join(DIST_DIR, file);
      console.log(`Copying ${file}...`);
      copyFileSync(src, dest);
      copied++;
    }
  }

  // Copy existing emscripten static files
  const emscriptenStatic = join(ROOT_DIR, 'emscripten', 'static');
  if (existsSync(emscriptenStatic)) {
    const staticFiles = readdirSync(emscriptenStatic);
    for (const file of staticFiles) {
      const src = join(emscriptenStatic, file);
      const dest = join(DIST_DIR, file);
      console.log(`Copying static/${file}...`);
      copyFileSync(src, dest);
    }
  }

  if (copied > 0) {
    console.log(`\n${copied} file(s) copied to web/static/`);
  } else {
    console.error('\nNo artifacts found! Build may have failed.');
    process.exit(1);
  }
}

/**
 * Print installation instructions
 */
function printInstallInstructions() {
  console.log('\n=== Emscripten SDK Not Found ===\n');
  console.log('To install Emscripten SDK:\n');

  if (IS_WINDOWS) {
    console.log('Option 1: Let this script install it');
    console.log('  node scripts/build-wasm.js --install\n');
    console.log('Option 2: Manual installation');
    console.log('  git clone https://github.com/emscripten-core/emsdk.git C:\\emsdk');
    console.log('  cd C:\\emsdk');
    console.log(`  emsdk install ${EMSDK_VERSION}`);
    console.log(`  emsdk activate ${EMSDK_VERSION}`);
    console.log('  emsdk_env.bat');
  } else {
    console.log('Option 1: Let this script install it');
    console.log('  node scripts/build-wasm.js --install\n');
    console.log('Option 2: Manual installation');
    console.log('  git clone https://github.com/emscripten-core/emsdk.git ~/emsdk');
    console.log('  cd ~/emsdk');
    console.log(`  ./emsdk install ${EMSDK_VERSION}`);
    console.log(`  ./emsdk activate ${EMSDK_VERSION}`);
    console.log('  source ./emsdk_env.sh');
  }

  console.log('\nThen run this script again:');
  console.log('  npm run build:wasm');
}

/**
 * Main build process
 */
async function main() {
  const args = process.argv.slice(2);

  console.log('=================================');
  console.log('  OpenRCT2 WASM Build Script');
  console.log(`  Platform: ${platform()}`);
  console.log('=================================\n');

  // Handle --help
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/build-wasm.js [options]\n');
    console.log('Options:');
    console.log('  --help, -h     Show this help');
    console.log('  --install      Install Emscripten SDK if not found');
    console.log('  --clean        Clean build directories before building');
    console.log('  --skip-deps    Skip building dependencies (if already built)');
    process.exit(0);
  }

  // Handle --clean
  if (args.includes('--clean')) {
    console.log('Cleaning build directories...');
    if (existsSync(BUILD_WASM_DIR)) {
      rmSync(BUILD_WASM_DIR, { recursive: true, force: true });
    }
    if (existsSync(DEPS_DIR) && !args.includes('--skip-deps')) {
      rmSync(DEPS_DIR, { recursive: true, force: true });
    }
  }

  // Find or install emsdk
  EMSDK_DIR = findEmsdk();

  if (!EMSDK_DIR) {
    if (args.includes('--install')) {
      EMSDK_DIR = await installEmsdk();
    } else {
      printInstallInstructions();
      process.exit(1);
    }
  }

  // Activate and get emsdk environment
  activateEmsdk();
  const env = getEmsdkEnv();

  // Verify emcc works
  const emccCmd = IS_WINDOWS ? 'emcc.bat --version' : 'emcc --version';
  const emccVersion = execOutput(emccCmd, { env, debug: true });
  if (!emccVersion) {
    // Try with full path as fallback
    if (IS_WINDOWS && EMSDK_DIR !== 'PATH') {
      const emccFullPath = join(EMSDK_DIR, 'upstream', 'emscripten', 'emcc.bat');
      console.log(`Trying full path: ${emccFullPath}`);
      const emccVersionFull = execOutput(`"${emccFullPath}" --version`, { env, debug: true });
      if (emccVersionFull) {
        console.log(`Emscripten: ${emccVersionFull.split('\n')[0]}`);
      } else {
        console.error('Error: emcc not working even with full path.');
        console.error('PATH includes:', env.PATH?.split(';').slice(0, 5).join('\n  '));
        process.exit(1);
      }
    } else {
      console.error('Error: emcc not working. Try running emsdk_env first.');
      process.exit(1);
    }
  } else {
    console.log(`Emscripten: ${emccVersion.split('\n')[0]}`);
  }

  // Build dependencies
  let depsPaths;
  if (!args.includes('--skip-deps')) {
    depsPaths = await buildDependencies(env);
  } else {
    // Assume deps are already built
    depsPaths = {
      zstdLib: join(DEPS_DIR, 'zstd', 'build', 'lib', 'libzstd.a').replace(/\\/g, '/'),
      zstdInclude: join(DEPS_DIR, 'zstd', 'lib').replace(/\\/g, '/'),
      libzipLib: join(DEPS_DIR, 'libzip', 'build', 'lib', 'libzip.a').replace(/\\/g, '/'),
      libzipInclude: join(DEPS_DIR, 'libzip', 'lib').replace(/\\/g, '/'),
      speexdspLib: join(DEPS_DIR, 'speexdsp', 'libspeexdsp', '.libs', 'libspeexdsp.a').replace(/\\/g, '/'),
      speexdspInclude: join(DEPS_DIR, 'speexdsp', 'include').replace(/\\/g, '/'),
      jsonInclude: DEPS_DIR.replace(/\\/g, '/')
    };
  }

  // Build WASM
  buildWasm(env, depsPaths);

  // Copy artifacts
  copyArtifacts();

  console.log('\n=================================');
  console.log('  Build Complete!');
  console.log('=================================');
  console.log('\nTo run the game:');
  console.log('  cd web');
  console.log('  npm run dev');
}

main().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
