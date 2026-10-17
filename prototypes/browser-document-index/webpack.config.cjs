const path=require('node:path');
const HtmlWebpackPlugin=require('html-webpack-plugin');
const {DefinePlugin}=require('webpack');
const {CoreWasmAssetsPlugin}=require('../../scripts/core-wasm-assets-plugin.cjs');
const root=path.resolve(__dirname,'../..');
const output=process.env.ZORID_DOCUMENT_INDEX_OUTPUT;
const source=process.env.ZORID_DOCUMENT_INDEX_SOURCE;
const wasm=process.env.ZORID_CORE_WASM_DIR;
const wasmSource=process.env.ZORID_CORE_BUILD_ID;
if(!output||!path.isAbsolute(output)||!wasm||!path.isAbsolute(wasm))throw new Error('Explicit absolute output and generated WASM directories required');
if(!source||!/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(source)||!wasmSource||!/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(wasmSource))throw new Error('Exact fixture and WASM source commit IDs required');
module.exports={mode:'development',devtool:'source-map',context:root,entry:path.join(__dirname,'main.ts'),
  output:{path:output,filename:'document-index.js',chunkFilename:'worker.[contenthash].js',clean:false,publicPath:'auto'},
  resolve:{extensions:['.ts','.js'],extensionAlias:{'.js':['.js','.ts']}},
  module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:{loader:'ts-loader',options:{configFile:path.join(root,'tsconfig.json'),transpileOnly:true,compilerOptions:{noEmit:false,allowImportingTsExtensions:false,rewriteRelativeImportExtensions:false}}}}]},
  plugins:[new DefinePlugin({__DOCUMENT_INDEX_SOURCE__:JSON.stringify(source)}),new HtmlWebpackPlugin({template:path.join(__dirname,'index.html')}),
    new CoreWasmAssetsPlugin({enabled:true,fixture:true,directory:wasm,buildId:wasmSource})],
};
