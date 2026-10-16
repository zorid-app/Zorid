// The tap owns the implementation so its distributable skeleton is self-contained.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../assets/homebrew-tap/scripts/generate-homebrew-cask.mjs';
export * from '../assets/homebrew-tap/scripts/generate-homebrew-cask.mjs';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Homebrew cask generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
