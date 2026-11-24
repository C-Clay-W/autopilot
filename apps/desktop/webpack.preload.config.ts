// 隔离 preload 只编译桥接代码，禁止注入依赖浏览器环境的开发服务器客户端。
import type { Configuration } from "webpack";
import { rendererConfig } from "./webpack.renderer.config";

export const preloadConfig: Configuration = {
  ...rendererConfig,
  // @ts-expect-error 开发服务器运行时支持 false，当前合并类型仅声明配置对象。
  devServer: false,
};
