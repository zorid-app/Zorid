const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { DefinePlugin } = require('webpack');
const { CoreWasmAssetsPlugin } = require('../../scripts/core-wasm-assets-plugin.cjs');
const output = process.env.ZORID_ADMISSION_OUTPUT;
const wasm = process.env.ZORID_CORE_WASM_DIR;
const buildId = process.env.ZORID_CORE_BUILD_ID;
const fixtureId = process.env.ZORID_ADMISSION_BUILD_ID;
if (!fixtureId || !/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(fixtureId)) throw new Error('Explicit fixture source commit required');
if (!output || !path.isAbsolute(output) || !wasm || !path.isAbsolute(wasm)) throw new Error('Explicit absolute fixture output and generated WASM directories required');
module.exports = {
  mode: 'development', devtool: 'source-map', context: path.resolve(__dirname, '../..'),
  entry: { admission: path.join(__dirname, 'fixture.ts'), 'two-tab': path.join(__dirname, 'two-tab.ts') },
  output: { path: output, filename: '[name].js', chunkFilename: '[name].js', publicPath: 'auto', clean: false },
  resolve: { extensions: ['.ts', '.js'], extensionAlias: { '.js': ['.js', '.ts'] } },
  module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: { loader: 'ts-loader', options: {
    configFile: path.join(__dirname, 'tsconfig.json'), transpileOnly: true,
    compilerOptions: { noEmit: false, allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true },
  } } }] },
  plugins: [new DefinePlugin({ __ADMISSION_SOURCE__: JSON.stringify(fixtureId), __ADMISSION_WASM_SOURCE__: JSON.stringify(buildId ?? '') }),
    new CoreWasmAssetsPlugin({ enabled: true, directory: wasm, buildId }),
    new HtmlWebpackPlugin({ template: path.join(__dirname, 'index.html'), chunks: ['admission'] }),
    new HtmlWebpackPlugin({ template: path.join(__dirname, 'two-tab.html'), filename: 'two-tab.html', chunks: ['two-tab'] })],
};
