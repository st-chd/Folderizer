export const FOLDERIZER_VERSION = 1;

export function generateUUID() {
    if (typeof globalThis.crypto?.randomUUID === 'function') {
        return globalThis.crypto.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => {
        const random = Math.floor(Math.random() * 16);
        return (value === 'x' ? random : (random & 0x3) | 0x8).toString(16);
    });
}

export function createEmptyLayout(itemIds = []) {
    return {
        version: FOLDERIZER_VERSION,
        root: itemIds.map(id => ({ type: 'item', id: String(id) })),
        folders: [],
    };
}

export function flattenLayout(layout) {
    const folders = new Map(layout.folders.map(folder => [folder.id, folder]));
    return layout.root.flatMap(node => {
        if (node.type === 'item') return [node.id];
        return folders.get(node.id)?.items ?? [];
    });
}

function uniqueFolderName(name, usedNames) {
    const base = String(name || 'Folder').trim() || 'Folder';
    let candidate = base;
    let suffix = 2;
    while (usedNames.has(candidate.toLocaleLowerCase())) {
        candidate = `${base} (${suffix++})`;
    }
    usedNames.add(candidate.toLocaleLowerCase());
    return candidate;
}

export function normalizeLayout(rawLayout, itemIds = [], { preserveUnrootedFolders = true } = {}) {
    const validIds = itemIds.map(String);
    const validSet = new Set(validIds);
    const source = rawLayout && typeof rawLayout === 'object' ? rawLayout : {};
    const sourceFolders = Array.isArray(source.folders) ? source.folders : [];
    const usedFolderIds = new Set();
    const usedFolderNames = new Set();
    const placedItems = new Set();
    let folders = [];

    for (const candidate of sourceFolders) {
        if (!candidate || typeof candidate !== 'object') continue;
        let id = String(candidate.id || generateUUID());
        while (usedFolderIds.has(id)) id = generateUUID();
        usedFolderIds.add(id);

        const items = [];
        for (const value of Array.isArray(candidate.items) ? candidate.items : []) {
            const itemId = String(value);
            if (!validSet.has(itemId) || placedItems.has(itemId)) continue;
            placedItems.add(itemId);
            items.push(itemId);
        }

        folders.push({
            id,
            name: uniqueFolderName(candidate.name, usedFolderNames),
            color: typeof candidate.color === 'string' ? candidate.color : '',
            borderColor: typeof candidate.borderColor === 'string' ? candidate.borderColor : '',
            nameColor: typeof candidate.nameColor === 'string' ? candidate.nameColor : '',
            items,
        });
    }

    const folderMap = new Map(folders.map(folder => [folder.id, folder]));
    const root = [];
    const placedFolders = new Set();
    for (const candidate of Array.isArray(source.root) ? source.root : []) {
        if (!candidate || typeof candidate !== 'object') continue;
        const id = String(candidate.id ?? '');
        if (candidate.type === 'folder' && folderMap.has(id) && !placedFolders.has(id)) {
            root.push({ type: 'folder', id });
            placedFolders.add(id);
        } else if (candidate.type === 'item' && validSet.has(id) && !placedItems.has(id)) {
            root.push({ type: 'item', id });
            placedItems.add(id);
        }
    }

    if (preserveUnrootedFolders) {
        for (const folder of folders) {
            if (!placedFolders.has(folder.id)) root.push({ type: 'folder', id: folder.id });
        }
    } else {
        folders = folders.filter(folder => placedFolders.has(folder.id));
    }

    const ownerIndices = new Map();
    const rebuildOwnerIndices = (startIndex = 0) => {
        for (let rootIndex = startIndex; rootIndex < root.length; rootIndex++) {
            const node = root[rootIndex];
            if (node.type === 'item') {
                ownerIndices.set(node.id, rootIndex);
                continue;
            }
            for (const itemId of folderMap.get(node.id)?.items ?? []) {
                ownerIndices.set(itemId, rootIndex);
            }
        }
    };
    rebuildOwnerIndices();

    for (let index = 0; index < validIds.length; index++) {
        const itemId = validIds[index];
        if (placedItems.has(itemId)) continue;

        let insertionIndex = root.length;
        for (let previous = index - 1; previous >= 0; previous--) {
            const previousOwner = ownerIndices.get(validIds[previous]) ?? -1;
            if (previousOwner !== -1) {
                insertionIndex = previousOwner + 1;
                break;
            }
        }
        if (insertionIndex === root.length) {
            for (let next = index + 1; next < validIds.length; next++) {
                const nextOwner = ownerIndices.get(validIds[next]) ?? -1;
                if (nextOwner !== -1) {
                    insertionIndex = nextOwner;
                    break;
                }
            }
        }
        root.splice(insertionIndex, 0, { type: 'item', id: itemId });
        placedItems.add(itemId);
        rebuildOwnerIndices(insertionIndex);
    }

    return { version: FOLDERIZER_VERSION, root, folders };
}

export function removeFolder(layout, folderId) {
    const folder = layout.folders.find(value => value.id === folderId);
    const rootIndex = layout.root.findIndex(node => node.type === 'folder' && node.id === folderId);
    if (!folder || rootIndex === -1) return layout;

    layout.root.splice(rootIndex, 1, ...folder.items.map(id => ({ type: 'item', id })));
    layout.folders = layout.folders.filter(value => value.id !== folderId);
    return layout;
}

export function hasDuplicateFolderName(layout, name, exceptId = null) {
    const normalized = String(name).trim().toLocaleLowerCase();
    return layout.folders.some(folder => folder.id !== exceptId && folder.name.trim().toLocaleLowerCase() === normalized);
}
