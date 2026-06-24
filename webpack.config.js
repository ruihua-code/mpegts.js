const webpack = require('webpack');
const packagejson = require("./package.json");
const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = (env, argv) => {
    const isDevelopment = argv.mode === 'development';

    return {
        entry: './src/index.js',
        output: {
            filename: 'mpegts.js',
            path: path.resolve(__dirname, 'dist'),
            library: 'mpegts',
            libraryTarget: 'umd',
            devtoolModuleFilenameTemplate: isDevelopment 
                ? 'webpack://mpegts/[resource-path]'
                : undefined
        },

        devtool: isDevelopment ? 'eval-source-map' : 'source-map',

        resolve: {
            extensions: ['.ts', '.tsx', '.js', '.json']
        },

        plugins: [
            new webpack.DefinePlugin({
              __VERSION__: JSON.stringify(packagejson.version)
            })
        ],

        optimization: {
            minimizer: [
                new TerserPlugin()
            ]
        },

        module: {
            rules: [
                {
                    test: /\.(ts|js)$/,
                    use: 'ts-loader',
                    exclude: /node-modules/
                },
                {
                    enforce: 'pre',
                    test: /\.js$/,
                    use: 'source-map-loader'
                }
            ]
        },

        node: {
            fs: 'empty'
        },

        devServer: {
            contentBase: path.resolve(__dirname, 'demo'),
            proxy: {
                '/dist': {
                    target: 'http://localhost:8080',
                    pathRewrite: {'^/dist' : ''}
                }
            }
        }
    };
};
