/**
 * OpenRCT2 Web - Main Entry Point
 */

// Global state
let Module = null;
let assetsLoaded = false;

// DOM Elements
const loadingScreen = document.getElementById('loading-screen');
const setupScreen = document.getElementById('setup-screen');
const statusMessage = document.getElementById('status-message');
const progressBar = document.getElementById('progress-bar');
const rct2FilesInput = document.getElementById('rct2-files');
const uploadStatus = document.getElementById('upload-status');
const startButton = document.getElementById('start-game');
const canvas = document.getElementById('canvas');

/**
 * Update status message
 */
function setStatus(message, progress = null) {
    statusMessage.textContent = message;
    if (progress !== null) {
        progressBar.style.width = `${progress}%`;
    }
}

/**
 * Show error in upload status
 */
function showUploadError(message) {
    uploadStatus.textContent = message;
    uploadStatus.className = 'error';
    uploadStatus.style.display = 'block';
}

/**
 * Show success in upload status
 */
function showUploadSuccess(message) {
    uploadStatus.textContent = message;
    uploadStatus.className = 'success';
    uploadStatus.style.display = 'block';
}

/**
 * Check if a file exists in the virtual filesystem
 */
function fileExists(path) {
    try {
        Module.FS.readFile(path);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Load WebAssembly module
 */
async function loadWasmModule() {
    setStatus('Loading WebAssembly module...', 10);

    // Check for required browser features
    if (!window.SharedArrayBuffer) {
        setStatus('Error: SharedArrayBuffer not available. Requires COOP/COEP headers.');
        return false;
    }

    if (!window.WebAssembly) {
        setStatus('Error: WebAssembly not supported in this browser.');
        return false;
    }

    try {
        // Try to load from zip first (smaller download)
        let assets = null;
        try {
            setStatus('Downloading game files...', 20);
            const req = await fetch('openrct2.zip');
            if (req.ok) {
                const data = await req.blob();
                const zip = new JSZip();
                const contents = await zip.loadAsync(data);
                assets = {
                    js: URL.createObjectURL(new Blob([await zip.file('openrct2.js').async('uint8array')], { type: 'application/javascript' })),
                    wasm: URL.createObjectURL(new Blob([await zip.file('openrct2.wasm').async('uint8array')], { type: 'application/wasm' }))
                };
            }
        } catch (e) {
            console.warn('Failed to fetch openrct2.zip, trying individual files:', e);
        }

        setStatus('Loading game engine...', 40);

        // Load the JS module
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = assets ? assets.js : 'openrct2.js';
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });

        setStatus('Initializing engine...', 60);

        // Initialize the Emscripten module
        Module = await window.OPENRCT2_WEB({
            noInitialRun: true,
            arguments: [],
            preRun: [],
            postRun: [],
            canvas: canvas,
            print: (msg) => console.log('[OpenRCT2]', msg),
            printErr: (msg) => console.error('[OpenRCT2]', msg),
            locateFile: (fileName) => {
                if (assets && fileName === 'openrct2.wasm') {
                    return assets.wasm;
                }
                return fileName;
            }
        });

        window.Module = Module;

        // Setup virtual filesystem
        setStatus('Setting up filesystem...', 70);

        Module.FS.mkdir('/persistent');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/persistent');

        Module.FS.mkdir('/RCT');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/RCT');

        Module.FS.mkdir('/OpenRCT2');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/OpenRCT2');

        // Sync from IndexedDB
        setStatus('Loading saved data...', 80);
        await new Promise(resolve => Module.FS.syncfs(true, resolve));

        // Update assets if needed
        setStatus('Checking assets...', 90);
        await updateAssets();

        setStatus('Ready!', 100);
        return true;

    } catch (e) {
        console.error('Failed to load WASM module:', e);
        setStatus(`Error: ${e.message}`);
        return false;
    }
}

/**
 * Update OpenRCT2 assets if needed
 */
async function updateAssets() {
    let currentVersion = '';
    try {
        currentVersion = Module.FS.readFile('/OpenRCT2/version', { encoding: 'utf8' });
        console.log('Found asset version:', currentVersion);
    } catch (e) {
        console.log('No asset version found');
    }

    let assetsVersion = 'DEBUG';
    try {
        assetsVersion = Module.ccall('GetVersion', 'string');
    } catch (e) {
        console.warn('Could not call GetVersion');
    }

    // Always update on DEBUG builds or version mismatch
    if (currentVersion !== assetsVersion || assetsVersion.includes('DEBUG')) {
        console.log('Updating assets to', assetsVersion);

        try {
            const response = await fetch('assets.zip');
            if (response.ok) {
                const blob = await response.blob();
                await extractZip(blob, '/OpenRCT2/');
                Module.FS.writeFile('/OpenRCT2/version', assetsVersion);
            } else {
                console.warn('assets.zip not found (404)');
            }
        } catch (e) {
            console.warn('Could not update assets:', e);
        }
    }
}

/**
 * Extract ZIP file to virtual filesystem
 */
async function extractZip(data, basePath) {
    const zip = new JSZip();
    const contents = await zip.loadAsync(data);

    for (const [path, entry] of Object.entries(contents.files)) {
        const fullPath = basePath + path;
        if (entry.dir) {
            try {
                Module.FS.mkdir(fullPath);
            } catch (e) { /* Directory may exist */ }
        } else {
            const data = await entry.async('uint8array');
            Module.FS.writeFile(fullPath, data);
        }
    }
}

/**
 * Handle RCT2 file upload
 */
async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        setStatus('Processing ZIP file...', 0);

        const zip = new JSZip();
        const contents = await zip.loadAsync(file);

        // Check for valid RCT2 data
        let basePath = '/RCT/';
        if (contents.file('Data/ch.dat')) {
            basePath = '/RCT/';
        } else if (contents.file('RCT/Data/ch.dat')) {
            basePath = '/';
        } else {
            showUploadError('Invalid ZIP file. Must contain Data/ch.dat (RCT2 game files).');
            return;
        }

        // Extract files
        let count = 0;
        const total = Object.keys(contents.files).length;

        for (const [path, entry] of Object.entries(contents.files)) {
            const fullPath = basePath + path;
            if (entry.dir) {
                try {
                    Module.FS.mkdir(fullPath);
                } catch (e) { /* Directory may exist */ }
            } else {
                const data = await entry.async('uint8array');
                Module.FS.writeFile(fullPath, data);
            }
            count++;
            setStatus(`Extracting: ${path}`, Math.round((count / total) * 100));
        }

        // Save to IndexedDB
        setStatus('Saving files...', 100);
        await new Promise(resolve => Module.FS.syncfs(false, resolve));

        showUploadSuccess('RCT2 files loaded successfully!');
        startButton.style.display = 'block';
        assetsLoaded = true;

    } catch (e) {
        console.error('Error processing file:', e);
        showUploadError(`Error: ${e.message}`);
    }
}

/**
 * Start the game
 */
function startGame() {
    document.body.classList.add('game-running');
    canvas.style.display = 'block';

    // Fetch changelog
    fetchChangelog().then(changelog => {
        if (changelog) {
            Module.FS.writeFile('/OpenRCT2/changelog.txt', changelog);
        }
    });

    // Start the game
    Module.callMain(['--user-data-path=/persistent/', '--openrct2-data-path=/OpenRCT2/']);
}

/**
 * Fetch changelog from GitHub
 */
async function fetchChangelog() {
    try {
        const response = await fetch('https://api.github.com/repos/OpenRCT2/OpenRCT2/releases/latest');
        const json = await response.json();
        return json.body || '';
    } catch (e) {
        console.log('Failed to fetch changelog:', e);
        return '';
    }
}

/**
 * Main initialization
 */
async function main() {
    setStatus('Starting OpenRCT2 Web...', 0);

    const loaded = await loadWasmModule();
    if (!loaded) {
        return;
    }

    // Check if RCT2 files already exist
    const hasRct2Files = fileExists('/RCT/Data/ch.dat');

    if (hasRct2Files) {
        // RCT2 files found, can start game directly
        loadingScreen.style.display = 'none';
        startGame();
    } else {
        // Show setup screen for file upload
        loadingScreen.style.display = 'none';
        setupScreen.style.display = 'block';
    }
}

// Event listeners
rct2FilesInput.addEventListener('change', handleFileUpload);
startButton.addEventListener('click', startGame);

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
} else {
    main();
}
