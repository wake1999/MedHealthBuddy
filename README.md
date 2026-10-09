# MedHealthBuddy

在 Windows 上使用**运行在服务器上的** DeepSeek Harness（DSH）。

*A Windows desktop shell for a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that runs on a remote server: it starts or reuses `dsh web` there over the system ssh, forwards its port, and shows the remote UI in its own window — with an ECG-monitor start-up intro, multi-server support, desktop notifications, one-click server install and a companion DSH plugin (`dsh-desktop-link`).*

> **非官方项目。** 本项目是社区开发的第三方工具，与 DeepSeek 没有隶属或背书关系。「DeepSeek」名称归 DeepSeek 所有，这里仅用于标明所连接的软件；如权利人有异议，请提 issue，我会替换。
>
> *Unofficial, community-made tool, not affiliated with or endorsed by DeepSeek. The DeepSeek name belongs to DeepSeek and is used only to identify the software this connects to.*

应用通过系统自带的 ssh 登录服务器，启动或复用那里的 `dsh web`，把它的端口转发到本机，再在自己的窗口里显示 DSH 的界面。DSH、它的 profile、会话和工作区都留在服务器上；本机只负责显示，不运行 DSH，也不保存任何密钥。

- 启动时播放一段心电监护仪风格的过场动画（点击任意处可跳过），随后进入界面
- 可以同时连接多台服务器，在窗口里切换
- 可选「启动时自动连接」：打开应用就自动连上列表里的第一台服务器，就绪后直接进入它的界面
- 远端任务完成时弹出 Windows 通知，任务栏显示角标
- 会话顶部有「VS Code」按钮，通过 Remote-SSH 打开会话所在的目录
- 能在服务器上一键安装或升级 DSH 和配套插件，只写入你的家目录，不需要 root
- 断线或电脑睡眠唤醒后自动重连；可以选择退出应用时是否停止远端 DSH

## 安装

两种分发方式，功能完全一致：

| 方式 | 文件 | 说明 |
|---|---|---|
| 安装包 | `MedHealthBuddy-Setup-<版本>.exe` | 默认只为当前用户安装，不需要管理员权限，可更改安装位置；创建开始菜单和桌面快捷方式，并支持自动更新 |
| 便携版 | `MedHealthBuddy-<版本>-portable.zip` | 解压到任意目录，运行 `MedHealthBuddy.exe` 即可，免安装 |

两者都没有数字签名，第一次运行时 Windows SmartScreen 可能提示「Windows 已保护你的电脑」。点「更多信息」，再点「仍要运行」即可。便携版与安装版共用同一份数据（见「数据与日志」），可以互相替代使用。

## 准备

1. **ssh 能免密登录服务器。** 应用用的是 Windows 自带的 OpenSSH（`C:\Windows\System32\OpenSSH\ssh.exe`），读取你的 `%USERPROFILE%\.ssh\config`。建议在里面为服务器写一个 Host 别名，身份文件、端口、跳板机也都写在那里。先在终端里确认 `ssh <别名>` 能直接登录，不用输入密码或确认主机指纹。
2. **服务器上有 DSH。** 如果还没有，添加服务器后在「连接管理 → 安装与升级」里检查一下，按提示一键安装：Node.js、pnpm、DSH 和配套插件 dsh-desktop-link 会装进 `~/.local/opt` 和 `~/.dsh`。

## 使用

1. 打开应用。启动时会先播放一段心电监护仪过场（约 3.6 秒，点击或按任意键可跳过）。
2. 在「应用 → 连接管理 → 添加服务器」里填写 ssh 别名和服务器上的工作目录，然后保存。想让应用以后自动连上，在「连接管理 → 服务器」里勾选**「启动时自动连接」**（自动连接列表里的第一台服务器）。
3. 点「连接」。第一次启动远端 DSH 通常要 1–3 分钟，之后再连接会直接复用，只需几秒。
4. 连接后，窗口里的操作和在浏览器里用 DSH 完全一样。窗口左上角的「应用」菜单可以切换服务器、打开连接管理、测试通知。
5. 点窗口右上角的 × 不会退出，只会收起到任务栏右下角的通知区域（托盘）：连接照常保持，任务完成照常通知。单击托盘图标可以重新打开窗口；要真正退出，在托盘图标的右键菜单或「应用」菜单里选「退出」。

> 「VS Code」按钮和任务完成通知都由服务器上的配套插件提供。它们只在**远端 DSH 由本应用启动**时生效；如果你连接的是别处已经启动的 DSH，应用会提示「重启远端」——点一次即可让插件接管。

### 退出应用时

在每台服务器的「连接设置」里选择：

- **保持远端运行**（默认）：服务器上的 DSH 继续运行，下次打开应用直接接上，正在跑的任务不受影响。
- **停止远端**：正常退出时停止服务器上的 DSH。如果应用被强制结束、崩溃或长时间断网，远端会在约 10 分钟后自行停止。这需要服务器上装有配套插件。

## 数据与日志

| 内容 | 位置 |
|---|---|
| 服务器列表 | `%APPDATA%\MedHealthBuddy\connections.json` |
| 应用选项（是否自动连接等） | `%APPDATA%\MedHealthBuddy\settings.json` |
| 各服务器的登录状态（cookie） | `%APPDATA%\MedHealthBuddy\Partitions\` |
| 日志 | `%APPDATA%\MedHealthBuddy\logs\main.log`（超过 1 MB 轮换为 `main.old.log`） |

所有目录都叫 MedHealthBuddy：默认安装位置是 `%LOCALAPPDATA%\Programs\MedHealthBuddy`，安装程序自己的副本放在 `%LOCALAPPDATA%\MedHealthBuddy\updater`。更早版本的旧目录（`%APPDATA%\dsh-ssh-desktop` 和 `%APPDATA%\DSH SSH Desktop`）会在第一次启动时自动搬到新位置。

日志和「连接管理 → 导出诊断」生成的文件都会去掉启动令牌和连接密钥，可以直接附在问题报告里。卸载时这些数据会保留；如果不再需要，删除 `%APPDATA%\MedHealthBuddy` 即可。

## 开发

```sh
pnpm install
pnpm test                                                # 三个包的全部测试

pnpm --filter medhealthbuddy-desktop run package         # 安装包 + 便携压缩包，输出到 dist/installer/
pnpm --filter medhealthbuddy-desktop run icon            # 从 assets/icon-base.png 重新生成图标

# 只出便携压缩包（或只出安装包）：
$env:PACKAGE_TARGETS = 'zip'      # PowerShell；cmd 里用 set PACKAGE_TARGETS=zip
pnpm --filter medhealthbuddy-desktop run package
```

打包产物：

- `dist/installer/MedHealthBuddy-Setup-<版本>.exe`（NSIS 安装包，附 `.blockmap`）
- `dist/installer/MedHealthBuddy-<版本>-portable.zip`（便携版）
- `dist/dsh-desktop-link-<版本>.tgz`（随包分发的服务器插件，首次打包时自动生成）

开发时运行：

1. 第一次先运行 `setup-electron-runtime.cmd`——工作区带有低完整性标签，直接运行项目里的 electron.exe 会因为沙箱无法初始化而崩溃；脚本会把运行时复制到工作区之外的 `%LOCALAPPDATA%\medhealthbuddy-dev`，并顺手把应用图标写进运行时的 `MedHealthBuddy.exe`。
2. 之后用 `start-desktop.cmd` 启动开发版。

开发辅助脚本（都在 `packages/desktop/scripts/`）：

- `dev-shortcut.ps1`：创建带 AppUserModelID 的开始菜单快捷方式。Windows 的任务栏图标和通知都按 AUMID 解析，而这个属性 Electron 自己写不进去，所以需要它跑一次。
- `dev-runtime-icon.ps1`：把应用图标用 rcedit 烧进运行时的 `MedHealthBuddy.exe`，保证开发版的任务栏图标也是应用自己的（Electron 升级后重跑一次）。

仓库结构：

- `packages/core`（`@dsh-ssh/core`）：连接引擎（ssh、远端启动、端口转发、服务器安装），纯 Node，不依赖 Electron
- `packages/desktop`（`medhealthbuddy-desktop`）：Electron 桌面端
- `packages/server-plugin`（`dsh-desktop-link`）：服务器端配套插件（握手、租约、任务完成通知、VS Code 按钮）
