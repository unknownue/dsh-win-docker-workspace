/**
 * Bilingual dictionaries for the `winDockerWorkspace` locale namespace.
 * Product copy is Chinese; English is the parallel export.
 */

/** The `winDockerWorkspace` translations (Chinese, the primary product copy). */
export const zh: Record<string, string> = {
  'action.add': 'Docker 工作区',
  'action.title': '添加 Docker 工作区…',

  'dialog.title': '添加 Docker 工作区',
  'dialog.container': '容器',
  'dialog.path': '路径',
  'dialog.pathPlaceholder': 'C:\\workspace\\pyscript',
  'dialog.shell': '容器内 shell',
  'dialog.shellPlaceholder': '留空则使用 powershell.exe',
  'dialog.loading': '正在加载…',
  'dialog.browseEmpty': '此目录没有子文件夹',
  'dialog.upLevel': '..（返回上级）',
  'dialog.check': '检查',
  'dialog.confirm': '创建并打开',
  'dialog.cancel': '取消',
  'dialog.retry': '重试',

  'error.loadContainers': '无法获取运行中的容器列表，请确认 Docker 已启动且处于 Windows 容器模式',
  'error.loadMounts': '无法读取该容器的挂载列表',
  'error.loadDir': '无法浏览该目录',
  'error.presetMissing': '未找到健康的 win-docker preset，请确认插件宿主端已安装并配置该 preset',
  'error.invalidPath': '请输入以盘符开头的容器绝对路径（如 C:\\workspace\\pyscript）',
  'error.invalidShell': 'shell 名无效：仅可含字母、数字、_、.、-，可带 .exe 后缀',
  'error.pathNotFound': '该路径不存在、或是文件；请选择一个文件夹',
  'error.notInBindMount': '该路径既不在容器的 bind-mount 挂载内、也不是挂载点的父目录，文件工具无法读写；请选择挂载目录或其父目录（如 C:\\workspace 或 C:\\workspace\\pyscript）',
  'error.createFailed': '创建工作区失败',
}

/** The `winDockerWorkspace` translations (English). */
export const en: Record<string, string> = {
  'action.add': 'Docker Workspace',
  'action.title': 'Add Docker workspace…',

  'dialog.title': 'Add Docker workspace',
  'dialog.container': 'Container',
  'dialog.path': 'Path',
  'dialog.pathPlaceholder': 'C:\\workspace\\pyscript',
  'dialog.shell': 'Container shell',
  'dialog.shellPlaceholder': 'Leave empty to use powershell.exe',
  'dialog.loading': 'Loading…',
  'dialog.browseEmpty': 'No subdirectories here',
  'dialog.upLevel': '.. (up)',
  'dialog.check': 'Check',
  'dialog.confirm': 'Create & open',
  'dialog.cancel': 'Cancel',
  'dialog.retry': 'Retry',

  'error.loadContainers': 'Could not list running containers; confirm Docker is running in Windows container mode',
  'error.loadMounts': 'Could not read this container\'s mounts',
  'error.loadDir': 'Could not browse this directory',
  'error.presetMissing': 'No healthy "win-docker" preset found; confirm the plugin host side installed and configured it',
  'error.invalidPath': 'Enter an absolute container path starting with a drive letter (e.g. C:\\workspace\\pyscript)',
  'error.invalidShell': 'Invalid shell: only letters, digits, _ . - (an optional .exe suffix)',
  'error.pathNotFound': 'The path does not exist or is a file; choose a folder',
  'error.notInBindMount': 'This path is neither inside a container bind mount nor an ancestor of one, so the file tools cannot read or write it; choose a mounted directory or its parent (e.g. C:\\workspace or C:\\workspace\\pyscript)',
  'error.createFailed': 'Failed to create the workspace',
}
