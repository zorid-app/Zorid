const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

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
  plugins: [new HtmlWebpackPlugin({ template: './index.html' })],
  devServer: { host: '127.0.0.1', port: 5173, hot: false, liveReload: true },
};
