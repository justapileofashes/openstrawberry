import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const releaseDir = path.join(root, 'release');
const expectedArtifacts = new Set([
  'OpenStrawberry-mac-universal.dmg',
  'OpenStrawberry-win-x64.exe',
  'OpenStrawberry-linux-x86_64.AppImage',
  'OpenStrawberry-linux-amd64.deb',
  'OpenStrawberry-linux-x86_64.rpm',
]);

async function listArtifacts(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const artifacts = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!expectedArtifacts.has(entry.name)) continue;
    artifacts.push(entry.name);
  }

  return artifacts.sort((left, right) => left.localeCompare(right));
}

async function sha256(filePath) {
  const bytes = await readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

const artifacts = await listArtifacts(releaseDir);

if (artifacts.length === 0) {
  throw new Error(
    'No OpenStrawberry installer artifacts found in release/. Run pnpm package on a suitable release runner first.',
  );
}

const lines = [];
for (const artifact of artifacts) {
  const absolutePath = path.join(releaseDir, artifact);
  const metadata = await stat(absolutePath);
  if (metadata.size === 0) {
    throw new Error(`Installer artifact is empty: ${artifact}`);
  }
  lines.push(`${await sha256(absolutePath)}  ${artifact}`);
}

const checksumPath = path.join(releaseDir, 'SHA256SUMS.txt');
await writeFile(checksumPath, `${lines.join('\n')}\n`, { mode: 0o600 });

console.log(`Verified ${artifacts.length} installer artifact(s).`);
console.log(`Wrote ${checksumPath}`);
for (const artifact of artifacts) console.log(`- ${artifact}`);
