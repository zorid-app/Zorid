const path=require('node:path');
const HtmlWebpackPlugin=require('html-webpack-plugin');
const {DefinePlugin}=require('webpack');
const {CoreWasmAssetsPlugin}=require('../../scripts/core-wasm-assets-plugin.cjs');
const root=path.resolve(__dirname,'../..');
const output=process.env.ZORID_STAGE4_FIXTURE_OUTPUT||path.join(root,'dist/stage4-fixture');
const source=process.env.ZORID_STAGE4_FIXTURE_SOURCE;
const wasm=process.env.ZORID_CORE_WASM_DIR,wasmSource=process.env.ZORID_CORE_BUILD_ID;
if(!path.isAbsolute(output)||!wasm||!path.isAbsolute(wasm))throw new Error('Absolute helper output and explicit generated WASM directories are required');
if(!source||!/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(source)||!wasmSource||!/^[0-9a-f]{7,64}(?:-dirty)?$/i.test(wasmSource))throw new Error('Exact helper and WASM source commit IDs are required');
const assets=new CoreWasmAssetsPlugin({enabled:true,directory:wasm,buildId:wasmSource});
module.exports={mode:'development',devtool:'source-map',context:root,entry:path.join(__dirname,'main.ts'),
  output:{path:output,filename:'stage4-ui-fixture.js',chunkFilename:'worker.[contenthash].js',clean:false,publicPath:'auto'},
  resolve:{extensions:['.ts','.js'],extensionAlias:{'.js':['.js','.ts']}},
  module:{rules:[{test:/\.ts$/,exclude:/node_modules/,use:{loader:'ts-loader',options:{configFile:path.join(root,'tsconfig.json'),transpileOnly:true,compilerOptions:{noEmit:false,allowImportingTsExtensions:false,rewriteRelativeImportExtensions:false}}}}]},
  plugins:[new DefinePlugin({__STAGE4_FIXTURE_SOURCE__:JSON.stringify(source),__STAGE4_FIXTURE_MODULE_PATH__:DefinePlugin.runtimeValue(()=>JSON.stringify(assets.modulePath),true)}),
    new HtmlWebpackPlugin({template:path.join(__dirname,'index.html')}),assets],
};
