const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const { CoreWasmAssetsPlugin } = require('../../scripts/core-wasm-assets-plugin.cjs');
const root = path.resolve(__dirname, '../..');
module.exports = {
  mode: 'development', context: root, entry: './prototypes/browser-sync-smoke/main.ts',
  output: {path:path.join(__dirname,'dist'),filename:'smoke.[contenthash].js',chunkFilename:'worker.[contenthash].js',clean:true,publicPath:'auto'},
  resolve:{extensions:['.ts','.js'],extensionAlias:{'.js':['.js','.ts']}},
  module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:{loader:'ts-loader',options:{transpileOnly:true,compilerOptions:{noEmit:false,allowImportingTsExtensions:true,rewriteRelativeImportExtensions:true}}}}]},
  plugins:[new HtmlWebpackPlugin({template:path.join(__dirname,'index.html')}),
    new CoreWasmAssetsPlugin({enabled:true,directory:process.env.ZORID_CORE_WASM_DIR,buildId:process.env.ZORID_CORE_BUILD_ID})],
};
