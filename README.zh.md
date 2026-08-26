# dsh-win-docker-workspace

[English](README.md) · [中文](README.zh.md)

在 DeepSeek Harness Web GUI 中「添加 Docker 工作区」：让 agent 会话的 pwsh 命令与文件读写都运行在宿主机的一个 **Windows Docker 容器**里，路径均为容器路径（`C:\workspace\...`），容器内无需安装任何工具链（文件工具经 bind mount 直读宿主源码）。VS Code Remote-Container 风格。

## 安装

```powershell
# 本地 submodule 目录（本仓库用法）
dsh plugin --profile web add E:\Workspace\submodules\dsh-win-docker-workspace

# 或 GitHub 仓库（仓库内已含预构建 lib/）
dsh plugin --profile web add https://github.com/unknownue/dsh-win-docker-workspace
```

重启 `dsh web` 后，侧栏底部 Settings 旁出现 D 按钮。

## 使用

点侧栏底部 Settings 旁的 D 按钮，打开「添加 Docker 工作区」对话框：

1. 从下拉框选一个**运行中**的容器（`docker ps`）；
2. 自动定位到该容器的第一个 bind mount 目标（如 `C:\workspace\pyscript`），浏览目录树或直接输入容器绝对路径（如 `C:\workspace\pyscript`）；
3. 可选填「容器内 shell」（留空则用 `powershell.exe`，可填 `pwsh.exe` / `cmd.exe`）；
4. 点「检查」确认路径存在，再「创建并打开」。

点「创建并打开」后，新会话随即运行在容器内：`pwsh` 工具通过 `docker exec -i -w <路径> <容器> powershell.exe ...` 执行，`read`/`write`/`edit` 读写容器路径对应的宿主 bind-mount 文件，模型看到的所有路径都是容器路径。模式选择器照常可用，自动落到 `win-docker-standard` / `win-docker-code` / `win-docker-minimal` / `win-docker-cordis` 变体。

## 行为与权限说明

- **pwsh 工具**：以 `docker exec` 在所选容器内运行（默认 `powershell.exe`）。Docker 容器即隔离边界，DSH 文件策略不作用于容器内命令。
- **文件工具（read/write/edit）**：经容器 bind mount 映射到宿主路径，受 DSH 文件策略约束；`workspace-write` 下写仅限会话工作区。仅覆盖 bind-mount 挂载的路径，容器私有路径不可读写。
- 容器未运行时 `docker exec`/`docker inspect` 会失败并给出「start the container」提示；文件工具在路径不在任何 bind mount 下时 fail loud，不回退宿主。

## 许可与出处

MIT，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。本插件改编自 `dsh-wsl-workspace`（MIT）与 DeepSeek Harness（MIT），发布/再分发请保留 LICENSE 与 NOTICE。
