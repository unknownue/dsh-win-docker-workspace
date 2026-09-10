# dsh-win-docker-workspace

English | [中文](README.zh.md)

Add a Windows Docker container workspace to the DeepSeek Harness Web GUI: the agent session's pwsh commands and file reads/writes run inside a Windows container on the host, with container paths (`C:\workspace\...`) throughout and no toolchain install inside the container (file tools read the bind-mounted source on the host directly). VS Code Remote-Container style.

## Install

```powershell
# Local submodule checkout (this repository's usage). pnpm records it as a
# link: dependency; the bundled helper repairs the cross-drive junction that
# pnpm creates broken on Windows.
.\scripts\install-profile.ps1

# Or the GitHub repository (ships a prebuilt lib/)
dsh plugin --profile web add https://github.com/unknownue/dsh-win-docker-workspace
```

Restart `dsh web`; a D button appears beside Settings at the sidebar foot.
When developing from the local checkout, `pnpm build` + restart `dsh web` +
refresh the page is enough — the profile loads the checkout live through the
junction (re-run `install-profile.ps1` only if a `dsh plugin`/`pnpm` command
replaces the junction).

If the D button disappears: a `dsh plugin`/`pnpm` run most likely happened
while the junction was broken, so dsh's bundle reconcile judged the package as
declaring no `dsh.bundle` and dropped `dsh-win-docker-workspace` from the
profile's `dsh.profile.bundles`. Re-run `install-profile.ps1` to restore the
entry automatically, then restart `dsh web`.

## Usage

Click the D button to open the "Add Docker workspace" dialog:

1. Pick a **running** container (`docker ps`);
2. It auto-locates the container's first bind-mount destination (e.g. `C:\workspace\pyscript`); browse the tree or type an absolute container path;
3. Optionally set the in-container shell (empty = `powershell.exe`; `pwsh.exe` / `cmd.exe` are allowed);
4. "Check" the path, then "Create & open".

The new session runs in the container: `pwsh` executes via `docker exec -i -w <path> <container> powershell.exe ...`, file tools read/write the host bind-mounted source, and the model sees container paths only. The mode picker keeps working and lands on `win-docker-standard` / `win-docker-code` / `win-docker-minimal` / `win-docker-cordis` variants.

## Workspace identity

Every Docker workspace is one **(container, container path)** pair. The harness identifies a workspace by a unique host directory, so the plugin registers each pair under its own host anchor (`~/.dsh/win-docker-workspaces/<container>/<drive>/<path>`) while the session keeps seeing only container paths. Two containers that present the same in-container path (e.g. both bind-mount `C:\workspace`) are therefore fully independent: each gets its own workspace row and its own sessions, and every command/file access goes to the container the workspace was added for. The in-container workspace root is exposed to the model as `$env:DSH_DOCKER_WORKSPACE` (alongside `$env:DSH_DOCKER_CONTAINER`); the default command working directory is that root.

Workspaces added with older plugin versions were registered under the container path itself, so two containers sharing one path could only exist as a single workspace. After updating, add each such workspace again through the dialog (the store migrates the old record automatically) and delete the old workspace row.

## Behavior and permissions

- **pwsh tool**: runs in the container via `docker exec` (default `powershell.exe`). The container is the isolation boundary; the DSH file policy does not wrap container commands.
- **File tools (read/write/edit)**: map through the container's bind mounts to the host and remain under the DSH file policy. Only bind-mounted paths are reachable; container-private paths error out.
- A stopped container fails `docker exec`/`docker inspect` with an actionable "start the container" error; file tools fail loud on paths outside any bind mount (never falling back to the host).

## License and attribution

MIT, see [LICENSE](LICENSE) and [NOTICE](NOTICE). This plugin adapts `dsh-wsl-workspace` (MIT) and DeepSeek Harness (MIT); keep both files when redistributing.
