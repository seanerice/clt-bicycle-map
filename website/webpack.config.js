const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const dev = false;

module.exports = {
    mode: dev ? 'development' : 'production',
    entry: './src/bikemap-app.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name].[contenthash].js',
        clean: true
    },
    devServer: {
        static: './dist',
        hot: false,
        watchFiles: ['src/**/*.js'],
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
            template: './src/index.html',
            minify: false
        })
    ]
};