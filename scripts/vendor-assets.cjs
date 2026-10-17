const fs = require('node:fs/promises');
const path = require('node:path');

/** Collect selected upstream paths byte-for-byte, preserving selection order and
 * sorted directory traversal. Source maps remain excluded from shipped assets. */
async function createVendorAssets(root, prefix, selected) {
  const assets = new Map();
  const collect = async relative => {
    const source = path.join(root, relative), stat = await fs.stat(source);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(source)).sort()) await collect(path.join(relative, entry));
    } else if (!relative.endsWith('.map')) {
      assets.set(prefix + relative.split(path.sep).join('/'), await fs.readFile(source));
    }
  };
  for (const relative of selected) await collect(relative);
  return assets;
}
module.exports = { createVendorAssets };
