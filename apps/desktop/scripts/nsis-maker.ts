// Forge 继续负责应用目录，NSIS 提供可选目录、明确确认和完成页的 Windows 安装向导。
import { MakerBase, type MakerOptions } from "@electron-forge/maker-base";
import type { ForgePlatform } from "@electron-forge/shared-types";
import { build, Platform, Arch, type Configuration } from "electron-builder";
import { resolve } from "node:path";

/** 当前用户安装保留用户数据，安装完成后由用户自行启动应用。 */
export const windowsInstaller: Configuration = {
  appId: "com.autopilot.desktop",
  productName: "Autopilot Desktop",
  executableName: "autopilot-desktop",
  artifactName: "AutopilotDesktopSetup-${version}-${arch}.${ext}",
  asar: false,
  compression: "normal",
  win: { icon: resolve(__dirname, "../src/assets/autopilot.ico"), signAndEditExecutable: false },
  nsis: {
    oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: true,
    runAfterFinish: false, deleteAppDataOnUninstall: false, createDesktopShortcut: true,
    installerLanguages: ["zh_CN", "en_US"], displayLanguageSelector: false,
    include: resolve(__dirname, "installer.nsh"),
  },
};

/** 通过官方 electron-builder NSIS 目标封装 Forge 成品，不另建应用编译流程。 */
export class MakerNSIS extends MakerBase<Record<string, never>> {
  name = "nsis";
  defaultPlatforms: ForgePlatform[] = ["win32"];
  /** Windows 原生安装包仅在 Windows 构建机制作。 */
  isSupportedOnCurrentPlatform(): boolean { return process.platform === "win32"; }
  /** 使用当前目标架构和已打包目录，返回实际安装包路径供 Forge 记录。 */
  async make({ dir, makeDir, targetArch }: MakerOptions): Promise<string[]> {
    if (targetArch !== "x64" && targetArch !== "arm64") throw new Error("Windows installer supports x64 or arm64");
    return build({
      projectDir: resolve(__dirname, ".."), prepackaged: dir,
      targets: Platform.WINDOWS.createTarget("nsis", targetArch === "x64" ? Arch.x64 : Arch.arm64),
      config: { ...windowsInstaller, directories: { output: resolve(makeDir, "nsis", targetArch) }, extends: null },
    });
  }
}
