const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const repoUser = 'vicha-w';
const repoName = 'thai-lotto-archive';
const branch = 'master';
const folderPathInRepo = 'lottonumbers';
const localFolder = './lottonumbers';

(async () => {
  const zipUrl = `https://github.com/${repoUser}/${repoName}/archive/refs/heads/${branch}.zip`;
  console.log('Downloading zip:', zipUrl);

  const res = await fetch(zipUrl);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buffer);
  const tempDir = './temp_repo';
  zip.extractAllTo(tempDir, true);

  const repoFolderName = `${repoName}-${branch}`;
  const sourceFolder = path.join(tempDir, repoFolderName, folderPathInRepo);

  if (!fs.existsSync(sourceFolder)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw new Error(`Source folder not found in archive: ${sourceFolder}`);
  }

  if (fs.existsSync(localFolder)) {
    console.log('Removing existing local folder:', localFolder);
    fs.rmSync(localFolder, { recursive: true, force: true });
  }

  console.log('Copying new folder to:', localFolder);
  fs.cpSync(sourceFolder, localFolder, { recursive: true });

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('lottonumbers updated successfully.');
})().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
