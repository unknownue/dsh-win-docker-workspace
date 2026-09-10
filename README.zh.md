# dsh-win-docker-workspace

[English](README.md) · [中文](README.zh.md)

在 DeepSeek Harness Web GUI 中「添加 Docker 工作区」：让 agent 会话的 pwsh 命令与文件读写都运行在宿主机的一个 **Windows Docker 容器**里，路径均为容器路径（`C:\workspace\...`），容器内无需安装任何工具链（文件工具经 bind mount 直读宿主源码）。VS Code Remote-Container 风格。

## 安装

```powershell
# 本地 submodule 目录（本仓库用法）。pnpm 会将其记为 link: 依赖；
# 随附脚本会修复 pnpm 在 Windows 上跨盘符 link: 生成的坏 junction。
.\scripts\install-profile.ps1

# 或 GitHub 仓库（仓库内已含预构建 lib/）
dsh plugin --profile web add https://github.com/unknownue/dsh-win-docker-workspace
```

重启 `dsh web` 后，侧栏底部 Settings 旁出现 D 按钮。本地 checkout 开发时，`pnpm build` + 重启 `dsh web` + 刷新页面即可生效（profile 经 junction 实时加载 checkout；仅当再次运行过 `dsh plugin`/`pnpm` 命令重建 junction 后，才需要重跑 `install-profile.ps1`）。

若 D 按钮消失：多半是某次 `dsh plugin`/`pnpm` 在坏 junction 期间运行，dsh 的 bundle reconcile 误判「该包未声明 dsh.bundle」，把 `dsh-win-docker-workspace` 从 profile 的 `dsh.profile.bundles` 中删掉了。重跑 `install-profile.ps1` 即可自动补回条目，再重启 `dsh web`。

## 使用

点侧栏底部 Settings 旁的 D 按钮，打开「添加 Docker 工作区」对话框：

1. 从下拉框选一个**运行中**的容器（`docker ps`）；
2. 自动定位到该容器的第一个 bind mount 目标（如 `C:\workspace\pyscript`），浏览目录树或直接输入容器绝对路径（如 `C:\workspace\pyscript`）；
3. 可选填「容器内 shell」（留空则用 `powershell.exe`，可填 `pwsh.exe` / `cmd.exe`）；
4. 点「检查」确认路径存在，再「创建并打开」。

点「创建并打开」后，新会话随即运行在容器内：`pwsh` 工具通过 `docker exec -i -w <路径> <容器> powershell.exe ...` 执行，`read`/`write`/`edit` 读写容器路径对应的宿主 bind-mount 文件，模型看到的所有路径都是容器路径。模式选择器照常可用，自动落到 `win-docker-standard` / `win-docker-code` / `win-docker-minimal` / `win-docker-cordis` 变体。

## 工作区身份

每个 Docker 工作区都是一对 **(容器, 容器内路径)**。Harness 以「唯一的宿主目录」标识一个工作区，因此插件把每对 (容器, 路径) 注册在各自的宿主锚点目录下（`~/.dsh/win-docker-workspaces/<容器>/<盘符>/<路径>`），而会话看到的仍然只有容器路径。这样**两个容器即使呈现相同的容器内路径**（例如都把 `C:\workspace` 挂进各自容器），工作区也完全独立：各占一个工作区行、各自的会话，命令与文件访问都落到添加该工作区时指定的容器。模型可通过 `$env:DSH_DOCKER_WORKSPACE` 拿到容器内工作区根路径（另有 `$env:DSH_DOCKER_CONTAINER`）；命令默认工作目录即该根路径。

旧版本插件把工作区直接注册在容器路径下，两个容器共享同一路径时只能共存为一个工作区。更新后请通过对话框重新添加这些工作区（存储会自动迁移旧记录），并在侧栏删除旧的工作区行。

## 行为与权限说明

- **pwsh 工具**：以 `docker exec` 在所选容器内运行（默认 `powershell.exe`）。Docker 容器即隔离边界，DSH 文件策略不作用于容器内命令。
- **文件工具（read/write/edit）**：经容器 bind mount 映射到宿主路径，受 DSH 文件策略约束；`workspace-write` 下写仅限会话工作区。仅覆盖 bind-mount 挂载的路径，容器私有路径不可读写。
- 容器未运行时 `docker exec`/`docker inspect` 会失败并给出「start the container」提示；文件工具在路径不在任何 bind mount 下时 fail loud，不回退宿主。

## 许可与出处

MIT，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。本插件改编自 `dsh-wsl-workspace`（MIT）与 DeepSeek Harness（MIT），发布/再分发请保留 LICENSE 与 NOTICE。
