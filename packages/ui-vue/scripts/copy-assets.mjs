import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceRoot = path.join(packageRoot, 'src');
const distRoot = path.join(packageRoot, 'dist');

mkdirSync(distRoot, { recursive: true });
cpSync(path.join(sourceRoot, 'components'), path.join(distRoot, 'components'), { recursive: true });
copyFileSync(path.join(sourceRoot, 'components.css'), path.join(distRoot, 'components.css'));
copyFileSync(path.join(sourceRoot, 'tokens.css'), path.join(distRoot, 'tokens.css'));
