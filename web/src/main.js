/**
 * OpenRCT2 Web - Main Entry Point
 */

let Module = null;

const loadingScreen = document.getElementById('loading-screen');
const setupScreen = document.getElementById('setup-screen');
const statusMessage = document.getElementById('status-message');
const progressBar = document.getElementById('progress-bar');
const rct2FilesInput = document.getElementById('rct2-files');
const uploadStatus = document.getElementById('upload-status');
const startButton = document.getElementById('start-game');
const canvas = document.getElementById('canvas');

function setStatus(message, progress = null) {
    statusMessage.textContent = message;
    if (progress !== null) progressBar.style.width = `${progress}%`;
}

function showUploadError(msg) {
    uploadStatus.textContent = msg;
    uploadStatus.className = 'error';
    uploadStatus.style.display = 'block';
}

function showUploadSuccess(msg) {
    uploadStatus.textContent = msg;
    uploadStatus.className = 'success';
    uploadStatus.style.display = 'block';
}

function fileExists(path) {
    try { Module.FS.readFile(path); return true; } catch { return false; }
}

async function loadWasmModule() {
    setStatus('Loading WebAssembly module...', 10);

    if (!window.SharedArrayBuffer) {
        setStatus('Error: SharedArrayBuffer not available. Requires COOP/COEP headers.');
        return false;
    }
    if (!window.WebAssembly) {
        setStatus('Error: WebAssembly not supported.');
        return false;
    }

    try {
        let assets = null;
        try {
            setStatus('Downloading game files...', 20);
            const req = await fetch('openrct2.zip');
            if (req.ok) {
                const data = await req.blob();
                const zip = new JSZip();
                await zip.loadAsync(data);
                assets = {
                    js: URL.createObjectURL(new Blob([await zip.file('openrct2.js').async('uint8array')], { type: 'application/javascript' })),
                    wasm: URL.createObjectURL(new Blob([await zip.file('openrct2.wasm').async('uint8array')], { type: 'application/wasm' }))
                };
            }
        } catch (e) {
            console.warn('openrct2.zip not found, trying individual files:', e);
        }

        setStatus('Loading game engine...', 40);

        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = assets ? assets.js : 'openrct2.js';
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });

        setStatus('Initializing engine...', 60);

        Module = await window.OPENRCT2_WEB({
            noInitialRun: true,
            canvas: canvas,
            print: msg => console.log('[OpenRCT2]', msg),
            printErr: msg => console.error('[OpenRCT2]', msg),
            locateFile: fileName => assets && fileName === 'openrct2.wasm' ? assets.wasm : fileName
        });
        window.Module = Module;

        setStatus('Setting up filesystem...', 70);
        Module.FS.mkdir('/persistent');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/persistent');
        Module.FS.mkdir('/RCT');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/RCT');
        Module.FS.mkdir('/OpenRCT2');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/OpenRCT2');

        setStatus('Loading saved data...', 80);
        await new Promise(resolve => Module.FS.syncfs(true, resolve));

        setStatus('Checking assets...', 90);
        try {
            await updateAssets();
        } catch (e) {
            console.warn('Asset update skipped:', e);
        }

        setStatus('Ready!', 100);
        return true;
    } catch (e) {
        console.error('Failed to load WASM:', e);
        setStatus(`Error: ${e.message}`);
        return false;
    }
}

async function updateAssets() {
    let currentVersion = '';
    try { currentVersion = Module.FS.readFile('/OpenRCT2/version', { encoding: 'utf8' }); } catch {}
    console.log('Current asset version:', currentVersion || '(none)');

    let assetsVersion = 'DEBUG';
    try { assetsVersion = Module.ccall('GetVersion', 'string'); } catch {}
    console.log('Target asset version:', assetsVersion);

    // Check if g2.dat exists - if not, force re-extraction
    let hasG2 = false;
    try { Module.FS.readFile('/OpenRCT2/g2.dat'); hasG2 = true; } catch {}

    if (currentVersion !== assetsVersion || assetsVersion.includes('DEBUG') || !hasG2) {
        console.log('Re-extracting assets (g2.dat exists:', hasG2, ')');
        console.log('Updating assets...');
        try {
            const response = await fetch('assets.zip');
            console.log('assets.zip fetch response:', response.status, response.headers.get('content-type'));
            const contentType = response.headers.get('content-type') || '';
            // Only try to extract if it's actually a zip file (not HTML error page)
            if (response.ok && !contentType.includes('text/html')) {
                const blob = await response.blob();
                console.log('assets.zip size:', blob.size);
                // Check for ZIP magic number (PK)
                const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
                if (header[0] === 0x50 && header[1] === 0x4B) {
                    console.log('Extracting assets.zip...');
                    await extractZip(blob, '/OpenRCT2/');
                    Module.FS.writeFile('/OpenRCT2/version', assetsVersion);
                    console.log('Assets extracted successfully');
                    // Debug: list contents of /OpenRCT2/
                    try {
                        const contents = Module.FS.readdir('/OpenRCT2/');
                        console.log('/OpenRCT2/ contents:', contents);
                    } catch (e) { console.log('Could not list /OpenRCT2/:', e); }
                } else {
                    console.log('assets.zip not found or not a valid ZIP file (magic:', header[0], header[1], ')');
                }
            } else {
                console.log('assets.zip not available (this is OK)');
            }
        } catch (e) { console.warn('Could not update assets:', e); }
    } else {
        console.log('Assets are up to date');
    }
}

async function extractZip(data, basePath) {
    const zip = new JSZip();
    const contents = await zip.loadAsync(data);
    for (const [path, entry] of Object.entries(contents.files)) {
        // Convert Windows backslashes to forward slashes
        const normalizedPath = path.replace(/\\/g, '/');
        const fullPath = basePath + normalizedPath;
        if (entry.dir) {
            try { Module.FS.mkdir(fullPath); } catch {}
        } else {
            // Create parent directories if needed
            const parts = fullPath.split('/').filter(Boolean);
            let currentPath = '';
            for (let i = 0; i < parts.length - 1; i++) {
                currentPath += '/' + parts[i];
                try { Module.FS.mkdir(currentPath); } catch {}
            }
            Module.FS.writeFile(fullPath, await entry.async('uint8array'));
        }
    }
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        setStatus('Processing ZIP file...', 0);
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);

        let basePath = '/RCT/';
        if (contents.file('Data/ch.dat')) basePath = '/RCT/';
        else if (contents.file('RCT/Data/ch.dat')) basePath = '/';
        else { showUploadError('Invalid ZIP. Must contain Data/ch.dat'); return; }

        let count = 0;
        const total = Object.keys(contents.files).length;
        for (const [path, entry] of Object.entries(contents.files)) {
            const fullPath = basePath + path;
            if (entry.dir) { try { Module.FS.mkdir(fullPath); } catch {} }
            else { Module.FS.writeFile(fullPath, await entry.async('uint8array')); }
            count++;
            setStatus(`Extracting: ${path}`, Math.round((count / total) * 100));
        }

        setStatus('Saving files...', 100);
        await new Promise(resolve => Module.FS.syncfs(false, resolve));

        showUploadSuccess('RCT2 files loaded successfully!');
        startButton.style.display = 'block';
    } catch (e) {
        console.error('Error processing file:', e);
        showUploadError(`Error: ${e.message}`);
    }
}

function startGame() {
    document.body.classList.add('game-running');
    canvas.style.display = 'block';
    fetch('https://api.github.com/repos/OpenRCT2/OpenRCT2/releases/latest')
        .then(r => r.json()).then(j => Module.FS.writeFile('/OpenRCT2/changelog.txt', j.body || '')).catch(() => {});
    Module.callMain(['--user-data-path=/persistent/', '--openrct2-data-path=/OpenRCT2/']);
}

async function main() {
    setStatus('Starting OpenRCT2 Web...', 0);
    const loaded = await loadWasmModule();
    if (!loaded) return;

    if (fileExists('/RCT/Data/ch.dat')) {
        loadingScreen.style.display = 'none';
        startGame();
    } else {
        loadingScreen.style.display = 'none';
        setupScreen.style.display = 'block';
    }
}

rct2FilesInput.addEventListener('change', handleFileUpload);
startButton.addEventListener('click', startGame);
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', main) : main();
