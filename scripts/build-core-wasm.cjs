const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawn} = require('node:child_process');

const bindgenVersion = '0.2.129';
const projectRoot = path.resolve(__dirname, '..');
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd:options.root, env:options.env ?? process.env, stdio:options.capture ? ['ignore','pipe','pipe'] : 'inherit'});
    let output = '';
    if (options.capture) {child.stdout.on('data', data => {output += data;}); child.stderr.on('data', data => {output += data;});}
    child.on('error', error => reject(new Error(`Cannot run ${command}; install the browser Rust/WASM toolchain (see docs/browser-wasm-build.md)`, {cause:error})));
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}${output ? `: ${output.trim()}` : ''}`)));
  });
}
async function sourceInputs(root) {
  const files = ['Cargo.toml','Cargo.lock','scripts/build-core-wasm.cjs'];
  async function walk(relative) {
    for (const entry of (await fs.readdir(path.join(root, relative), {withFileTypes:true})).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && (entry.name === 'Cargo.toml' || entry.name.endsWith('.rs'))) files.push(name);
    }
  }
  await walk('crates');
  return files;
}
async function inputDigest(root) {
  const digest = createHash('sha256').update(`wasm-bindgen ${bindgenVersion}\0`);
  for (const file of await sourceInputs(root)) digest.update(file).update('\0').update(await fs.readFile(path.join(root,file))).update('\0');
  return digest.digest('hex');
}
async function artifactDigests(directory) {
  const result = {};
  for (const name of ['zorid_wasm.js','zorid_wasm_bg.wasm']) result[name] = createHash('sha256').update(await fs.readFile(path.join(directory,name))).digest('hex');
  return result;
}
/** Always fingerprint inputs; never accept a previous revision's generated module. */
async function buildCoreWasm(options = {}) {
  const root = options.root ?? projectRoot;
  const directory = options.directory ?? path.join(root,'target/browser-wasm/generated');
  const fingerprint = await inputDigest(root);
  const metadataPath = path.join(directory,'build.json');
  try {
    const metadata = JSON.parse(await fs.readFile(metadataPath,'utf8'));
    if (metadata.fingerprint === fingerprint && JSON.stringify(metadata.files) === JSON.stringify(await artifactDigests(directory))) return directory;
  } catch { /* A missing/stale cache is regenerated below. */ }
  const cargo = process.env.CARGO || 'cargo';
  const bindgen = process.env.WASM_BINDGEN || 'wasm-bindgen';
  const execute = options.run ?? run;
  const version = await execute(bindgen,['--version'],{root,capture:true});
  if (version !== `wasm-bindgen ${bindgenVersion}`) throw new Error(`Browser core requires wasm-bindgen-cli ${bindgenVersion}; found ${version}`);
  const target = process.env.CARGO_TARGET_DIR ? path.resolve(root,process.env.CARGO_TARGET_DIR) : path.join(root,'target/browser-wasm/cargo');
  await execute(cargo,['build','--manifest-path',path.join(root,'crates/zorid-wasm/Cargo.toml'),'--target','wasm32-unknown-unknown','--release','-j','1'],{root,env:{...process.env,CARGO_TARGET_DIR:target}});
  await fs.mkdir(directory,{recursive:true});
  // Publish cache metadata last, so interrupted generation never appears current.
  await fs.rm(metadataPath,{force:true});
  await execute(bindgen,['--target','web','--out-name','zorid_wasm','--out-dir',directory,path.join(target,'wasm32-unknown-unknown/release/zorid_wasm.wasm')],{root});
  if (await inputDigest(root) !== fingerprint) throw new Error('Rust sources changed during the browser core build; rerun the build');
  await fs.writeFile(metadataPath,JSON.stringify({fingerprint,bindgenVersion,files:await artifactDigests(directory)},null,2)+'\n');
  return directory;
}
module.exports = {buildCoreWasm,sourceInputs};
if (require.main === module) buildCoreWasm().then(directory => console.log(`Browser core ready: ${directory}`)).catch(error => {console.error(error.message);process.exitCode=1;});
