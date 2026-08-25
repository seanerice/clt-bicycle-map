const path = require('path');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
require('dotenv').config();

const dev = false;

// Local-dev default matches the host port Epic 2's docker-compose `api`
// service publishes ("5000:8080") — see docs/planning/layers/ui-layer.md §9
// item 5. Override via website/.env (gitignored, see .env.example) or a
// shell env var.
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';

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
            }
        ],
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './src/index.html',
            minify: false
        }),
        new webpack.DefinePlugin({
            API_BASE_URL: JSON.stringify(API_BASE_URL)
        })
    ]
};