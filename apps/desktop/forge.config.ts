// Forge 使用官方 Webpack/TypeScript 插件，输出 Windows 安装程序及桌面 ZIP。
import type { ForgeConfig } from "@electron-forge/shared-types";
import { resolve } from "node:path";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerNSIS } from "./scripts/nsis-maker";
import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";
import { preloadConfig } from "./webpack.preload.config";
import { copyRuntimeDependencies, finalizeRuntimeManifest } from "./scripts/runtime-dependencies";

const config: ForgeConfig = {
  // Core 动态模块、原生包及 ripgrep 子进程沿用真实目录路径。
  packagerConfig: { asar: false, executableName: "autopilot-desktop", icon: resolve(__dirname, "src/assets/autopilot") },
  // node-pty 1.1.0 自带目标平台 N-API 预编译，打包 hook 校验身份，升级依赖时须复验。
  rebuildConfig: { ignoreModules: ["node-pty"] },
  makers: [
    new MakerNSIS(),
    new MakerZIP({}, ["win32", "darwin"]),
  ],
  hooks: { packageAfterCopy: copyRuntimeDependencies, packageAfterPrune: finalizeRuntimeManifest },
  plugins: [
    new WebpackPlugin({
      // Desktop 开发服务器使用独立端口，避免占用 Web 常用的 3000。
      port: 3177,
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [{ html: "./src/index.html", js: "./src/renderer.tsx", name: "main_window", preload: { js: "./src/preload.ts", config: preloadConfig } }],
      },
    }),
  ],
};

export default config;
