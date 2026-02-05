/**
 * OpenRCT2 Web - Main Entry Point
 */

import { installWebAudio } from './lib/webaudio.js';

let Module = null;
let hasRCT2Files = false;
let hasRCT1Files = false;

// Configure WebSocket proxy for multiplayer support (optional)
// Override this before loading if you host your own proxy
if (!window.openrct2_websocket_proxy) {
    window.openrct2_websocket_proxy = 'ws://localhost:8080';
}

const loadingScreen = document.getElementById('loading-screen');
const setupScreen = document.getElementById('setup-screen');
const setupMessage = document.getElementById('setup-message');
const fileOptionsSection = document.getElementById('file-options-section');
const statusMessage = document.getElementById('status-message');
const progressBar = document.getElementById('progress-bar');
const progressDetail = document.getElementById('progress-detail');
const rct2FilesInput = document.getElementById('rct2-files');
const fileNameDisplay = document.getElementById('file-name-display');
const uploadStatus = document.getElementById('upload-status');
const uploadProgressContainer = document.getElementById('upload-progress-container');
const uploadProgressText = document.getElementById('upload-progress-text');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const startButton = document.getElementById('start-game');
const canvas = document.getElementById('canvas');
const legalModal = document.getElementById('legal-modal');
const legalLink = document.getElementById('legal-link');
const legalClose = document.getElementById('legal-close');
const legalOk = document.getElementById('legal-ok');

function setStatus(message, progress = null, detail = '') {
    statusMessage.textContent = message;
    if (progress !== null) progressBar.style.width = `${progress}%`;
    if (progressDetail) progressDetail.textContent = detail;
}

function resumeAudioContext() {
    if (!Module || !Module.WebAudio || !Module.WebAudio.ctx) return;
    const ctx = Module.WebAudio.ctx;
    if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
    }
}

function setUploadProgress(message, progress) {
    uploadProgressText.textContent = message;
    uploadProgressBar.style.width = `${progress}%`;
}

function setupLegalModal() {
    if (!legalModal || !legalLink) return;
    legalLink.addEventListener('click', (event) => {
        event.preventDefault();
        legalModal.classList.remove('hidden');
    });

    const closeLegalModal = () => {
        legalModal.classList.add('hidden');
    };

    legalClose?.addEventListener('click', closeLegalModal);
    legalOk?.addEventListener('click', closeLegalModal);
    legalModal.querySelector('.modal-backdrop')?.addEventListener('click', closeLegalModal);
}

function showUploadError(msg) {
    uploadProgressContainer.style.display = 'none';
    uploadStatus.textContent = msg;
    uploadStatus.className = 'error';
    uploadStatus.style.display = 'block';
    rct2FilesInput.disabled = false;
}

function showUploadSuccess(msg) {
    uploadProgressContainer.style.display = 'none';
    uploadStatus.textContent = msg;
    uploadStatus.className = 'success';
    uploadStatus.style.display = 'block';
}

function fileExists(path) {
    try { Module.FS.readFile(path); return true; } catch { return false; }
}

function anyFileExists(paths) {
    return paths.some(p => fileExists(p));
}

function checkRCT1Files() {
    const hasCsg1 = anyFileExists([
        '/RCT1/Data/CSG1.DAT',
        '/RCT1/Data/CSG1.1',
        '/RCT1/Data/csg1.dat',
        '/RCT1/Data/csg1.1',
    ]);
    const hasCsg1i = anyFileExists([
        '/RCT1/Data/CSG1I.DAT',
        '/RCT1/Data/csg1i.dat',
    ]);
    return hasCsg1 && hasCsg1i;
}

function updateConfigRct1Path(rct1Path) {
    const configPath = '/persistent/config.ini';
    let content = '';
    try {
        content = Module.FS.readFile(configPath, { encoding: 'utf8' }) || '';
    } catch {
        content = '';
    }

    const line = `rct1_path=${rct1Path}`;
    if (!content) {
        content = `[general]\n${line}\n`;
        Module.FS.writeFile(configPath, content);
        return;
    }

    const normalized = content.replace(/\r\n/g, '\n');
    const generalIndex = normalized.indexOf('[general]');
    if (generalIndex === -1) {
        content = normalized + `\n[general]\n${line}\n`;
        Module.FS.writeFile(configPath, content);
        return;
    }

    const afterGeneral = normalized.slice(generalIndex);
    const nextSectionIdx = afterGeneral.indexOf('\n[');
    const sectionEnd = nextSectionIdx === -1 ? normalized.length : generalIndex + nextSectionIdx + 1;
    const before = normalized.slice(0, generalIndex);
    const section = normalized.slice(generalIndex, sectionEnd);
    const after = normalized.slice(sectionEnd);

    if (section.match(/^rct1_path=/m)) {
        const updatedSection = section.replace(/^rct1_path=.*$/m, line);
        content = before + updatedSection + after;
    } else {
        const parts = section.split('\n');
        parts.splice(1, 0, line);
        content = before + parts.join('\n') + after;
    }

    Module.FS.writeFile(configPath, content);
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function updateSetupScreen() {
    if (hasRCT2Files) {
        setupMessage.textContent = 'RCT2 files found! Click Start Game to play.';
        fileOptionsSection.style.display = 'none';
        startButton.disabled = false;
    } else {
        setupMessage.textContent = 'To play, you need to provide your RCT2 game files.';
        fileOptionsSection.style.display = 'block';
        startButton.disabled = true;
    }
}

/**
 * Fetch with progress tracking
 */
async function fetchWithProgress(url, onProgress) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    if (!response.body || !total) {
        // Fallback for browsers without streaming or unknown size
        const blob = await response.blob();
        onProgress(blob.size, blob.size);
        return blob;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress(loaded, total);
    }

    return new Blob(chunks);
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
        installWebAudio(Module);
        startButton.addEventListener('click', resumeAudioContext, { once: true });
        canvas.addEventListener('click', resumeAudioContext, { once: true });
        document.addEventListener('keydown', resumeAudioContext, { once: true });

        setStatus('Setting up filesystem...', 70);
        Module.FS.mkdir('/persistent');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/persistent');
        Module.FS.mkdir('/RCT');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/RCT');
        Module.FS.mkdir('/RCT1');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/RCT1');
        Module.FS.mkdir('/OpenRCT2');
        Module.FS.mount(Module.FS.filesystems.IDBFS, { autoPersist: true }, '/OpenRCT2');

        setStatus('Loading saved data...', 80);
        await new Promise(resolve => Module.FS.syncfs(true, resolve));

        setStatus('Checking assets...', 85);
        try {
            await updateAssets();
        } catch (e) {
            console.warn('Asset update skipped:', e);
        }

        // Check if RCT2 files exist
        hasRCT2Files = fileExists('/RCT/Data/ch.dat');
        hasRCT1Files = checkRCT1Files();
        if (hasRCT1Files) {
            updateConfigRct1Path('/RCT1/');
            await new Promise(resolve => Module.FS.syncfs(false, resolve));
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

        setStatus('Downloading assets...', 85, 'Connecting...');

        try {
            const blob = await fetchWithProgress('assets.zip', (loaded, total) => {
                const percent = Math.round((loaded / total) * 100);
                setStatus('Downloading assets...', 85 + (percent * 0.1), `${formatBytes(loaded)} / ${formatBytes(total)}`);
            });

            console.log('assets.zip size:', blob.size);

            // Check for ZIP magic number (PK)
            const header = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
            if (header[0] === 0x50 && header[1] === 0x4B) {
                setStatus('Extracting assets...', 95, 'Loading ZIP...');
                await extractZipWithProgress(blob, '/OpenRCT2/', (current, total) => {
                    const percent = Math.round((current / total) * 100);
                    setStatus('Extracting assets...', 95 + (percent * 0.05), `${current}/${total} files`);
                });
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
        } catch (e) {
            console.warn('Could not update assets:', e);
            setStatus('Checking assets...', 95, 'Assets not available');
        }
    } else {
        console.log('Assets are up to date');
    }
}

async function extractZipWithProgress(data, basePath, onProgress) {
    const zip = new JSZip();
    const contents = await zip.loadAsync(data);
    const files = Object.entries(contents.files);
    const total = files.length;
    let current = 0;

    for (const [path, entry] of files) {
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

        current++;
        if (current % 50 === 0 || current === total) {
            onProgress(current, total);
        }
    }
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Update file name display and hide file upload section
    fileNameDisplay.textContent = file.name;
    document.querySelector('.file-upload').style.display = 'none';

    // Disable input and button during processing
    rct2FilesInput.disabled = true;
    startButton.disabled = true;
    uploadStatus.style.display = 'none';
    uploadProgressContainer.style.display = 'block';

    try {
        setUploadProgress('Reading ZIP file...', 0);

        const zip = new JSZip();
        const contents = await zip.loadAsync(file);

        const hasAnyFile = (paths) => paths.some(p => contents.file(p));
        const detectPrefix = (checks) => {
            for (const [prefix, paths] of checks) {
                if (hasAnyFile(paths)) return prefix;
            }
            return null;
        };

        const rct2Prefix = detectPrefix([
            ['RCT2/', ['RCT2/Data/ch.dat', 'RCT2/Data/CH.DAT']],
            ['RCT/', ['RCT/Data/ch.dat', 'RCT/Data/CH.DAT']],
            ['', ['Data/ch.dat', 'Data/CH.DAT']],
        ]);

        if (rct2Prefix === null) {
            showUploadError('Invalid ZIP. Must contain RCT2 Data/ch.dat');
            return;
        }

        const rct1Prefix = detectPrefix([
            ['RCT1/', [
                'RCT1/Data/CSG1.DAT',
                'RCT1/Data/CSG1.1',
                'RCT1/Data/CSG1I.DAT',
                'RCT1/Data/csg1.dat',
                'RCT1/Data/csg1.1',
                'RCT1/Data/csg1i.dat',
            ]],
            ['', [
                'Data/CSG1.DAT',
                'Data/CSG1.1',
                'Data/CSG1I.DAT',
                'Data/csg1.dat',
                'Data/csg1.1',
                'Data/csg1i.dat',
            ]],
        ]);

        const hasRCT1 = rct1Prefix !== null;
        const jobs = [
            { name: 'RCT2', basePath: '/RCT/', stripPrefix: rct2Prefix },
        ];
        if (hasRCT1) {
            jobs.push({ name: 'RCT1', basePath: '/RCT1/', stripPrefix: rct1Prefix });
        }

        const files = Object.entries(contents.files);
        const items = [];
        for (const [path, entry] of files) {
            if (entry.dir) continue;
            for (const job of jobs) {
                if (!path.startsWith(job.stripPrefix)) continue;
                const relativePath = job.stripPrefix ? path.slice(job.stripPrefix.length) : path;
                if (!relativePath) continue;
                items.push({ relativePath, fullPath: job.basePath + relativePath, entry });
                break;
            }
        }

        const total = items.length;
        let count = 0;

        setUploadProgress(`Extracting files... (0/${total})`, 0);

        for (const item of items) {
            const { relativePath, fullPath, entry } = item;
            // Ensure parent directories exist
            const parts = fullPath.split('/').filter(Boolean);
            let currentPath = '';
            for (let i = 0; i < parts.length - 1; i++) {
                currentPath += '/' + parts[i];
                try { Module.FS.mkdir(currentPath); } catch {}
            }
            Module.FS.writeFile(fullPath, await entry.async('uint8array'));
            count++;

            // Update progress every 10 files or at the end
            if (count % 10 === 0 || count === total) {
                const percent = Math.round((count / total) * 95);
                setUploadProgress(`Extracting: ${relativePath.split('/').pop()}`, percent);
            }
        }

        hasRCT2Files = true;
        hasRCT1Files = checkRCT1Files();
        if (hasRCT1Files) {
            updateConfigRct1Path('/RCT1/');
        }

        setUploadProgress('Saving to browser storage...', 98);
        await new Promise(resolve => Module.FS.syncfs(false, resolve));

        if (hasRCT1Files) {
            showUploadSuccess('RCT2 + RCT1 files loaded successfully!');
        } else if (hasRCT1) {
            showUploadError('RCT2 loaded, but RCT1 data is incomplete (CSG1.DAT/CSG1I.DAT missing).');
        } else {
            showUploadSuccess('RCT2 files loaded successfully!');
        }
        updateSetupScreen();
    } catch (e) {
        console.error('Error processing file:', e);
        showUploadError(`Error: ${e.message}`);
        startButton.disabled = !hasRCT2Files;
    }
}

function startGame() {
    document.body.classList.add('game-running');
    canvas.style.display = 'block';
    fetch('https://api.github.com/repos/OpenRCT2/OpenRCT2/releases/latest')
        .then(r => r.json()).then(j => Module.FS.writeFile('/OpenRCT2/changelog.txt', j.body || '')).catch(() => {});
    Module.callMain(['--user-data-path=/persistent/', '--openrct2-data-path=/OpenRCT2/', '--rct1-data-path=/RCT1/']);
}

async function main() {
    setupLegalModal();
    setStatus('Starting OpenRCT2 Web...', 0);
    const loaded = await loadWasmModule();
    if (!loaded) return;

    loadingScreen.style.display = 'none';
    setupScreen.style.display = 'block';
    updateSetupScreen();
}

rct2FilesInput.addEventListener('change', handleFileUpload);
startButton.addEventListener('click', startGame);
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', main) : main();
