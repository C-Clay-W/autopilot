// React 与 Tailwind 在隔离的浏览器环境编译，preload 仅使用 Electron 内建能力。
import type { Configuration } from "webpack";

export const rendererConfig: Configuration = {
  devtool: "source-map",
  module: {
    rules: [
      { test: /\.(woff2|svg)$/, type: "asset/resource" },
      { test: /\.tsx?$/, exclude: /node_modules/, use: "ts-loader" },
      { test: /\.css$/, use: ["style-loader", "css-loader", { loader: "postcss-loader", options: { postcssOptions: { plugins: { "@tailwindcss/postcss": {} } } } }] },
    ],
  },
  resolve: { extensions: [".js", ".ts", ".tsx", ".css"] },
};
