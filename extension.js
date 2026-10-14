const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;

function normalize(p) {
    return path.resolve(p);
}

function isInside(child, parent) {
    child = normalize(child);
    parent = normalize(parent);

    return (
        child === parent ||
        child.startsWith(parent + path.sep)
    );
}

function getConfiguredTrashRoot(workspaceRoot, sourceUri) {
    const configuredDirectory =
        vscode.workspace
            .getConfiguration('safeTrash', sourceUri)
            .get('directory', '.trash');

    if (
        typeof configuredDirectory !== 'string' ||
        configuredDirectory.length === 0
    ) {
        throw new Error(
            'safeTrash.directory must be a non-empty relative path.'
        );
    }

    if (path.isAbsolute(configuredDirectory)) {
        throw new Error(
            `safeTrash.directory must be relative to the workspace:\n` +
            `${configuredDirectory}`
        );
    }

    const trashRoot =
        normalize(
            path.resolve(
                workspaceRoot,
                configuredDirectory
            )
        );

    /*
     * The trash directory must be a child of the workspace. In particular,
     * values such as "..", "../trash", and "." are not allowed.
     */
    if (
        trashRoot === workspaceRoot ||
        !isInside(trashRoot, workspaceRoot)
    ) {
        throw new Error(
            `safeTrash.directory resolves outside the workspace:\n` +
            `${configuredDirectory}\n\n` +
            `Resolved path:\n${trashRoot}\n\n` +
            `Workspace:\n${workspaceRoot}`
        );
    }

    return trashRoot;
}

/*
 * Resolve all symlinks and return the real filesystem path.
 */
async function realPath(p) {
    return await fs.realpath(p);
}

async function exists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch {
        return false;
    }
}

async function getUniqueDestination(destination) {
    if (!(await exists(destination))) {
        return destination;
    }

    const parsed = path.parse(destination.fsPath);

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');

    const stamp =
        now.getFullYear() +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        '-' +
        pad(now.getHours()) +
        pad(now.getMinutes()) +
        pad(now.getSeconds());

    let counter = 1;

    while (true) {
        const candidate =
            vscode.Uri.file(
                path.join(
                    parsed.dir,
                    `${parsed.name}.${stamp}.${counter}${parsed.ext}`
                )
            );

        if (!(await exists(candidate))) {
            return candidate;
        }

        counter++;
    }
}

/*
 * Validate a source path against its workspace.
 *
 * IMPORTANT:
 *
 * We check BOTH:
 *
 *   logical path
 *   real path after resolving symlinks
 *
 * This prevents:
 *
 *   workspace/link -> /outside/path
 *
 * from bypassing the workspace boundary.
 */
async function validateSource(sourceUri) {

    if (sourceUri.scheme !== 'file') {
        throw new Error(
            `Safe Trash only supports file:// resources:\n${sourceUri.toString()}`
        );
    }

    const workspaceFolder =
        vscode.workspace.getWorkspaceFolder(sourceUri);

    if (!workspaceFolder) {
        throw new Error(
            `File is outside all open workspace folders:\n${sourceUri.fsPath}`
        );
    }

    if (workspaceFolder.uri.scheme !== 'file') {
        throw new Error(
            `Safe Trash only supports filesystem workspaces:\n` +
            `${workspaceFolder.uri.toString()}`
        );
    }

    /*
     * Logical paths as shown by VS Code.
     */
    const workspaceRoot =
        normalize(workspaceFolder.uri.fsPath);

    const sourcePath =
        normalize(sourceUri.fsPath);

    const trashRoot =
        getConfiguredTrashRoot(
            workspaceRoot,
            sourceUri
        );

    /*
     * First logical-path boundary check.
     */
    if (!isInside(sourcePath, workspaceRoot)) {
        throw new Error(
            `Refusing path outside workspace:\n` +
            `${sourcePath}\n\n` +
            `Workspace:\n${workspaceRoot}`
        );
    }

    /*
     * Do not allow workspace root itself.
     */
    if (sourcePath === workspaceRoot) {
        throw new Error(
            `Refusing to move the workspace root itself:\n${workspaceRoot}`
        );
    }

    /*
     * Do not allow .trash or anything inside it.
     */
    if (isInside(sourcePath, trashRoot)) {
        throw new Error(
            `Path is already inside Safe Trash:\n${sourcePath}`
        );
    }

    /*
     * Resolve symlinks.
     *
     * realpath() requires the path to exist.
     */
    let realWorkspaceRoot;
    let realSourcePath;

    try {
        realWorkspaceRoot =
            await realPath(workspaceRoot);
    }
    catch (err) {
        throw new Error(
            `Unable to resolve real workspace path:\n` +
            `${workspaceRoot}\n\n${String(err)}`
        );
    }

    try {
        realSourcePath =
            await realPath(sourcePath);
    }
    catch (err) {
        throw new Error(
            `Unable to resolve real source path:\n` +
            `${sourcePath}\n\n${String(err)}`
        );
    }

    realWorkspaceRoot =
        normalize(realWorkspaceRoot);

    realSourcePath =
        normalize(realSourcePath);

    /*
     * Critical security check.
     *
     * After resolving symlinks, the actual target
     * still has to be under the actual workspace root.
     */
    if (!isInside(realSourcePath, realWorkspaceRoot)) {
        throw new Error(
            `Safe Trash blocked a symlink escape.\n\n` +
            `Selected path:\n${sourcePath}\n\n` +
            `Resolves to:\n${realSourcePath}\n\n` +
            `Real workspace root:\n${realWorkspaceRoot}`
        );
    }

    /*
     * Resolve .trash parent/root safely.
     *
     * .trash may not exist yet, so realpath(.trash)
     * itself cannot always be used.
     *
     * Its parent is the workspace root, whose real
     * path we already validated.
     */
    const relativePath =
        path.relative(
            workspaceRoot,
            sourcePath
        );

    /*
     * Extra traversal protection.
     */
    if (
        relativePath === '..' ||
        relativePath.startsWith('..' + path.sep) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error(
            `Invalid relative path:\n${relativePath}`
        );
    }

    return {
        workspaceFolder,
        workspaceRoot,
        realWorkspaceRoot,
        sourcePath,
        realSourcePath,
        trashRoot,
        relativePath
    };
}

async function moveOneToTrash(sourceUri) {

    /*
     * Validate before changing anything.
     */
    const info =
        await validateSource(sourceUri);

    /*
     * Preserve original workspace-relative layout:
     *
     * workspace/run01/output/data.h5
     *
     * becomes
     *
     * workspace/<safeTrash.directory>/run01/output/data.h5
     */
    let destination =
        vscode.Uri.file(
            path.join(
                info.trashRoot,
                info.relativePath
            )
        );

    /*
     * Create destination parent.
     */
    await vscode.workspace.fs.createDirectory(
        vscode.Uri.file(
            path.dirname(destination.fsPath)
        )
    );

    /*
     * Verify that creating .trash did not somehow
     * produce a symlink escape.
     *
     * We check the REAL parent directory.
     */
    const destinationParent =
        path.dirname(destination.fsPath);

    let realDestinationParent;

    try {
        realDestinationParent =
            normalize(
                await realPath(destinationParent)
            );
    }
    catch (err) {
        throw new Error(
            `Unable to resolve trash destination:\n` +
            `${destinationParent}\n\n${String(err)}`
        );
    }

    /*
     * Destination must remain within the real workspace.
     */
    if (
        !isInside(
            realDestinationParent,
            info.realWorkspaceRoot
        )
    ) {
        throw new Error(
            `Safe Trash blocked a destination symlink escape.\n\n` +
            `Trash parent:\n${destinationParent}\n\n` +
            `Resolves to:\n${realDestinationParent}\n\n` +
            `Real workspace:\n${info.realWorkspaceRoot}`
        );
    }

    destination =
        await getUniqueDestination(
            destination
        );

    /*
     * Rename only.
     *
     * No copy+delete fallback.
     */
    await vscode.workspace.fs.rename(
        sourceUri,
        destination,
        {
            overwrite: false
        }
    );

    return {
        source: info.sourcePath,
        realSource: info.realSourcePath,
        destination: destination.fsPath,
        workspaceRoot: info.workspaceRoot
    };
}

async function validateAll(uris) {
    const results = [];
    const errors = [];

    for (const uri of uris) {
        try {
            const info =
                await validateSource(uri);

            results.push({
                uri,
                info
            });
        }
        catch (err) {
            errors.push({
                uri,
                error: String(err)
            });
        }
    }

    return {
        results,
        errors
    };
}

/*
 * Commands invoked from an Explorer context menu receive the clicked URI and
 * the Explorer selection. The same command invoked by a keybinding receives
 * no arguments, and the stable VS Code API does not expose the Explorer
 * selection directly.
 *
 * Use VS Code's own "Copy Path" command to resolve that selection, restoring
 * the user's clipboard immediately afterwards. Copy Path emits one absolute
 * path per line for a multi-selection.
 */
async function getExplorerSelectionFromKeybinding() {
    const previousClipboard =
        await vscode.env.clipboard.readText();

    const clipboardSentinel =
        `safe-trash-selection-${Date.now()}-${Math.random()}`;

    try {
        await vscode.env.clipboard.writeText(
            clipboardSentinel
        );

        await vscode.commands.executeCommand(
            'copyFilePath'
        );

        const copiedPaths =
            await vscode.env.clipboard.readText();

        if (
            !copiedPaths ||
            copiedPaths === clipboardSentinel
        ) {
            return [];
        }

        const seen = new Set();
        const uris = [];

        for (const copiedPath of copiedPaths.split(/\r?\n/)) {
            const value = copiedPath;

            if (!value || seen.has(value)) {
                continue;
            }

            seen.add(value);
            uris.push(vscode.Uri.file(value));
        }

        return uris;
    }
    finally {
        await vscode.env.clipboard.writeText(
            previousClipboard
        );
    }
}

function activate(context) {

    const disposable =
        vscode.commands.registerCommand(
            'safeTrash.moveToTrash',

            async (
                clickedUri,
                selectedUris
            ) => {

                let uris = [];

                /*
                 * Explorer multi-selection.
                 */
                if (
                    Array.isArray(selectedUris) &&
                    selectedUris.length > 0
                ) {
                    uris = selectedUris;
                }
                else if (clickedUri) {
                    uris = [clickedUri];
                }

                /*
                 * Keybindings do not pass Explorer URI arguments.
                 */
                if (uris.length === 0) {
                    try {
                        uris =
                            await getExplorerSelectionFromKeybinding();
                    }
                    catch (err) {
                        vscode.window.showErrorMessage(
                            `Safe Trash could not read the Explorer selection: ` +
                            `${String(err)}`
                        );
                        return;
                    }
                }

                if (uris.length === 0) {
                    vscode.window.showWarningMessage(
                        'Safe Trash: no Explorer file selected.'
                    );
                    return;
                }

                /*
                 * Validate EVERYTHING first.
                 *
                 * Important:
                 *
                 * If 10 files are selected and one is unsafe,
                 * we move NONE of them.
                 */
                const validation =
                    await validateAll(uris);

                if (validation.errors.length > 0) {

                    const details =
                        validation.errors
                            .map(
                                item =>
                                    `${item.uri.fsPath}\n` +
                                    `${item.error}`
                            )
                            .join('\n\n');

                    vscode.window.showErrorMessage(
                        `Safe Trash refused the entire operation.\n\n` +
                        details
                    );

                    return;
                }

                const names =
                    uris
                        .map(
                            uri =>
                                path.basename(uri.fsPath)
                        )
                        .join('\n');

                const answer =
                    await vscode.window.showWarningMessage(
                        `Move ${uris.length} item(s) to the configured ` +
                        `workspace trash directory?\n\n` +
                        `${names}`,
                        {
                            modal: true
                        },
                        'Move to Trash'
                    );

                if (answer !== 'Move to Trash') {
                    return;
                }

                /*
                 * Revalidate immediately before moving.
                 *
                 * This reduces the TOCTOU window if a symlink
                 * was changed between confirmation and action.
                 */
                const finalValidation =
                    await validateAll(uris);

                if (finalValidation.errors.length > 0) {

                    const details =
                        finalValidation.errors
                            .map(
                                item =>
                                    `${item.uri.fsPath}\n` +
                                    `${item.error}`
                            )
                            .join('\n\n');

                    vscode.window.showErrorMessage(
                        `Safe Trash safety check changed before execution. ` +
                        `Nothing was moved.\n\n${details}`
                    );

                    return;
                }

                const failures = [];
                let success = 0;

                for (const uri of uris) {

                    try {

                        const result =
                            await moveOneToTrash(uri);

                        success++;

                        console.log(
                            `[Safe Trash]\n` +
                            `source: ${result.source}\n` +
                            `real:   ${result.realSource}\n` +
                            `trash:  ${result.destination}`
                        );
                    }
                    catch (err) {

                        failures.push({
                            source: uri.fsPath,
                            error: String(err)
                        });
                    }
                }

                if (failures.length === 0) {

                    vscode.window.showInformationMessage(
                        `Safe Trash: moved ${success} item(s).`
                    );

                    return;
                }

                const details =
                    failures
                        .map(
                            item =>
                                `${item.source}\n${item.error}`
                        )
                        .join('\n\n');

                vscode.window.showErrorMessage(
                    `Safe Trash: ${success} moved, ` +
                    `${failures.length} failed.\n\n` +
                    details
                );
            }
        );

    context.subscriptions.push(
        disposable
    );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
