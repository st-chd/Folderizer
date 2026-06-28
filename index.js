import { characters, eventSource, event_types, getCurrentChatId, reloadCurrentChat, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';
import { renderTemplateAsync } from '../../../templates.js';
import { getSortableDelay, initScrollHeight, waitUntilCondition } from '../../../utils.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import {
    getWorldEntry,
    loadWorldInfo,
    saveWorldInfo,
    setWIOriginalDataValue,
    SORT_ORDER_KEY,
    world_names,
} from '../../../world-info.js';
import {
    getScriptsByType,
    saveScriptsByType,
    SCRIPT_TYPES,
} from '../../regex/engine.js';
import {
    flattenLayout,
    hasDuplicateFolderName,
    normalizeLayout,
    removeFolder,
} from './model.js';

const EXTENSION_NAME = 'Folderizer';
const LORE_SORT_VALUE = 'folderizer';
const DEFAULT_PICKER_COLOR = '#7c6ee6';

const REGEX_TYPES = {
    global: {
        scriptType: SCRIPT_TYPES.GLOBAL,
        selector: '#saved_regex_scripts',
        label: 'Global',
    },
    scoped: {
        scriptType: SCRIPT_TYPES.SCOPED,
        selector: '#saved_scoped_scripts',
        label: 'Scoped',
    },
    preset: {
        scriptType: SCRIPT_TYPES.PRESET,
        selector: '#saved_preset_scripts',
        label: 'Preset',
    },
};

let currentPromptLayout = null;
let renderingLorebook = false;
let loreRenderQueued = false;
let loreRenderRequestedAfterRender = false;
let loreObserver = null;
let regexObserver = null;
let enhancingRegex = false;
let sortingPrompt = false;
let sortingLore = false;
let sortingRegex = false;
let originalPromptRenderItems = null;
let originalPromptMakeDraggable = null;

function settings() {
    extension_settings.folderizer ??= {};
    const value = extension_settings.folderizer;
    value.features ??= { prompts: true, lorebooks: true, regex: true };
    value.features.prompts ??= true;
    value.features.lorebooks ??= true;
    value.features.regex ??= true;
    value.layouts ??= {};
    value.layouts.prompts ??= {};
    value.layouts.lorebooks ??= {};
    value.layouts.regex ??= {};
    value.layouts.regex.global ??= {};
    value.layouts.regex.scoped ??= {};
    value.layouts.regex.preset ??= {};
    value.collapsed ??= {};
    value.collapsed.prompt ??= {};
    value.collapsed.lore ??= {};
    value.collapsed.regex ??= {};
    return value;
}

function featureEnabled(name) {
    return settings().features[name] !== false;
}

function ownerCollapsed(kind, owner) {
    const bucket = settings().collapsed[kind];
    bucket[owner] ??= [];
    return new Set(bucket[owner]);
}

function saveCollapsed(kind, owner, values) {
    settings().collapsed[kind][owner] = [...values];
    saveSettingsDebounced();
}

function promptPresetManager() {
    return getPresetManager('openai');
}

function promptOwnerKey() {
    const manager = promptPresetManager();
    return `${manager?.apiId || 'openai'}:${manager?.getSelectedPresetName() || ''}`;
}

function selectedLorebookName() {
    const value = String($('#world_editor_select').find(':selected').val() ?? '');
    return world_names?.[value] || String($('#world_editor_select').find(':selected').text() ?? '').trim();
}

function regexOwnerKey(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') {
        const avatar = characters?.[this_chid]?.avatar;
        return avatar ? `scoped:${avatar}` : 'scoped:none';
    }
    const manager = getPresetManager();
    return `preset:${manager?.apiId || 'unknown'}:${manager?.getSelectedPresetName() || ''}`;
}

function createIconButton(icon, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid ${icon} ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
}

function createLabeledIconButton(icon, title, label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button folderizer-labeled-button ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    const iconElement = document.createElement('span');
    iconElement.className = `fa-solid ${icon}`;
    const labelElement = document.createElement('span');
    labelElement.textContent = label;
    button.append(iconElement, labelElement);
    return button;
}

function isHexColor(value) {
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(value ?? '').trim());
}

function normalizeColor(value, fallback = '') {
    const color = String(value ?? '').trim();
    if (!isHexColor(color)) return fallback;
    if (color.length === 4) {
        return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`.toLowerCase();
    }
    return color.toLowerCase();
}

function cssColorToHex(value, fallback = DEFAULT_PICKER_COLOR) {
    const probe = document.createElement('span');
    probe.style.color = value;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return fallback;
    return `#${[match[1], match[2], match[3]].map(part => Number(part).toString(16).padStart(2, '0')).join('')}`;
}

function themeColorHex(variableName, fallback = DEFAULT_PICKER_COLOR) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
    return cssColorToHex(value || fallback, fallback);
}

function createColorSetting(labelText, initialValue, pickerFallback = DEFAULT_PICKER_COLOR) {
    const field = document.createElement('label');
    field.className = 'folderizer-color-field';

    const label = document.createElement('span');
    label.textContent = labelText;

    const controls = document.createElement('span');
    controls.className = 'folderizer-color-controls';

    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = normalizeColor(initialValue, pickerFallback);

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.value = normalizeColor(initialValue);
    hex.placeholder = 'default, #fff';
    hex.spellcheck = false;

    picker.addEventListener('input', () => {
        hex.value = picker.value;
    });
    hex.addEventListener('input', () => {
        const value = normalizeColor(hex.value);
        if (value) picker.value = value;
    });

    controls.append(picker, hex);
    field.append(label, controls);

    return {
        field,
        value: () => normalizeColor(hex.value),
        isValid: () => !hex.value.trim() || isHexColor(hex.value),
    };
}

function updateFolderCount(folderElement) {
    const count = folderElement.querySelector('.folderizer-folder-items')?.children.length ?? 0;
    const countElement = folderElement.querySelector('.folderizer-folder-count');
    if (countElement) countElement.textContent = String(count);
}

function enabledState(values) {
    if (!values.length) return 'off';
    const enabledCount = values.filter(Boolean).length;
    if (enabledCount === 0) return 'off';
    if (enabledCount === values.length) return 'on';
    return 'mixed';
}

function setStateButtonIcon(button, state) {
    button.classList.toggle('fa-toggle-on', state === 'on');
    button.classList.toggle('fa-toggle-off', state === 'off');
    button.classList.toggle('fa-circle-half-stroke', state === 'mixed');
    button.dataset.state = state;
    button.title = state === 'on' ? 'Disable all items in this folder' : 'Enable all items in this folder';
}

function createFolderElement(folder, { kind, owner, collapsed, onEdit, onDelete, onStateToggle, state = null }) {
    const element = document.createElement(kind === 'regex' ? 'div' : 'li');
    element.className = `folderizer-folder folderizer-${kind}-folder`;
    element.dataset.folderizerId = folder.id;
    const backgroundColor = normalizeColor(folder.color);
    const borderColor = normalizeColor(folder.borderColor);
    if (backgroundColor) element.style.setProperty('--folderizer-background-color', backgroundColor);
    if (borderColor) element.style.setProperty('--folderizer-border-color', borderColor);
    element.style.setProperty('--folderizer-name-color', normalizeColor(folder.nameColor, 'inherit'));

    const header = document.createElement('div');
    header.className = 'folderizer-folder-header';

    const drag = document.createElement('span');
    drag.className = 'folderizer-drag drag-handle fa-solid fa-bars';
    drag.title = 'Move folder';

    const name = document.createElement('span');
    name.className = 'folderizer-folder-name';
    name.textContent = folder.name;
    name.title = folder.name;

    const count = document.createElement('span');
    count.className = 'folderizer-folder-count';
    count.textContent = String(folder.items.length);

    const edit = createIconButton('fa-pencil', 'Edit folder');
    edit.addEventListener('click', () => onEdit(folder.id));

    const remove = createIconButton('fa-trash', 'Delete folder', 'caution');
    remove.addEventListener('click', () => onDelete(folder.id));

    const collapse = createIconButton('fa-chevron-down', 'Collapse folder');
    collapse.classList.add('folderizer-collapse-toggle');
    const items = document.createElement(kind === 'regex' ? 'div' : 'ul');
    items.className = `folderizer-folder-items folderizer-${kind}-items`;

    if (collapsed.has(folder.id)) {
        element.classList.add('is-collapsed');
        collapse.classList.replace('fa-chevron-down', 'fa-chevron-right');
    }

    collapse.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        const isCollapsed = element.classList.toggle('is-collapsed');
        collapse.classList.toggle('fa-chevron-down', !isCollapsed);
        collapse.classList.toggle('fa-chevron-right', isCollapsed);
        const values = ownerCollapsed(kind, owner);
        isCollapsed ? values.add(folder.id) : values.delete(folder.id);
        saveCollapsed(kind, owner, values);
    });

    header.append(drag, collapse);
    if (onStateToggle) {
        header.classList.add('has-state-toggle');
        const stateButton = createIconButton('fa-toggle-off', 'Toggle folder items', 'folderizer-state-toggle');
        setStateButtonIcon(stateButton, state);
        stateButton.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            stateButton.disabled = true;
            try {
                await onStateToggle(folder.id, stateButton.dataset.state);
            } finally {
                stateButton.disabled = false;
            }
        });
        header.append(stateButton);
    }
    header.append(name, count, edit, remove);
    element.append(header, items);
    return element;
}

async function requestFolderName(layout, currentName = '', currentId = null) {
    const value = await Popup.show.input(currentId ? 'Rename folder' : 'New folder', 'Folder name', currentName);
    const name = String(value ?? '').trim();
    if (!name) return null;
    if (hasDuplicateFolderName(layout, name, currentId)) {
        toastr.warning('A folder with that name already exists.');
        return null;
    }
    return name;
}

async function requestFolderSettings(layout, folder) {
    const form = document.createElement('div');
    form.className = 'folderizer-edit-form';

    const title = document.createElement('div');
    title.className = 'folderizer-edit-title';
    title.textContent = 'Folder settings';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = folder.name;
    nameInput.placeholder = 'Folder name';
    nameInput.autofocus = true;

    const nameField = document.createElement('label');
    nameField.className = 'folderizer-text-field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = 'Name';
    nameField.append(nameLabel, nameInput);

    const backgroundColor = createColorSetting('Background', folder.color, themeColorHex('--SmartThemeBlurTintColor'));
    const borderColor = createColorSetting('Border', folder.borderColor, themeColorHex('--SmartThemeBorderColor'));
    const nameColor = createColorSetting('Name color', folder.nameColor, themeColorHex('--SmartThemeBodyColor', '#ffffff'));

    form.append(title, nameField, backgroundColor.field, borderColor.field, nameColor.field);

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        onClosing: value => {
            if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('Folder name cannot be empty.');
                return false;
            }
            if (hasDuplicateFolderName(layout, name, folder.id)) {
                toastr.warning('A folder with that name already exists.');
                return false;
            }
            if (![backgroundColor, borderColor, nameColor].every(setting => setting.isValid())) {
                toastr.warning('Use HEX colors like #fff or #ffffff, or leave the field empty for the UI default.');
                return false;
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;

    const name = nameInput.value.trim();
    return {
        name,
        color: backgroundColor.value(),
        borderColor: borderColor.value(),
        nameColor: nameColor.value(),
    };
}

async function requestMoveTarget(layout, itemId) {
    if (!layout.folders.length) {
        toastr.info('Create a folder first.');
        return null;
    }

    const currentFolder = layout.folders.find(folder => folder.items.includes(String(itemId)));
    const currentValue = currentFolder?.id ?? '';
    const form = document.createElement('div');
    form.className = 'folderizer-move-form';

    const title = document.createElement('div');
    title.className = 'folderizer-edit-title';
    title.textContent = 'Move to folder';

    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = 'Destination';
    const select = document.createElement('select');
    select.className = 'text_pole';

    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = 'Root (no folder)';
    select.append(rootOption);
    for (const folder of layout.folders) {
        const option = document.createElement('option');
        option.value = folder.id;
        option.textContent = folder.name;
        select.append(option);
    }
    select.value = currentValue;
    label.append(text, select);
    form.append(title, label);

    const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Move',
        cancelButton: 'Cancel',
    }).show();

    return result === POPUP_RESULT.AFFIRMATIVE ? select.value : null;
}

function moveItemToFolder(layout, itemId, folderId) {
    const id = String(itemId);
    const currentRootIndex = layout.root.findIndex(node => node.type === 'item' && node.id === id);
    const currentFolder = layout.folders.find(folder => folder.items.includes(id));
    const currentFolderId = currentFolder?.id ?? '';
    const targetFolderId = String(folderId ?? '');
    if (currentRootIndex !== -1 && !targetFolderId) return false;
    if (currentFolderId === targetFolderId) return false;

    layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === id));
    for (const folder of layout.folders) {
        folder.items = folder.items.filter(value => value !== id);
    }

    if (!targetFolderId) {
        layout.root.unshift({ type: 'item', id });
        return true;
    }

    const folder = layout.folders.find(value => value.id === targetFolderId);
    if (!folder) return false;
    folder.items.push(id);
    return true;
}

function attachMoveToFolderButton(element, { kind, layout, itemId, onMove }) {
    if (!element || element.querySelector(':scope .folderizer-move-to-folder') || !layout.folders.length) return;
    const button = kind === 'prompt'
        ? document.createElement('span')
        : createIconButton('fa-folder-open', 'Move to folder', 'folderizer-move-to-folder');
    if (kind === 'prompt') {
        button.className = 'fa-solid fa-folder-open folderizer-move-to-folder';
        button.title = 'Move to folder';
        button.setAttribute('aria-label', 'Move to folder');
    }
    button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const target = await requestMoveTarget(layout, itemId);
        if (target === null) return;
        if (!moveItemToFolder(layout, itemId, target)) return;
        await onMove();
    });

    if (kind === 'prompt') {
        element.querySelector('.prompt_manager_prompt_controls')?.prepend(button);
        return;
    }

    if (kind === 'lore') {
        const host = element.querySelector('.world_entry_thin_controls');
        const before = host?.querySelector('.flex-container.alignitemscenter.wide100p');
        if (host) {
            before ? host.insertBefore(button, before) : host.append(button);
        }
        return;
    }

    if (kind === 'regex') {
        element.querySelector('.regex_script_buttons')?.prepend(button);
    }
}

function ensureToolbar(parent, key, onCreate, extra = []) {
    if (!parent) return;
    parent.querySelector(`.folderizer-toolbar[data-folderizer-toolbar="${key}"]`)?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'folderizer-toolbar';
    toolbar.dataset.folderizerToolbar = key;
    const create = createLabeledIconButton('fa-folder-plus', 'New folder', 'New Folder', 'folderizer-create-folder');
    create.addEventListener('click', onCreate);
    toolbar.append(create, ...extra);
    parent.prepend(toolbar);
}

function promptOrderIds(manager = promptManager) {
    return manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => String(entry.identifier));
}

function readPromptLayout(manager = promptManager) {
    const owner = promptOwnerKey();
    const raw = settings().layouts.prompts[owner];
    return { owner, layout: normalizeLayout(raw, promptOrderIds(manager)) };
}

async function persistPromptLayout(owner, layout, manager = promptManager) {
    const order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    const byId = new Map(order.map(entry => [String(entry.identifier), entry]));
    const flattened = flattenLayout(layout);
    order.splice(0, order.length, ...flattened.map(identifier => byId.get(identifier)).filter(Boolean));
    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    await manager.saveServiceSettings();
}

function promptLayoutFromDom(list, sourceLayout) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];

    for (const element of list.children) {
        if (element.classList.contains('folderizer-folder')) {
            const id = element.dataset.folderizerId;
            const source = folderSource.get(id);
            if (!source) continue;
            const items = [...element.querySelector('.folderizer-folder-items').children]
                .map(item => item.dataset.pmIdentifier)
                .filter(Boolean);
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
        } else if (element.dataset.pmIdentifier) {
            root.push({ type: 'item', id: element.dataset.pmIdentifier });
        }
    }

    return normalizeLayout({ version: 1, root, folders }, promptOrderIds());
}

function setupPromptSortables(manager) {
    const list = manager.listElement;
    if (!list?.classList.contains('folderizer-prompt-root')) return;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.folderizer-prompt-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        saving = true;
        try {
            list.querySelectorAll('.folderizer-folder').forEach(updateFolderCount);
            const next = promptLayoutFromDom(list, currentPromptLayout);
            await persistPromptLayout(promptOwnerKey(), next, manager);
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save prompt folder order`, error);
            toastr.error('Failed to save prompt folder order.');
            manager.render(false);
        } finally {
            saving = false;
        }
    };

    let lastPointer = null;
    let lastFolderElement = null;
    const rememberPointer = event => {
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-prompt-folder'))
            .find(Boolean);
        if (pointedFolder) lastFolderElement = pointedFolder;
        list.classList.toggle('folderizer-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
        pointedFolder?.classList.add('folderizer-drop-target');
    };
    const movePromptIntoPointedFolder = item => {
        if (!item?.classList?.contains('completion_prompt_manager_prompt_draggable') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-prompt-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.folderizer-prompt-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> .completion_prompt_manager_prompt_draggable, > .folderizer-folder',
        connectWith: '.folderizer-prompt-items',
        placeholder: 'folderizer-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: () => {
            sortingPrompt = true;
        },
        sort: rememberPointer,
        stop: (_, ui) => {
            setTimeout(async () => {
                try {
                    movePromptIntoPointedFolder(ui.item?.[0]);
                    await saveFromDom();
                } finally {
                    sortingPrompt = false;
                    lastPointer = null;
                    lastFolderElement = null;
                    list.classList.remove('folderizer-dropping-into-folder');
                    list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
                }
            }, 0);
        },
    });
    list.querySelectorAll('.folderizer-prompt-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> .completion_prompt_manager_prompt_draggable',
            connectWith: '#completion_prompt_manager_list, .folderizer-prompt-items',
            placeholder: 'folderizer-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: () => {
                sortingPrompt = true;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('folderizer-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => {
                setTimeout(async () => {
                    try {
                        movePromptIntoPointedFolder(ui.item?.[0]);
                        await saveFromDom();
                    } finally {
                        sortingPrompt = false;
                        lastPointer = null;
                        lastFolderElement = null;
                        list.classList.remove('folderizer-dropping-into-folder');
                        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
                    }
                }, 0);
            },
        });
    });
}

async function enhancePromptList(manager) {
    const list = manager.listElement;
    if (!list || !featureEnabled('prompts')) return;
    const { owner, layout } = readPromptLayout(manager);
    currentPromptLayout = layout;
    list.classList.add('folderizer-prompt-root');

    const itemMap = new Map([...list.querySelectorAll('[data-pm-identifier]')].map(element => [element.dataset.pmIdentifier, element]));
    itemMap.forEach(element => element.remove());
    const collapsed = ownerCollapsed('prompt', owner);
    const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

    const rerender = () => manager.render(false);
    const onEdit = async id => {
        const folder = currentPromptLayout.folders.find(value => value.id === id);
        if (!folder) return;
        const values = await requestFolderSettings(currentPromptLayout, folder);
        if (!values) return;
        Object.assign(folder, values);
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    };
    const onDelete = async id => {
        const folder = currentPromptLayout.folders.find(value => value.id === id);
        if (!folder || !await Popup.show.confirm('Delete folder', `Delete "${folder.name}" and keep its prompts at the root?`)) return;
        removeFolder(currentPromptLayout, id);
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    };

    for (const node of layout.root) {
        if (node.type === 'item') {
            const item = itemMap.get(node.id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'prompt',
                    layout: currentPromptLayout,
                    itemId: node.id,
                    onMove: async () => {
                        await persistPromptLayout(owner, currentPromptLayout, manager);
                        rerender();
                    },
                });
                list.append(item);
            }
            continue;
        }
        const folder = folderMap.get(node.id);
        if (!folder) continue;
        const folderElement = createFolderElement(folder, {
            kind: 'prompt', owner, collapsed, onEdit, onDelete,
        });
        const items = folderElement.querySelector('.folderizer-folder-items');
        folder.items.forEach(id => {
            const item = itemMap.get(id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'prompt',
                    layout: currentPromptLayout,
                    itemId: id,
                    onMove: async () => {
                        await persistPromptLayout(owner, currentPromptLayout, manager);
                        rerender();
                    },
                });
                items.append(item);
            }
        });
        updateFolderCount(folderElement);
        list.append(folderElement);
    }

    ensureToolbar(list.closest('.range-block'), 'prompt', async () => {
        const name = await requestFolderName(currentPromptLayout);
        if (!name) return;
        const folder = { id: crypto.randomUUID(), name, color: '', items: [] };
        currentPromptLayout.folders.push(folder);
        currentPromptLayout.root.unshift({ type: 'folder', id: folder.id });
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    });
}

async function installPromptIntegration() {
    await waitUntilCondition(() => promptManager && promptPresetManager(), 30000, 100);
    const manager = promptManager;
    if (!originalPromptRenderItems) originalPromptRenderItems = manager.renderPromptManagerListItems.bind(manager);
    if (!originalPromptMakeDraggable) originalPromptMakeDraggable = manager.makeDraggable.bind(manager);
    if (manager.__folderizerInstalled) return;
    manager.__folderizerInstalled = true;

    manager.renderPromptManagerListItems = async function () {
        await originalPromptRenderItems();
        if (featureEnabled('prompts')) await enhancePromptList(manager);
    };
    manager.makeDraggable = function () {
        if (featureEnabled('prompts')) setupPromptSortables(manager);
        else originalPromptMakeDraggable();
    };
    manager.render(false);
}

function loreLayoutFromDom(list, sourceLayout, allIds) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    for (const element of list.children) {
        if (element.classList.contains('folderizer-folder')) {
            const id = element.dataset.folderizerId;
            const source = folderSource.get(id);
            if (!source) continue;
            const renderedItems = [...element.querySelector('.folderizer-folder-items').children]
                .map(item => item.getAttribute('uid'))
                .filter(Boolean);
            const items = element.classList.contains('is-collapsed') ? [...source.items] : renderedItems;
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
        } else if (element.hasAttribute('uid')) {
            root.push({ type: 'item', id: element.getAttribute('uid') });
        }
    }
    return normalizeLayout({ version: 1, root, folders }, allIds);
}

function matchesLoreQuery(entry, query) {
    if (!query) return true;
    const haystack = [
        entry.comment,
        entry.content,
        ...(Array.isArray(entry.key) ? entry.key : []),
        ...(Array.isArray(entry.keysecondary) ? entry.keysecondary : []),
    ].filter(Boolean).join('\n').toLocaleLowerCase();
    return query.toLocaleLowerCase().split(/\s+/).every(term => haystack.includes(term));
}

async function persistLoreLayout(owner, layout) {
    settings().layouts.lorebooks[owner] = layout;
    saveSettingsDebounced();
}

async function createLorebookFolder() {
    if (!featureEnabled('lorebooks')) return;
    const name = selectedLorebookName();
    if (!name) {
        toastr.warning('Select a lorebook first.');
        return;
    }

    const data = await loadWorldInfo(name);
    if (!data?.entries) return;
    const allIds = Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
    const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
    const folderName = await requestFolderName(layout);
    if (!folderName) return;

    const folder = { id: crypto.randomUUID(), name: folderName, color: '', items: [] };
    layout.folders.push(folder);
    layout.root.unshift({ type: 'folder', id: folder.id });
    await persistLoreLayout(name, layout);

    const sort = document.getElementById('world_info_sort_order');
    if (sort && sort.value !== LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
    }
    queueLoreRender();
}

async function setLoreFolderEnabled(name, data, layout, folderId, enabled) {
    const folder = layout.folders.find(value => value.id === folderId);
    if (!folder) return;
    for (const id of folder.items) {
        const entry = data.entries[id];
        if (!entry) continue;
        entry.disable = !enabled;
        setWIOriginalDataValue(data, entry.uid, 'enabled', enabled);
    }
    await saveWorldInfo(name, data, true);
    queueLoreRender();
}

function setupLoreSortables(name, data, layout) {
    const list = document.getElementById('world_popup_entries_list');
    if (!list) return;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.folderizer-lore-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    const allIds = Object.keys(data.entries);
    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        saving = true;
        try {
            list.querySelectorAll('.folderizer-folder').forEach(updateFolderCount);
            const next = loreLayoutFromDom(list, layout, allIds);
            Object.assign(layout, next);
            await persistLoreLayout(name, layout);
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save lorebook folder order`, error);
            toastr.error('Failed to save lorebook folder order.');
            queueLoreRender();
        } finally {
            saving = false;
        }
    };
    const moveItemInLayout = async (itemId, folderId) => {
        const folder = layout.folders.find(value => value.id === folderId);
        if (!folder) return;
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === itemId));
        for (const value of layout.folders) {
            value.items = value.items.filter(id => id !== itemId);
        }
        folder.items.push(itemId);
        await persistLoreLayout(name, layout);
    };

    let lastPointer = null;
    let lastFolderElement = null;
    const rememberPointer = event => {
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-lore-folder'))
            .find(Boolean);
        if (pointedFolder) lastFolderElement = pointedFolder;
        list.classList.toggle('folderizer-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
        pointedFolder?.classList.add('folderizer-drop-target');
    };
    const moveLoreIntoPointedFolder = item => {
        if (!item?.hasAttribute?.('uid') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.folderizer-lore-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.folderizer-lore-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
        return folderElement.dataset.folderizerId;
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> [uid], > .folderizer-folder',
        connectWith: '.folderizer-lore-items',
        placeholder: 'folderizer-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: () => {
            sortingLore = true;
        },
        sort: rememberPointer,
        stop: (_, ui) => {
            setTimeout(async () => {
                try {
                    const item = ui.item?.[0];
                    const folderId = moveLoreIntoPointedFolder(item);
                    if (folderId) await moveItemInLayout(String(item.getAttribute('uid')), folderId);
                    else await saveFromDom();
                } finally {
                    sortingLore = false;
                    lastPointer = null;
                    lastFolderElement = null;
                    list.classList.remove('folderizer-dropping-into-folder');
                    list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
                }
            }, 0);
        },
    });
    list.querySelectorAll('.folderizer-lore-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> [uid]',
            connectWith: '#world_popup_entries_list, .folderizer-lore-items',
            placeholder: 'folderizer-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: () => {
                sortingLore = true;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('folderizer-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => {
                setTimeout(async () => {
                    try {
                        const item = ui.item?.[0];
                        const folderId = moveLoreIntoPointedFolder(item);
                        if (folderId) await moveItemInLayout(String(item.getAttribute('uid')), folderId);
                        else await saveFromDom();
                    } finally {
                        sortingLore = false;
                        lastPointer = null;
                        lastFolderElement = null;
                        list.classList.remove('folderizer-dropping-into-folder');
                        list.querySelectorAll('.folderizer-drop-target').forEach(element => element.classList.remove('folderizer-drop-target'));
                    }
                }, 0);
            },
        });
    });
}

async function renderLorebookFolders() {
    if (renderingLorebook) {
        loreRenderRequestedAfterRender = true;
        return;
    }
    if (!featureEnabled('lorebooks') || $('#world_info_sort_order').val() !== LORE_SORT_VALUE) return;
    const name = selectedLorebookName();
    if (!name) return;
    renderingLorebook = true;
    try {
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;
        const list = document.getElementById('world_popup_entries_list');
        if (!list) return;
        const allEntries = Object.values(data.entries).filter(entry => entry && typeof entry === 'object');
        const allIds = allEntries.map(entry => String(entry.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        await persistLoreLayout(name, layout);
        const query = String($('#world_info_search').val() ?? '').trim();
        const visibleEntries = query ? allEntries.filter(entry => matchesLoreQuery(entry, query)) : allEntries;
        const visibleIds = new Set(visibleEntries.map(entry => String(entry.uid)));
        const entryMap = new Map(allEntries.map(entry => [String(entry.uid), entry]));
        const collapsed = ownerCollapsed('lore', name);
        const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));

        loreObserver?.disconnect();
        list.innerHTML = '';
        list.classList.add('folderizer-lore-root');
        list.classList.toggle('folderizer-searching', Boolean(query));
        $('#world_info_pagination').html('<span class="folderizer-pagination-note">Folder order shows all entries</span>');
        const headers = await renderTemplateAsync('worldInfoKeywordHeaders');
        list.insertAdjacentHTML('beforeend', headers);

        const rerender = () => queueLoreRender();
        const onEdit = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder) return;
            const values = await requestFolderSettings(layout, folder);
            if (!values) return;
            Object.assign(folder, values);
            await persistLoreLayout(name, layout);
            rerender();
        };
        const onDelete = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder || !await Popup.show.confirm('Delete folder', `Delete "${folder.name}" and keep its entries at the root?`)) return;
            removeFolder(layout, id);
            await persistLoreLayout(name, layout);
            rerender();
        };

        for (const node of layout.root) {
            if (node.type === 'item') {
                if (!visibleIds.has(node.id)) continue;
                const block = await getWorldEntry(name, data, entryMap.get(node.id));
                if (block?.[0]) {
                    attachMoveToFolderButton(block[0], {
                        kind: 'lore',
                        layout,
                        itemId: node.id,
                        onMove: async () => {
                            await persistLoreLayout(name, layout);
                            rerender();
                        },
                    });
                    list.append(block[0]);
                }
                continue;
            }
            const folder = folderMap.get(node.id);
            if (!folder) continue;
            const shownItems = folder.items.filter(id => visibleIds.has(id));
            if (query && !shownItems.length) continue;
            const state = enabledState(folder.items.map(id => !data.entries[id]?.disable));
            const folderElement = createFolderElement(folder, {
                kind: 'lore',
                owner: name,
                collapsed,
                onEdit,
                onDelete,
                state,
                onStateToggle: async (id, currentState) => setLoreFolderEnabled(name, data, layout, id, currentState !== 'on'),
            });
            if (query) folderElement.classList.remove('is-collapsed');
            const items = folderElement.querySelector('.folderizer-folder-items');
            for (const id of shownItems) {
                const block = await getWorldEntry(name, data, entryMap.get(id));
                if (block?.[0]) {
                    attachMoveToFolderButton(block[0], {
                        kind: 'lore',
                        layout,
                        itemId: id,
                        onMove: async () => {
                            await persistLoreLayout(name, layout);
                            rerender();
                        },
                    });
                    items.append(block[0]);
                }
            }
            folderElement.querySelector('.folderizer-folder-count').textContent = String(folder.items.length);
            list.append(folderElement);
        }

        document.querySelector('#WorldInfo .folderizer-toolbar[data-folderizer-toolbar="lore"]')?.remove();
        list.querySelectorAll('textarea[name="comment"]').forEach(element => initScrollHeight($(element)));
        if (!query) setupLoreSortables(name, data, layout);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to render lorebook folders`, error);
        toastr.error('Failed to render lorebook folders.');
    } finally {
        renderingLorebook = false;
        const list = document.getElementById('world_popup_entries_list');
        if (list && loreObserver) loreObserver.observe(list, { childList: true });
        if (loreRenderRequestedAfterRender) {
            loreRenderRequestedAfterRender = false;
            queueLoreRender();
        }
    }
}

function queueLoreRender() {
    if (loreRenderQueued) return;
    loreRenderQueued = true;
    queueMicrotask(async () => {
        loreRenderQueued = false;
        await renderLorebookFolders();
    });
}

function installLorebookIntegration() {
    const sort = document.getElementById('world_info_sort_order');
    if (!sort) return;
    if (!sort.querySelector(`option[value="${LORE_SORT_VALUE}"]`)) {
        const option = document.createElement('option');
        option.value = LORE_SORT_VALUE;
        option.textContent = 'Folder order';
        option.dataset.rule = 'custom';
        option.dataset.field = 'displayIndex';
        option.dataset.order = 'asc';
        sort.append(option);
    }
    if (!document.getElementById('folderizer_lore_create')) {
        const create = createIconButton('fa-folder-plus', 'New folder', 'folderizer-lore-create');
        create.id = 'folderizer_lore_create';
        create.addEventListener('click', createLorebookFolder);
        document.getElementById('world_popup_new')?.after(create);
    }
    document.querySelector('#WorldInfo .folderizer-toolbar[data-folderizer-toolbar="lore"]')?.remove();

    sort.addEventListener('change', event => {
        if (event.target.value !== LORE_SORT_VALUE) {
            document.querySelector('#WorldInfo .folderizer-toolbar')?.remove();
            document.getElementById('world_popup_entries_list')?.classList.remove('folderizer-lore-root', 'folderizer-searching');
            return;
        }
        if (!featureEnabled('lorebooks')) return;
        event.stopImmediatePropagation();
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
        queueLoreRender();
    }, true);
    document.getElementById('world_info_search')?.addEventListener('input', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        event.stopImmediatePropagation();
        queueLoreRender();
    }, true);
    document.getElementById('world_refresh')?.addEventListener('click', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        queueLoreRender();
    }, true);

    loreObserver = new MutationObserver(() => {
        if (sortingLore || sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        if (renderingLorebook) {
            loreRenderRequestedAfterRender = true;
            return;
        }
        queueLoreRender();
    });
    const list = document.getElementById('world_popup_entries_list');
    if (list) loreObserver.observe(list, { childList: true });
    $('#world_editor_select').on('change.folderizer', () => {
        if (sort.value === LORE_SORT_VALUE) setTimeout(queueLoreRender, 0);
    });
    if (featureEnabled('lorebooks') && accountStorage.getItem(SORT_ORDER_KEY) === LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        queueLoreRender();
    }
}

function regexItemIds(typeKey) {
    return getScriptsByType(REGEX_TYPES[typeKey].scriptType).map(script => String(script.id)).filter(Boolean);
}

function readRegexLayout(typeKey) {
    const owner = regexOwnerKey(typeKey);
    const raw = settings().layouts.regex[typeKey][owner];
    return { owner, layout: normalizeLayout(raw, regexItemIds(typeKey)) };
}

async function persistRegexLayout(typeKey, owner, layout, reorder = true) {
    settings().layouts.regex[typeKey][owner] = layout;
    saveSettingsDebounced();
    if (!reorder) return;
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type);
    const byId = new Map(scripts.map(script => [String(script.id), script]));
    const reordered = flattenLayout(layout).map(id => byId.get(id)).filter(Boolean);
    await saveScriptsByType(reordered, type);
}

function regexLayoutFromDom(list, sourceLayout, typeKey) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    for (const element of list.children) {
        if (element.classList.contains('folderizer-folder')) {
            const id = element.dataset.folderizerId;
            const source = folderSource.get(id);
            if (!source) continue;
            const items = [...element.querySelector('.folderizer-folder-items').children]
                .map(item => item.id)
                .filter(Boolean);
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
        } else if (element.classList.contains('regex-script-label') && element.id) {
            root.push({ type: 'item', id: element.id });
        }
    }
    return normalizeLayout({ version: 1, root, folders }, regexItemIds(typeKey));
}

async function setRegexFolderEnabled(typeKey, layout, folderId, enabled) {
    const folder = layout.folders.find(value => value.id === folderId);
    if (!folder) return;
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type);
    const ids = new Set(folder.items);
    scripts.forEach(script => {
        if (ids.has(String(script.id))) script.disabled = !enabled;
    });
    await saveScriptsByType(scripts, type);
    saveSettingsDebounced();
    if (getCurrentChatId()) await reloadCurrentChat();
    enhanceRegexLists();
}

function unwrapRegexFolders(list) {
    const items = [...list.querySelectorAll('.regex-script-label')];
    list.innerHTML = '';
    items.forEach(item => list.append(item));
    list.closest('.inline-drawer-content, .regex_settings, #regex_container')?.querySelector('.folderizer-toolbar')?.remove();
}

function setupRegexSortable(typeKey, owner, layout) {
    const list = document.querySelector(REGEX_TYPES[typeKey].selector);
    if (!list) return;
    const folderItemsSelector = `.folderizer-regex-items[data-folderizer-regex-type="${typeKey}"]`;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.folderizer-regex-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        saving = true;
        try {
            list.querySelectorAll('.folderizer-folder').forEach(updateFolderCount);
            const next = regexLayoutFromDom(list, layout, typeKey);
            Object.assign(layout, next);
            await persistRegexLayout(typeKey, owner, layout);
            if (getCurrentChatId()) await reloadCurrentChat();
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save regex folder order`, error);
            toastr.error('Failed to save regex folder order.');
        } finally {
            saving = false;
        }
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> .regex-script-label, > .folderizer-folder',
        connectWith: folderItemsSelector,
        placeholder: 'folderizer-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: () => {
            sortingRegex = true;
        },
        stop: async () => {
            try {
                await saveFromDom();
            } finally {
                sortingRegex = false;
            }
        },
    });
    list.querySelectorAll('.folderizer-regex-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> .regex-script-label',
            connectWith: `${REGEX_TYPES[typeKey].selector}, ${folderItemsSelector}`,
            placeholder: 'folderizer-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: () => {
                sortingRegex = true;
            },
            receive: (_, ui) => {
                if (ui.item.hasClass('folderizer-folder')) $(ui.sender).sortable('cancel');
            },
            stop: async () => {
                try {
                    await saveFromDom();
                } finally {
                    sortingRegex = false;
                }
            },
        });
    });
}

function enhanceRegexList(typeKey) {
    const list = document.querySelector(REGEX_TYPES[typeKey].selector);
    if (!list) return;
    if (!featureEnabled('regex')) {
        if (list.querySelector('.folderizer-folder')) unwrapRegexFolders(list);
        return;
    }
    const { owner, layout } = readRegexLayout(typeKey);
    const itemMap = new Map([...list.querySelectorAll('.regex-script-label')].map(element => [element.id, element]));
    if (!itemMap.size) return;
    itemMap.forEach(element => element.remove());
    const scriptsById = new Map(getScriptsByType(REGEX_TYPES[typeKey].scriptType).map(script => [String(script.id), script]));
    itemMap.forEach((element, id) => {
        const script = scriptsById.get(id);
        const toggle = element.querySelector('.disable_regex');
        if (script && toggle) toggle.checked = !!script.disabled;
    });
    const collapsed = ownerCollapsed('regex', `${typeKey}:${owner}`);
    const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));
    list.classList.add('folderizer-regex-root');

    const rerender = () => enhanceRegexLists();
    const onEdit = async id => {
        const folder = layout.folders.find(value => value.id === id);
        if (!folder) return;
        const values = await requestFolderSettings(layout, folder);
        if (!values) return;
        Object.assign(folder, values);
        await persistRegexLayout(typeKey, owner, layout, false);
        rerender();
    };
    const onDelete = async id => {
        const folder = layout.folders.find(value => value.id === id);
        if (!folder || !await Popup.show.confirm('Delete folder', `Delete "${folder.name}" and keep its regex scripts at the root?`)) return;
        removeFolder(layout, id);
        await persistRegexLayout(typeKey, owner, layout);
        rerender();
    };

    list.innerHTML = '';
    for (const node of layout.root) {
        if (node.type === 'item') {
            const item = itemMap.get(node.id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'regex',
                    layout,
                    itemId: node.id,
                    onMove: async () => {
                        await persistRegexLayout(typeKey, owner, layout);
                        rerender();
                    },
                });
                list.append(item);
            }
            continue;
        }
        const folder = folderMap.get(node.id);
        if (!folder) continue;
        const state = enabledState(folder.items.map(id => !scriptsById.get(id)?.disabled));
        const folderElement = createFolderElement(folder, {
            kind: 'regex',
            owner: `${typeKey}:${owner}`,
            collapsed,
            onEdit,
            onDelete,
            state,
            onStateToggle: async (id, currentState) => setRegexFolderEnabled(typeKey, layout, id, currentState !== 'on'),
        });
        const items = folderElement.querySelector('.folderizer-folder-items');
        items.dataset.folderizerRegexType = typeKey;
        folder.items.forEach(id => {
            const item = itemMap.get(id);
            if (item) {
                attachMoveToFolderButton(item, {
                    kind: 'regex',
                    layout,
                    itemId: id,
                    onMove: async () => {
                        await persistRegexLayout(typeKey, owner, layout);
                        rerender();
                    },
                });
                items.append(item);
            }
        });
        updateFolderCount(folderElement);
        list.append(folderElement);
    }

    ensureToolbar(list.parentElement, `regex-${typeKey}`, async () => {
        const name = await requestFolderName(layout);
        if (!name) return;
        const folder = { id: crypto.randomUUID(), name, color: '', items: [] };
        layout.folders.push(folder);
        layout.root.unshift({ type: 'folder', id: folder.id });
        await persistRegexLayout(typeKey, owner, layout, false);
        rerender();
    });
    setupRegexSortable(typeKey, owner, layout);
}

function enhanceRegexLists() {
    if (enhancingRegex) return;
    const root = document.getElementById('regex_container');
    enhancingRegex = true;
    try {
        regexObserver?.disconnect();
        Object.keys(REGEX_TYPES).forEach(enhanceRegexList);
        regexObserver?.takeRecords();
    } finally {
        enhancingRegex = false;
        if (root && regexObserver) {
            regexObserver.observe(root, { childList: true, subtree: true });
        }
    }
}

function installRegexIntegration() {
    const root = document.getElementById('regex_container');
    if (!root) return;
    let regexRenderQueued = false;
    regexObserver = new MutationObserver(() => {
        if (enhancingRegex || sortingRegex || regexRenderQueued) return;
        regexRenderQueued = true;
        queueMicrotask(() => {
            regexRenderQueued = false;
            if (sortingRegex) return;
            enhanceRegexLists();
        });
    });
    regexObserver.observe(root, { childList: true, subtree: true });
    enhanceRegexLists();
}

function renderSettings() {
    if (document.getElementById('folderizer_settings')) return;
    const html = `
        <div id="folderizer_settings" class="folderizer-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Folderizer</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox flex-container">
                        <input id="folderizer_enable_prompts" type="checkbox">
                        <span>Prompt folders</span>
                    </label>
                    <label class="checkbox flex-container">
                        <input id="folderizer_enable_lorebooks" type="checkbox">
                        <span>Lorebook folders</span>
                    </label>
                    <label class="checkbox flex-container">
                        <input id="folderizer_enable_regex" type="checkbox">
                        <span>Regex folders</span>
                    </label>
                    <div class="folderizer-settings-clear">
                        <div class="folderizer-settings-subtitle">Clear</div>
                        <div class="folderizer-settings-actions">
                            <button id="folderizer_clear_prompts" class="menu_button" type="button">Prompts</button>
                            <button id="folderizer_clear_lorebooks" class="menu_button" type="button">Lorebooks</button>
                            <button id="folderizer_clear_regex" class="menu_button" type="button">Regex</button>
                            <button id="folderizer_clear_all" class="menu_button caution" type="button">All</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    $('#extensions_settings2').append(html);

    const sync = () => {
        $('#folderizer_enable_prompts').prop('checked', featureEnabled('prompts'));
        $('#folderizer_enable_lorebooks').prop('checked', featureEnabled('lorebooks'));
        $('#folderizer_enable_regex').prop('checked', featureEnabled('regex'));
    };
    const rerender = () => {
        promptManager?.render?.(false);
        queueLoreRender();
        enhanceRegexLists();
    };
    $('#folderizer_enable_prompts').on('input', function () {
        settings().features.prompts = !!this.checked;
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_enable_lorebooks').on('input', function () {
        settings().features.lorebooks = !!this.checked;
        saveSettingsDebounced();
        if (!this.checked && $('#world_info_sort_order').val() === LORE_SORT_VALUE) {
            $('#world_info_sort_order').val('0').trigger('change');
        }
        rerender();
    });
    $('#folderizer_enable_regex').on('input', function () {
        settings().features.regex = !!this.checked;
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_prompts').on('click', async () => {
        if (!await Popup.show.confirm('Clear prompt folder data?', 'This keeps prompt order and only removes Folderizer prompt layouts.')) return;
        settings().layouts.prompts = {};
        settings().collapsed.prompt = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_lorebooks').on('click', async () => {
        if (!await Popup.show.confirm('Clear lorebook folder data?', 'This keeps lorebook entries and only removes Folderizer lorebook layouts.')) return;
        settings().layouts.lorebooks = {};
        settings().collapsed.lore = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_regex').on('click', async () => {
        if (!await Popup.show.confirm('Clear regex folder data?', 'This keeps regex scripts and only removes Folderizer regex layouts.')) return;
        settings().layouts.regex = { global: {}, scoped: {}, preset: {} };
        settings().collapsed.regex = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#folderizer_clear_all').on('click', async () => {
        if (!await Popup.show.confirm('Clear all Folderizer data?', 'This keeps original items and only removes Folderizer layouts and collapsed states.')) return;
        settings().layouts = { prompts: {}, lorebooks: {}, regex: { global: {}, scoped: {}, preset: {} } };
        settings().collapsed = { prompt: {}, lore: {}, regex: {} };
        saveSettingsDebounced();
        rerender();
    });
    sync();
}

export async function init() {
    settings();
    renderSettings();
    installLorebookIntegration();
    installRegexIntegration();
    eventSource.on(event_types.PRESET_RENAMED_BEFORE, ({ apiId, oldName, newName }) => {
        const oldPromptKey = `${apiId}:${oldName}`;
        const newPromptKey = `${apiId}:${newName}`;
        if (settings().layouts.prompts[oldPromptKey] && !settings().layouts.prompts[newPromptKey]) {
            settings().layouts.prompts[newPromptKey] = settings().layouts.prompts[oldPromptKey];
            delete settings().layouts.prompts[oldPromptKey];
            saveSettingsDebounced();
        }
    });
    eventSource.on(event_types.PRESET_CHANGED, () => {
        promptManager?.render?.(false);
        enhanceRegexLists();
    });
    eventSource.on(event_types.CHAT_CHANGED, enhanceRegexLists);
    try {
        await installPromptIntegration();
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize prompt folders`, error);
    }
}
