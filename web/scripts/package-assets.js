#!/usr/bin/env node

/**
 * Package OpenRCT2 assets into a ZIP file for web deployment
 * Uses pure JavaScript libraries for cross-platform compatibility
 */

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, createWriteStream, rmSync, copyFileSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import archiver from 'archiver';
import yauzl from 'yauzl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..', '..');
const WEB_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const STATIC_DIR = join(WEB_DIR, 'static');

// Files to download from official release (these are generated at build time, not in repo)
const RELEASE_DATA_FILES = ['g2.dat', 'fonts.dat', 'palettes.dat', 'tracks.dat'];

// Objects repository URL
const OBJECTS_VERSION = '1.7.6';
const OBJECTS_URL = `https://github.com/OpenRCT2/objects/releases/download/v${OBJECTS_VERSION}/objects.zip`;

// Title sequences URL
const TITLE_SEQUENCES_VERSION = '0.4.26';
const TITLE_SEQUENCES_URL = `https://github.com/OpenRCT2/title-sequences/releases/download/v${TITLE_SEQUENCES_VERSION}/title-sequences.zip`;

// OpenMusic URL (additional music styles for rides)
const OPENMUSIC_VERSION = '1.6.1';
const OPENMUSIC_URL = `https://github.com/OpenRCT2/OpenMusic/releases/download/v${OPENMUSIC_VERSION}/openmusic.zip`;

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          follow(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }
        const file = createWriteStream(dest);
        response.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

/**
 * Extract a ZIP file using yauzl (pure JavaScript)
 */
async function extractZip(zipPath, destDir, filter = null) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);

      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        // Apply filter if provided
        if (filter && !filter(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        const fullPath = join(destDir, entry.fileName);

        if (/\/$/.test(entry.fileName)) {
          // Directory
          mkdirSync(fullPath, { recursive: true });
          zipfile.readEntry();
        } else {
          // File - ensure parent directory exists
          mkdirSync(dirname(fullPath), { recursive: true });

          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);

            const writeStream = createWriteStream(fullPath);
            readStream.pipe(writeStream);
            writeStream.on('close', () => zipfile.readEntry());
            writeStream.on('error', reject);
          });
        }
      });

      zipfile.on('end', resolve);
      zipfile.on('error', reject);
    });
  });
}

async function downloadReleaseDataFiles(tempDir) {
  console.log('Fetching latest release info...');

  // Get latest release info
  const releaseInfo = await new Promise((resolve, reject) => {
    https.get('https://api.github.com/repos/OpenRCT2/OpenRCT2/releases/latest', {
      headers: { 'User-Agent': 'OpenRCT2-Web-Build' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
      res.on('error', reject);
    }).on('error', reject);
  });

  // Find the windows portable x64 zip (contains all data files)
  const portableAsset = releaseInfo.assets.find(a => a.name.includes('windows-portable-x64.zip'));
  if (!portableAsset) {
    throw new Error('Could not find windows-portable-x64.zip in latest release');
  }

  console.log(`Downloading ${portableAsset.name}...`);
  const zipPath = join(tempDir, 'release.zip');
  await downloadFile(portableAsset.browser_download_url, zipPath);

  // Extract only the data files we need
  console.log('Extracting data files from release...');
  const extractTempDir = join(tempDir, 'release-extracted');
  mkdirSync(extractTempDir, { recursive: true });

  // Extract only .dat files
  await extractZip(zipPath, extractTempDir, (fileName) => {
    return RELEASE_DATA_FILES.some(datFile => fileName.endsWith(datFile));
  });

  // Copy extracted .dat files to tempDir root
  const findDatFiles = (dir) => {
    const results = [];
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      if (item.isDirectory()) {
        results.push(...findDatFiles(fullPath));
      } else if (RELEASE_DATA_FILES.includes(item.name)) {
        results.push({ name: item.name, path: fullPath });
      }
    }
    return results;
  };

  const datFiles = findDatFiles(extractTempDir);
  for (const { name, path } of datFiles) {
    copyFileSync(path, join(tempDir, name));
    console.log(`  Extracted ${name}`);
  }

  // Cleanup extracted release
  rmSync(extractTempDir, { recursive: true, force: true });

  return true;
}

async function downloadObjects(tempDir) {
  console.log('Downloading OpenRCT2 objects...');
  const zipPath = join(tempDir, 'objects.zip');
  await downloadFile(OBJECTS_URL, zipPath);

  const objectDir = join(tempDir, 'object');
  mkdirSync(objectDir, { recursive: true });

  console.log('  Extracting objects.zip...');
  await extractZip(zipPath, objectDir);

  // Count extracted files
  const countFiles = (dir) => {
    let count = 0;
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        count += countFiles(join(dir, item.name));
      } else {
        count++;
      }
    }
    return count;
  };

  const fileCount = countFiles(objectDir);
  console.log(`  Objects extracted successfully (${fileCount} files)`);
  return true;
}

async function downloadTitleSequences(tempDir) {
  console.log('Downloading title sequences...');
  const zipPath = join(tempDir, 'title-sequences.zip');
  await downloadFile(TITLE_SEQUENCES_URL, zipPath);

  const sequenceDir = join(tempDir, 'sequence');
  mkdirSync(sequenceDir, { recursive: true });

  console.log('  Extracting title-sequences.zip...');
  await extractZip(zipPath, sequenceDir);

  // Count extracted files
  const countFiles = (dir) => {
    let count = 0;
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        count += countFiles(join(dir, item.name));
      } else {
        count++;
      }
    }
    return count;
  };

  const fileCount = countFiles(sequenceDir);
  console.log(`  Title sequences extracted successfully (${fileCount} files)`);
  return true;
}

async function downloadOpenMusic(tempDir) {
  console.log('Downloading OpenMusic (additional ride music)...');
  const zipPath = join(tempDir, 'openmusic.zip');
  await downloadFile(OPENMUSIC_URL, zipPath);

  // Extract to object/official/music directory
  const musicDir = join(tempDir, 'object', 'official', 'music');
  mkdirSync(musicDir, { recursive: true });

  console.log('  Extracting openmusic.zip...');
  await extractZip(zipPath, musicDir);

  // Count extracted files
  const countFiles = (dir) => {
    let count = 0;
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        count += countFiles(join(dir, item.name));
      } else {
        count++;
      }
    }
    return count;
  };

  const fileCount = countFiles(musicDir);
  console.log(`  OpenMusic extracted successfully (${fileCount} files)`);
  return true;
}

/**
 * Recursively copy a directory
 */
function copyDirRecursive(src, dest) {
  mkdirSync(dest, { recursive: true });
  const items = readdirSync(src, { withFileTypes: true });
  for (const item of items) {
    const srcPath = join(src, item.name);
    const destPath = join(dest, item.name);
    if (item.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Create a ZIP file from a directory using archiver
 */
async function createZipFromDirectory(sourceDir, outputPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function main() {
  console.log('=== Packaging OpenRCT2 Assets ===\n');

  if (!existsSync(DATA_DIR)) {
    console.error('Error: data/ directory not found');
    process.exit(1);
  }

  const assetsZipPath = join(STATIC_DIR, 'assets.zip');

  if (!existsSync(STATIC_DIR)) {
    mkdirSync(STATIC_DIR, { recursive: true });
  }

  // Folders to include in assets.zip
  const foldersToInclude = ['language', 'shaders'];
  // Files to include from data root
  const filesToInclude = ['changelog.txt', 'contributors.md', 'languages', 'object_mods.json'];

  // Create a temporary directory with the structure we want
  const tempDir = join(WEB_DIR, 'temp-assets');
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  mkdirSync(tempDir, { recursive: true });

  // Download data files from official release (g2.dat, fonts.dat, etc.)
  console.log('\n=== Downloading data files from official release ===\n');
  try {
    await downloadReleaseDataFiles(tempDir);
  } catch (e) {
    console.error('Failed to download release data files:', e.message);
    console.log('Continuing without release data files...');
  }

  // Download OpenRCT2 objects (terrain, stations, music, etc.)
  console.log('\n=== Downloading OpenRCT2 objects ===\n');
  try {
    await downloadObjects(tempDir);
  } catch (e) {
    console.error('Failed to download objects:', e.message);
    console.log('Continuing without objects...');
  }

  // Download title sequences (demo parks shown on title screen)
  console.log('\n=== Downloading title sequences ===\n');
  try {
    await downloadTitleSequences(tempDir);
  } catch (e) {
    console.error('Failed to download title sequences:', e.message);
    console.log('Continuing without title sequences...');
  }

  // Download OpenMusic (additional ride music styles)
  console.log('\n=== Downloading OpenMusic ===\n');
  try {
    await downloadOpenMusic(tempDir);
  } catch (e) {
    console.error('Failed to download OpenMusic:', e.message);
    console.log('Continuing without OpenMusic...');
  }

  console.log('\n=== Creating assets.zip ===\n');

  // Remove temporary download files before creating the final ZIP
  const tempFiles = ['release.zip', 'objects.zip', 'title-sequences.zip', 'openmusic.zip'];
  for (const tempFile of tempFiles) {
    const tempFilePath = join(tempDir, tempFile);
    if (existsSync(tempFilePath)) {
      rmSync(tempFilePath);
      console.log(`  Removed temporary file: ${tempFile}`);
    }
  }

  // Copy folders from data directory
  for (const folder of foldersToInclude) {
    const src = join(DATA_DIR, folder);
    const dest = join(tempDir, folder);
    if (existsSync(src)) {
      copyDirRecursive(src, dest);
      console.log(`  Added ${folder}/`);
    }
  }

  // Copy individual files from data directory
  for (const file of filesToInclude) {
    const src = join(DATA_DIR, file);
    if (existsSync(src) && statSync(src).isFile()) {
      copyFileSync(src, join(tempDir, file));
      console.log(`  Added ${file}`);
    }
  }

  // Create ZIP using archiver
  if (existsSync(assetsZipPath)) {
    rmSync(assetsZipPath);
  }

  console.log('\n  Creating ZIP archive...');
  const bytes = await createZipFromDirectory(tempDir, assetsZipPath);

  // Cleanup temp directory
  rmSync(tempDir, { recursive: true, force: true });

  console.log(`\nCreated: ${assetsZipPath}`);
  console.log(`Size: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

main().catch(err => {
  console.error('Failed to package assets:', err);
  process.exit(1);
});
