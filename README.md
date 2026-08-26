# dsh-win-docker-workspace

English | [中文](README.zh.md)

Add a Windows Docker container workspace to the DeepSeek Harness Web GUI: the agent session's pwsh commands and file reads/writes run inside a Windows container on the host, with container paths (`C:\workspace\...`) throughout and no toolchain install inside the container (file tools read the bind-mounted source on the host directly). VS Code Remote-Container style.

## Install

```powershell
# Local submodule checkout (this repository's usage)
dsh plugin --profile web add E:\Workspace\submodules\dsh-win-docker-workspace

# Or the GitHub repository (ships a prebuilt lib/)
dsh plugin --profile web add https://github.com/unknownue/dsh-win-docker-workspace
```

Restart `dsh web`; a D button appears beside Settings at the sidebar foot.

## Usage

Click the D button to open the "Add Docker workspace" dialog:

1. Pick a **running** container (`docker ps`);
2. It auto-locates the container's first bind-mount destination (e.g. `C:\workspace\pyscript`); browse the tree or type an absolute container path;
3. Optionally set the in-container shell (empty = `powershell.exe`; `pwsh.exe` / `cmd.exe` are allowed);
4. "Check" the path, then "Create & open".

The new session runs in the container: `pwsh` executes via `docker exec -i -w <path> <container> powershell.exe ...`, file tools read/write the host bind-mounted source, and the model sees container paths only. The mode picker keeps working and lands on `win-docker-standard` / `win-docker-code` / `win-docker-minimal` / `win-docker-cordis` variants.

## Behavior and permissions

- **pwsh tool**: runs in the container via `docker exec` (default `powershell.exe`). The container is the isolation boundary; the DSH file policy does not wrap container commands.
- **File tools (read/write/edit)**: map through the container's bind mounts to the host and remain under the DSH file policy. Only bind-mounted paths are reachable; container-private paths error out.
- A stopped container fails `docker exec`/`docker inspect` with an actionable "start the container" error; file tools fail loud on paths outside any bind mount (never falling back to the host).

## License and attribution

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). This plugin adapts `dsh-wsl-workspace` (MIT) and DeepSeek Harness (MIT); keep both files when redistributing.
