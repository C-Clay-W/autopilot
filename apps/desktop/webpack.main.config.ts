// 主进程只打包桌面代码，共享包保留公开发布产物与原生依赖布局。
import type { Configuration } from "webpack";

export const mainConfig: Configuration = {
  entry: { index: "./src/main.ts", orchestration: { import: "./src/orchestration-bootstrap.ts", filename: "orchestration-worker.cjs" } },
  module: { rules: [{ test: /\.png$/, type: "asset/inline" }, { test: /\.tsx?$/, exclude: /node_modules/, use: "ts-loader" }] },
  resolve: { extensions: [".js", ".ts", ".tsx"] },
  externals: {
    "node-pty": "commonjs node-pty",
    "@autopilot-agent/cli/dist/main.js": "commonjs @autopilot-agent/cli/dist/main.js",
    "@autopilot-agent/core": "commonjs @autopilot-agent/core",
    "@autopilot-agent/adapters": "commonjs @autopilot-agent/adapters",
    "@autopilot-agent/presentation": "commonjs @autopilot-agent/presentation",
  },
};
