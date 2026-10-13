// Version install metadata by content while preserving the app's stable identity.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function versionPages(dir) {
  const hash = (file) => createHash('sha256').update(fs.readFileSync(path.join(dir, file))).digest('hex').slice(0, 12);
  const version = (file) => `${file}?v=${hash(file)}`;
  const manifestFile = path.join(dir, 'manifest.webmanifest');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const icon of manifest.icons) icon.src = version(icon.src.split('?')[0]);
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  const file = path.join(dir, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  for (const asset of ['manifest.webmanifest', 'install.js', 'icons/apple-touch-icon.png']) {
    const attribute = asset.endsWith('.js') ? 'src' : 'href';
    const pattern = new RegExp(`${attribute}="${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\?[^" ]*)?"`);
    if (!pattern.test(html)) throw Error(`Missing hosted asset: ${asset}`);
    html = html.replace(pattern, `${attribute}="${version(asset)}"`);
  }
  fs.writeFileSync(file, html);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) versionPages(process.argv[2] || 'site');
