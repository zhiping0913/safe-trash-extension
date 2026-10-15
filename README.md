# Safe Trash for VS Code

Safe Trash protects workspace files from accidental deletion. Instead of
permanently deleting selected files or directories, it moves them into a
configurable trash directory inside the same workspace.

## What it does

- Adds **Move to Safe Trash** to the Explorer context menu.
- Handles `Delete` and `Shift+Delete` while the Explorer has focus.
- Supports single and multiple Explorer selections.
- Preserves each item's workspace-relative directory structure.
- Requests confirmation before moving anything.
- Adds a timestamp and counter when a destination already exists, so an older
  trashed item is not overwritten.
- Validates every selected item before moving any of them.
- Rejects the workspace root, items already in the trash directory, paths
  outside the workspace, and symbolic-link escapes.

Safe Trash performs a filesystem rename. It deliberately has no copy-and-delete
fallback.

## Supported environments

- VS Code Desktop with a local filesystem workspace
- Remote SSH
- WSL
- Dev Containers

Safe Trash requires a real `file://` workspace. Browser-only virtual
workspaces and virtual filesystem providers are not supported.

## Installation

### Install a packaged VSIX

1. If a release includes a `.vsix` asset, download it from this repository's
   Releases page. Otherwise, build it from source using the instructions below.
2. In VS Code, open the Command Palette.
3. Run **Extensions: Install from VSIX...**.
4. Select the downloaded `.vsix` file.
5. Reload the VS Code window when prompted.

For Remote SSH, WSL, or Dev Containers, open the remote window first and
install the VSIX on the remote target when VS Code asks where to install it.

### Build and install from source

Requirements: Node.js, npm, and VS Code 1.90 or newer.

```bash
git clone https://github.com/zhiping0913/safe-trash-extension.git
cd safe-trash-extension
npx --yes @vscode/vsce package --no-dependencies --skip-license
```

Then run **Extensions: Install from VSIX...** and select the generated
`safe-trash-<version>.vsix` file.

## Usage

Select one or more files or directories in the Explorer, then either:

- choose **Move to Safe Trash** from the context menu; or
- press `Delete` or `Shift+Delete` while the Explorer has focus.

Review the confirmation dialog and choose **Move to Trash**. The selected items
will be moved under the configured trash directory in their workspace.

For example, with the default configuration:

```text
workspace/results/run-01/data.csv
    -> workspace/.trash/results/run-01/data.csv
```

## Configuration

`safeTrash.directory` controls the trash directory independently for each
workspace folder. Its default value is `.trash`.

Example workspace setting:

```json
{
    "safeTrash.directory": ".safe-trash"
}
```

The value must be a non-empty path relative to the workspace folder. Absolute
paths, `.`, `..`, `../trash`, and any other value resolving outside the
workspace are rejected. An existing trash path that resolves outside the
workspace through a symbolic link is also rejected.

## Important notes

- Safe Trash does not automatically empty the trash directory.
- Each workspace folder in a multi-root workspace has its own trash directory.
- Files inside the configured trash directory are intentionally excluded from
  further Safe Trash moves.
- The extension temporarily uses VS Code's **Copy Path** command to resolve an
  Explorer selection invoked by a keyboard shortcut. The previous clipboard
  contents are restored immediately.

## Development

Validate and package the extension with:

```bash
node --check extension.js
npx --yes @vscode/vsce package --no-dependencies --skip-license
```

The extension has no runtime npm dependencies.
