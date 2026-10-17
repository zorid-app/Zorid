const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { DefinePlugin } = require('webpack');
const { CoreWasmAssetsPlugin } = require('./scripts/core-wasm-assets-plugin.cjs');
const { MathAssetsPlugin } = require('./scripts/math-assets.cjs');
const { PrismAssetsPlugin } = require('./scripts/prism-assets.cjs');
const { PdfAssetsPlugin } = require('./scripts/pdf-assets.cjs');

// Fixture mode keeps its reproducible explicit artifacts; normal web builds own
// automatic generation. Desktop uses its native core and skips this toolchain.
module.exports = (env = {}) => {
  const desktop = env.target === 'desktop';
  const coreFixtures = !desktop && process.env.ZORID_CORE_FIXTURES === '1';
  const coreBuildId = coreFixtures ? process.env.ZORID_CORE_BUILD_ID || '' : '';
  const coreWasmDirectory = coreFixtures ? process.env.ZORID_CORE_WASM_DIR : undefined;
  if (coreFixtures && (!coreWasmDirectory || !path.isAbsolute(coreWasmDirectory))) {
    throw new Error('Core fixture builds require an absolute ZORID_CORE_WASM_DIR');
  }
  const coreAssets = new CoreWasmAssetsPlugin({enabled: !desktop, fixture:coreFixtures,
    build:!coreFixtures, directory:coreWasmDirectory, buildId:coreBuildId || undefined});
  return {
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
            noEmit: false, allowImportingTsExtensions: false,
            // Webpack resolves source .ts imports. TS's runtime rewrite helper
            // can be minified into invalid variable dynamic-import syntax.
            rewriteRelativeImportExtensions: false,
          } },
        } },
        { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      ],
    },
    plugins: [
      new DefinePlugin({
        __ZORID_CORE_FIXTURES__: JSON.stringify(coreFixtures),
        __ZORID_CORE_BUILD_ID__: JSON.stringify(coreBuildId),
        __ZORID_CORE_MODULE_PATH__: DefinePlugin.runtimeValue(() => JSON.stringify(coreAssets.modulePath), true),
      }),
      coreAssets,
      new HtmlWebpackPlugin({ template: './index.html' }), new PdfAssetsPlugin(), new MathAssetsPlugin(), new PrismAssetsPlugin(),
    ],
    devServer: { host: '127.0.0.1', port: 5173, hot: false, liveReload: true },
  };
};
