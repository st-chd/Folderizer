export const FOLDY_VERSION = 1;

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
        version: FOLDY_VERSION,
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

export function orderItemsByLayout(layout, items, getId = item => item?.id) {
    const byId = new Map(items
        .map(item => [String(getId(item) ?? ''), item])
        .filter(([id]) => id));
    const used = new Set();
    const ordered = [];

    for (const id of flattenLayout(layout)) {
        const item = byId.get(String(id));
        if (!item || used.has(String(id))) continue;
        ordered.push(item);
        used.add(String(id));
    }

    for (const item of items) {
        const id = String(getId(item) ?? '');
        if (!id || used.has(id)) continue;
        ordered.push(item);
        used.add(id);
    }

    return ordered;
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
    root.forEach((node, rootIndex) => {
        if (node.type === 'item') {
            ownerIndices.set(node.id, rootIndex);
            return;
        }
        for (const itemId of folderMap.get(node.id)?.items ?? []) {
            ownerIndices.set(itemId, rootIndex);
        }
    });

    const previousOwners = [];
    let previousOwner = -1;
    for (let index = 0; index < validIds.length; index++) {
        previousOwners[index] = previousOwner;
        const ownerIndex = ownerIndices.get(validIds[index]);
        if (ownerIndex !== undefined) previousOwner = ownerIndex;
    }

    const nextOwners = [];
    let nextOwner = -1;
    for (let index = validIds.length - 1; index >= 0; index--) {
        nextOwners[index] = nextOwner;
        const ownerIndex = ownerIndices.get(validIds[index]);
        if (ownerIndex !== undefined) nextOwner = ownerIndex;
    }

    const insertions = new Map();
    for (let index = 0; index < validIds.length; index++) {
        const itemId = validIds[index];
        if (placedItems.has(itemId)) continue;

        const insertionIndex = previousOwners[index] !== -1
            ? previousOwners[index] + 1
            : nextOwners[index] !== -1
                ? nextOwners[index]
                : root.length;
        if (!insertions.has(insertionIndex)) insertions.set(insertionIndex, []);
        insertions.get(insertionIndex).push({ type: 'item', id: itemId });
        placedItems.add(itemId);
    }

    [...insertions.entries()]
        .sort(([left], [right]) => right - left)
        .forEach(([index, nodes]) => root.splice(index, 0, ...nodes));

    return { version: FOLDY_VERSION, root, folders };
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
