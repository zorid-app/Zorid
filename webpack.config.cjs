const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { DefinePlugin } = require('webpack');
const { CoreWasmAssetsPlugin } = require('./scripts/core-wasm-assets-plugin.cjs');
const { MathAssetsPlugin } = require('./scripts/math-assets.cjs');
const { PrismAssetsPlugin } = require('./scripts/prism-assets.cjs');
const { PdfAssetsPlugin } = require('./scripts/pdf-assets.cjs');

// Explicit fixture builds require generated artifacts and source provenance.
// Ordinary builds never inspect or emit Rust/WASM fixture assets.
const coreFixtures = process.env.ZORID_CORE_FIXTURES === '1';
const coreBuildId = coreFixtures ? process.env.ZORID_CORE_BUILD_ID || '' : '';
const coreWasmDirectory = coreFixtures ? process.env.ZORID_CORE_WASM_DIR : undefined;
if (coreFixtures && (!coreWasmDirectory || !path.isAbsolute(coreWasmDirectory))) {
  throw new Error('Core fixture builds require an absolute ZORID_CORE_WASM_DIR');
}

module.exports = {
  entry: './src/main.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].[contenthash].js',
    chunkFilename: '[name].[contenthash].js',
    publicPath: 'auto',
    clean: true,
  },
  devtool: 'source-map',
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: { '.js': ['.js', '.ts'] },
  },
  module: {
    rules: [
      { test: /\.ts$/, exclude: /node_modules/, use: {
        loader: 'ts-loader',
        options: { transpileOnly: true, compilerOptions: {
          noEmit: false, allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: true,
        } },
      } },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
    ],
  },
  plugins: [
    new DefinePlugin({
      __ZORID_CORE_FIXTURES__: JSON.stringify(coreFixtures),
      __ZORID_CORE_BUILD_ID__: JSON.stringify(coreBuildId),
    }),
    new CoreWasmAssetsPlugin({ enabled: coreFixtures, directory: coreWasmDirectory, buildId: coreBuildId }),
    new HtmlWebpackPlugin({ template: './index.html' }), new PdfAssetsPlugin(), new MathAssetsPlugin(), new PrismAssetsPlugin(),
  ],
  devServer: { host: '127.0.0.1', port: 5173, hot: false, liveReload: true },
};
