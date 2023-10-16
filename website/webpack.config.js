const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
    entry: './bikemap-app.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].[contenthash].js',
        clean: true
    },
    module: {
        rules: [
            {
            test: /\.html$/,
            loader: 'html-loader'
            }],
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: 'index.html',
            minify: false
        })
    ]
};