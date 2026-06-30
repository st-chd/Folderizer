import { characters, eventSource, event_types, getCurrentChatId, reloadCurrentChat, saveSettingsDebounced, this_chid } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { promptManager } from '../../../openai.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { getPresetManager } from '../../../preset-manager.js';
import { renderTemplateAsync } from '../../../templates.js';
import { getSortableDelay, initScrollHeight, waitUntilCondition } from '../../../utils.js';
import { accountStorage } from '../../../util/AccountStorage.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import {
    createWorldInfoEntry,
    deleteWIOriginalDataValue,
    deleteWorldInfoEntry,
    getWorldEntry,
    loadWorldInfo,
    reloadEditor,
    saveWorldInfo,
    setWIOriginalDataValue,
    SORT_ORDER_KEY,
    updateWorldInfoList,
    world_names,
} from '../../../world-info.js';
import {
    getScriptsByType,
    saveScriptsByType,
    SCRIPT_TYPES,
} from '../../regex/engine.js';
import {
    FOLDY_VERSION,
    flattenLayout,
    generateUUID,
    hasDuplicateFolderName,
    normalizeLayout,
    orderItemsByLayout,
    removeFolder,
} from './model.js';

const EXTENSION_NAME = 'Foldy';
const LORE_SORT_VALUE = 'foldy';
const LEGACY_KEY = ['folder', 'izer'].join('');
const SETTINGS_KEY = 'foldy';
const LEGACY_LORE_SORT_VALUE = LEGACY_KEY;
const DEFAULT_PICKER_COLOR = '#7c6ee6';
const BUNDLE_KIND = 'foldy-bundle';
const LEGACY_BUNDLE_KIND = `${LEGACY_KEY}-bundle`;
const BUNDLE_VERSION = 1;
const DEBUG_LOG_LIMIT = 200;
const FOLDY_SOURCE_PATTERN = /(?:^|[\\/])Foldy[\\/](?:index|model)\.js(?:[?#][^\s)]*)?/i;

const REGEX_TYPES = {
    global: {
        scriptType: SCRIPT_TYPES.GLOBAL,
        selector: '#saved_regex_scripts',
        label: '글로벌',
    },
    scoped: {
        scriptType: SCRIPT_TYPES.SCOPED,
        selector: '#saved_scoped_scripts',
        label: '범위',
    },
    preset: {
        scriptType: SCRIPT_TYPES.PRESET,
        selector: '#saved_preset_scripts',
        label: '프리셋',
    },
};
const REGEX_FOLDER_TARGETS = [
    { key: 'global', label: '글로벌' },
    { key: 'preset', label: '프리셋' },
    { key: 'scoped', label: '범위' },
];

let currentPromptLayout = null;
let renderingLorebook = false;
let loreRenderQueued = false;
let loreRenderRequestedAfterRender = false;
let loreObserver = null;
let handlingLoreAction = false;
let regexObserver = null;
let enhancingRegex = false;
let sortingPrompt = false;
let sortingLore = false;
let sortingRegex = false;
let originalPromptRenderItems = null;
let originalPromptMakeDraggable = null;
let debugListenersInstalled = false;
let slashCommandsRegistered = false;
const debugLogEntries = [];

function settings() {
    if (!extension_settings[SETTINGS_KEY] && extension_settings[LEGACY_KEY]) {
        extension_settings[SETTINGS_KEY] = extension_settings[LEGACY_KEY];
    }
    extension_settings[SETTINGS_KEY] ??= {};
    const value = extension_settings[SETTINGS_KEY];
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
    value.debug ??= false;
    return value;
}

function debugEnabled() {
    return settings().debug === true;
}

function formatDebugDetail(detail) {
    if (detail instanceof Error) return `${detail.name}: ${detail.message}\n${detail.stack || ''}`.trim();
    if (typeof detail === 'string') return detail;
    try {
        return JSON.stringify(detail, null, 2);
    } catch {
        return String(detail);
    }
}

function debugLog(level, message, detail = null) {
    if (!debugEnabled() && level !== 'error') return;
    debugLogEntries.push({
        time: new Date().toLocaleString(),
        level,
        message,
        detail: detail == null ? '' : formatDebugDetail(detail),
    });
    if (debugLogEntries.length > DEBUG_LOG_LIMIT) debugLogEntries.splice(0, debugLogEntries.length - DEBUG_LOG_LIMIT);
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug';
    console[method]?.(`[${EXTENSION_NAME}] ${message}`, detail ?? '');
}

function debugText() {
    const state = settings();
    const header = [
        `Foldy ${state.debug ? 'debug on' : 'debug off'}`,
        `time: ${new Date().toLocaleString()}`,
        `features: prompts=${featureEnabled('prompts')}, lorebooks=${featureEnabled('lorebooks')}, regex=${featureEnabled('regex')}`,
        'userAgent:',
        navigator.userAgent,
    ].join('\n');
    if (!debugLogEntries.length) return `${header}\n\n아직 기록된 Foldy 디버그 로그가 없습니다.`;
    const body = debugLogEntries.map(entry => {
        const detail = entry.detail ? `\n${entry.detail}` : '';
        return `[${entry.time}] [${entry.level.toUpperCase()}] ${entry.message}${detail}`;
    }).join('\n\n');
    return `${header}\n\n${body}`;
}

async function copyDebugLog() {
    const text = debugText();
    try {
        await navigator.clipboard.writeText(text);
        toastr.success('Foldy 디버그 로그를 복사했습니다.');
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to copy debug log`, error);
        const area = document.createElement('textarea');
        area.className = 'foldy-debug-copy';
        area.value = text;
        await new Popup(area, POPUP_TYPE.TEXT, 'Foldy 디버그 로그').show();
    }
}

async function showDebugLog() {
    const wrap = document.createElement('div');
    wrap.className = 'foldy-debug-view';
    const pre = document.createElement('pre');
    pre.textContent = debugText();
    wrap.append(pre);
    await new Popup(wrap, POPUP_TYPE.TEXT, 'Foldy 디버그 로그', {
        wide: true,
        large: true,
    }).show();
}

function domFolderDiagnostics(rootSelector) {
    const root = document.querySelector(rootSelector);
    if (!root) return { rendered: false };
    const folders = [...root.querySelectorAll('.foldy-folder')];
    const items = [...root.querySelectorAll('.foldy-folder-items > *')];
    return {
        rendered: true,
        folders: folders.length,
        collapsed: folders.filter(element => element.classList.contains('is-collapsed')).length,
        folderItems: items.length,
        samples: folders.slice(0, 10).map(element => {
            const name = element.querySelector('.foldy-folder-name');
            const style = getComputedStyle(element);
            const nameStyle = name ? getComputedStyle(name) : null;
            return {
                id: element.dataset.foldyId,
                nameLength: name?.textContent?.length ?? 0,
                cssBackground: style.backgroundColor,
                cssBorder: style.borderColor,
                cssName: nameStyle?.color ?? '',
                itemCount: element.querySelector('.foldy-folder-items')?.children.length ?? 0,
            };
        }),
    };
}

function layoutDiagnostics(layout, validIds = [], collapsed = new Set()) {
    const validSet = new Set(validIds.map(String));
    const folderIds = layout.folders.map(folder => String(folder.id));
    const rootedFolderIds = layout.root.filter(node => node?.type === 'folder').map(node => String(node.id));
    const itemOccurrences = new Map();
    const addItem = id => itemOccurrences.set(id, (itemOccurrences.get(id) ?? 0) + 1);
    layout.root.filter(node => node?.type === 'item').forEach(node => addItem(String(node.id)));
    layout.folders.forEach(folder => folder.items.forEach(id => addItem(String(id))));
    const missingItems = [...itemOccurrences.keys()].filter(id => !validSet.has(id));
    const duplicateItems = [...itemOccurrences.entries()].filter(([, count]) => count > 1).map(([id, count]) => ({ id, count }));
    const duplicateFolderIds = folderIds.filter((id, index) => folderIds.indexOf(id) !== index);
    const unrootedFolders = folderIds.filter(id => !rootedFolderIds.includes(id));
    const missingFolders = rootedFolderIds.filter(id => !folderIds.includes(id));
    return {
        rootNodes: layout.root.length,
        folderCount: layout.folders.length,
        rootItems: layout.root.filter(node => node?.type === 'item').length,
        validItems: validIds.length,
        folderItems: layout.folders.reduce((sum, folder) => sum + folder.items.length, 0),
        collapsed: [...collapsed].filter(id => folderIds.includes(id)).length,
        issues: {
            missingItems,
            duplicateItems,
            duplicateFolderIds,
            unrootedFolders,
            missingFolders,
        },
        folderDetails: layout.folders.map(folder => ({
            id: folder.id,
            nameLength: String(folder.name ?? '').length,
            items: folder.items.length,
            color: folder.color || '(default)',
            borderColor: folder.borderColor || '(default)',
            nameColor: folder.nameColor || '(default)',
        })),
    };
}

async function foldyDiagnosticText() {
    const state = settings();
    const report = {
        title: 'Foldy 현재 상태 진단',
        time: new Date().toLocaleString(),
        debugMode: debugEnabled(),
        features: {
            prompts: featureEnabled('prompts'),
            lorebooks: featureEnabled('lorebooks'),
            regex: featureEnabled('regex'),
        },
        userAgent: navigator.userAgent,
        viewport: {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
        },
        prompts: null,
        lorebook: null,
        regex: {},
        debugLogEntries: debugLogEntries.length,
    };

    try {
        if (promptManager?.activeCharacter) {
            const { owner, layout } = readPromptLayout(promptManager);
            const validIds = promptOrderIds(promptManager);
            report.prompts = {
                owner: { present: Boolean(owner), length: String(owner ?? '').length },
                layout: layoutDiagnostics(layout, validIds, ownerCollapsed('prompt', owner)),
                dom: domFolderDiagnostics('#completion_prompt_manager_list'),
            };
        } else {
            report.prompts = { unavailable: '프롬프트 매니저가 준비되지 않았거나 선택된 캐릭터가 없습니다.' };
        }
    } catch (error) {
        report.prompts = { error: formatDebugDetail(error) };
    }

    try {
        const name = selectedLorebookName();
        if (name) {
            const data = await loadWorldInfo(name);
            const validIds = Object.values(data?.entries || {})
                .filter(value => value && typeof value === 'object')
                .map(value => String(value.uid));
            const layout = normalizeLayout(state.layouts.lorebooks[name], validIds);
            report.lorebook = {
                owner: { present: Boolean(name), length: String(name ?? '').length },
                sortMode: $('#world_info_sort_order').val(),
                layout: layoutDiagnostics(layout, validIds, ownerCollapsed('lore', name)),
                dom: domFolderDiagnostics('#world_popup_entries_list'),
            };
        } else {
            report.lorebook = { unavailable: '선택된 로어북이 없습니다.' };
        }
    } catch (error) {
        report.lorebook = { error: formatDebugDetail(error) };
    }

    for (const typeKey of Object.keys(REGEX_TYPES)) {
        try {
            const { owner, layout } = readRegexLayout(typeKey);
            const validIds = regexItemIds(typeKey);
            report.regex[typeKey] = {
                owner: { present: Boolean(owner), length: String(owner ?? '').length },
                layout: layoutDiagnostics(layout, validIds, ownerCollapsed('regex', `${typeKey}:${owner}`)),
                dom: domFolderDiagnostics(REGEX_TYPES[typeKey].selector),
            };
        } catch (error) {
            report.regex[typeKey] = { error: formatDebugDetail(error) };
        }
    }

    return JSON.stringify(report, null, 2);
}

async function showFoldyDebugger() {
    const text = await foldyDiagnosticText();
    const wrap = document.createElement('div');
    wrap.className = 'foldy-debug-view foldy-diagnostics-view';

    const actions = document.createElement('div');
    actions.className = 'foldy-diagnostics-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'menu_button';
    copy.textContent = '복사';
    copy.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(text);
            toastr.success('Foldy 진단 결과를 복사했습니다.');
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to copy diagnostics`, error);
            toastr.error('진단 결과를 복사하지 못했습니다.');
        }
    });
    actions.append(copy);

    const pre = document.createElement('pre');
    pre.textContent = text;
    wrap.append(actions, pre);
    await new Popup(wrap, POPUP_TYPE.TEXT, 'Foldy 진단 결과', {
        wide: true,
        large: true,
    }).show();
}

function registerSlashCommands() {
    if (slashCommandsRegistered) return;
    slashCommandsRegistered = true;
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'Foldy-debugger',
        aliases: ['foldy-debugger', 'foldy-debug'],
        callback: async () => {
            await showFoldyDebugger();
            return '';
        },
        helpString: '현재 Foldy 상태 진단 결과를 복사 가능한 팝업으로 표시합니다.',
    }));
}

function installDebugListeners() {
    if (debugListenersInstalled) return;
    debugListenersInstalled = true;
    window.addEventListener('error', event => {
        if (!debugEnabled()) return;
        if (!isFoldyErrorSource(event.filename, event.error?.stack)) return;
        debugLog('error', '브라우저 오류', {
            message: event.message,
            source: event.filename,
            line: event.lineno,
            column: event.colno,
            error: event.error?.stack || event.error?.message || '',
        });
    });
    window.addEventListener('unhandledrejection', event => {
        if (!debugEnabled()) return;
        if (!isFoldyErrorSource(event.reason?.stack, event.reason?.message, event.reason)) return;
        debugLog('error', '처리되지 않은 Promise 오류', event.reason);
    });
}

function isFoldyErrorSource(...values) {
    return values
        .filter(Boolean)
        .map(value => String(value))
        .some(value => FOLDY_SOURCE_PATTERN.test(value));
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

function promptOwnerKeyForName(name) {
    const manager = promptPresetManager();
    return `${manager?.apiId || 'openai'}:${name || ''}`;
}

function promptExportName() {
    return promptPresetManager()?.getSelectedPresetName?.() || 'prompts';
}

function promptBundlePresetName(bundle) {
    if (bundle?.presetName) return String(bundle.presetName);
    const owner = String(bundle?.owner || '');
    const index = owner.indexOf(':');
    return index >= 0 ? owner.slice(index + 1) : owner;
}

function selectedLorebookName() {
    const value = String($('#world_editor_select').find(':selected').val() ?? '');
    return world_names?.[value] || String($('#world_editor_select').find(':selected').text() ?? '').trim();
}

function storedLoreSortValue() {
    const value = accountStorage.getItem(SORT_ORDER_KEY);
    if (value === LEGACY_LORE_SORT_VALUE) {
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
        return LORE_SORT_VALUE;
    }
    return value;
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

function regexExportName(typeKey) {
    if (typeKey === 'global') return 'global';
    if (typeKey === 'scoped') return characters?.[this_chid]?.name || characters?.[this_chid]?.avatar || 'scoped';
    return getPresetManager()?.getSelectedPresetName?.() || 'preset';
}

function createIconButton(icon, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid ${icon} ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    return button;
}

function createIconCodeButton(code, title, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button fa-solid foldy-code-icon ${className}`.trim();
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = String.fromCodePoint(parseInt(code, 16));
    return button;
}

function createLabeledIconButton(icon, title, label, className = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button foldy-labeled-button ${className}`.trim();
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
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(value ?? '').trim());
}

function isColorValue(value) {
    const color = String(value ?? '').trim();
    return color.toLowerCase() === 'transparent'
        || isHexColor(color)
        || globalThis.CSS?.supports?.('color', color)
        || false;
}

function normalizeColor(value, fallback = '') {
    const color = String(value ?? '').trim();
    if (!color) return fallback;
    if (color.toLowerCase() === 'transparent') return 'transparent';
    if (isHexColor(color) && (color.length === 4 || color.length === 5)) {
        return `#${[...color.slice(1)].map(part => `${part}${part}`).join('')}`.toLowerCase();
    }
    if (isHexColor(color)) return color.toLowerCase();
    return globalThis.CSS?.supports?.('color', color) ? color : fallback;
}

function pickerColor(value, fallback = DEFAULT_PICKER_COLOR) {
    const color = normalizeColor(value, fallback);
    return color === 'transparent' ? 'rgba(0, 0, 0, 0)' : color;
}

let colorProbe = null;

function cssColorToHex(value, fallback = DEFAULT_PICKER_COLOR) {
    colorProbe ??= document.createElement('span');
    colorProbe.style.display = 'none';
    colorProbe.style.color = value;
    if (!colorProbe.isConnected) document.body.append(colorProbe);
    try {
        const color = getComputedStyle(colorProbe).color;
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([.\d]+))?/i);
        if (!match) return fallback;
        const hex = [match[1], match[2], match[3]].map(part => Number(part).toString(16).padStart(2, '0')).join('');
        const alpha = match[4] == null ? 1 : Number(match[4]);
        if (!Number.isFinite(alpha) || alpha >= 1) return `#${hex}`;
        return `#${hex}${Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0')}`;
    } catch {
        return fallback;
    }
}

function themeColorHex(variableName, fallback = DEFAULT_PICKER_COLOR) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
    return cssColorToHex(value || fallback, fallback);
}

function createColorSetting(labelText, initialValue, pickerFallback = DEFAULT_PICKER_COLOR) {
    const field = document.createElement('label');
    field.className = 'foldy-color-field';

    const label = document.createElement('span');
    label.textContent = labelText;

    const controls = document.createElement('span');
    controls.className = 'foldy-color-controls';

    const picker = document.createElement('toolcool-color-picker');
    picker.setAttribute('color', pickerColor(initialValue, pickerFallback));

    const hex = document.createElement('input');
    hex.type = 'text';
    hex.value = normalizeColor(initialValue);
    hex.placeholder = '#fff, #ffffff, transparent, rgba(...)';
    hex.spellcheck = false;

    const reset = document.createElement('button');
    reset.className = 'menu_button foldy-color-reset';
    reset.type = 'button';
    reset.textContent = '기본값';
    reset.title = '테마 기본값으로 되돌리기';
    reset.setAttribute('aria-label', '테마 기본값으로 되돌리기');

    const syncPicker = value => {
        const next = pickerColor(value, pickerFallback);
        picker.setAttribute('color', next);
        picker.color = next;
    };

    picker.addEventListener('change', event => {
        hex.value = event.detail?.rgba || picker.getAttribute('color') || '';
    });
    hex.addEventListener('input', () => {
        const value = normalizeColor(hex.value);
        if (!value) return;
        syncPicker(value);
    });
    reset.addEventListener('click', () => {
        hex.value = '';
        syncPicker('');
    });

    controls.append(picker, hex, reset);
    field.append(label, controls);

    return {
        field,
        value: () => normalizeColor(hex.value),
        isValid: () => !hex.value.trim() || isColorValue(hex.value),
    };
}

function folderStyleValues(values) {
    return {
        color: values.color,
        borderColor: values.borderColor,
        nameColor: values.nameColor,
    };
}

function applyFolderStyleToAll(layout, sourceFolderId, style) {
    for (const folder of layout.folders) {
        if (folder.id === sourceFolderId) continue;
        Object.assign(folder, folderStyleValues(style));
    }
}

function updateFolderCount(folderElement) {
    const count = folderElement.querySelector('.foldy-folder-items')?.children.length ?? 0;
    const countElement = folderElement.querySelector('.foldy-folder-count');
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
    button.classList.toggle('fa-toggle-on', state === 'on' || state === 'mixed');
    button.classList.toggle('fa-toggle-off', state === 'off');
    button.classList.remove('fa-circle-half-stroke');
    button.dataset.state = state;
    button.title = state === 'on' ? '이 폴더의 모든 항목 비활성화' : '이 폴더의 모든 항목 활성화';
}

function createFolderElement(folder, { kind, owner, collapsed, onEdit, onDelete, onStateToggle, state = null }) {
    const element = document.createElement(kind === 'regex' ? 'div' : 'li');
    element.className = `foldy-folder foldy-${kind}-folder`;
    element.dataset.foldyId = folder.id;
    const backgroundColor = normalizeColor(folder.color);
    const borderColor = normalizeColor(folder.borderColor);
    if (backgroundColor) element.style.setProperty('--foldy-background-color', backgroundColor);
    if (borderColor) element.style.setProperty('--foldy-border-color', borderColor);
    element.style.setProperty('--foldy-name-color', normalizeColor(folder.nameColor) || 'var(--SmartThemeBodyColor)');

    const header = document.createElement('div');
    header.className = 'foldy-folder-header';

    const drag = document.createElement('span');
    drag.className = 'foldy-drag drag-handle fa-solid fa-bars';
    drag.title = '폴더 이동';

    const name = document.createElement('span');
    name.className = 'foldy-folder-name';
    name.textContent = folder.name;
    name.title = folder.name;

    const count = document.createElement('span');
    count.className = 'foldy-folder-count';
    count.textContent = String(folder.items.length);

    const edit = createIconButton('fa-pencil', '폴더 편집');
    edit.addEventListener('click', () => onEdit(folder.id));

    const remove = createIconButton('fa-trash', '폴더 삭제', 'caution');
    remove.addEventListener('click', () => onDelete(folder.id));

    const collapse = createIconButton('fa-chevron-down', '폴더 접기');
    collapse.classList.add('foldy-collapse-toggle');
    const items = document.createElement(kind === 'regex' ? 'div' : 'ul');
    items.className = `foldy-folder-items foldy-${kind}-items`;

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
        const stateButton = createIconButton('fa-toggle-off', '폴더 항목 켜기/끄기', 'foldy-state-toggle');
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
    const value = await Popup.show.input(currentId ? '폴더 이름 변경' : '새 폴더', '폴더 이름', currentName);
    const name = String(value ?? '').trim();
    if (!name) return null;
    if (hasDuplicateFolderName(layout, name, currentId)) {
        toastr.warning('같은 이름의 폴더가 이미 있습니다.');
        return null;
    }
    return name;
}

async function requestNewFolder(layout, candidates = []) {
    const form = document.createElement('div');
    form.className = 'foldy-edit-form foldy-create-form';

    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = '새 폴더';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '폴더 이름';
    nameInput.autofocus = true;

    const nameField = document.createElement('label');
    nameField.className = 'foldy-text-field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '이름';
    nameField.append(nameLabel, nameInput);

    form.append(title, nameField);

    const selectable = candidates.filter(candidate => candidate?.id && candidate?.label);
    if (selectable.length) {
        const group = document.createElement('div');
        group.className = 'foldy-create-items';
        const groupTitle = document.createElement('div');
        groupTitle.className = 'foldy-create-items-title';
        groupTitle.textContent = '폴더에 넣을 항목';
        const list = document.createElement('div');
        list.className = 'foldy-create-items-list';
        selectable.forEach(candidate => {
            const label = document.createElement('label');
            label.className = 'checkbox flex-container';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = String(candidate.id);
            const text = document.createElement('span');
            text.textContent = candidate.label;
            text.title = candidate.label;
            label.append(checkbox, text);
            list.append(label);
        });
        group.append(groupTitle, list);
        form.append(group);
    }

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '만들기',
        cancelButton: '취소',
        onClosing: value => {
            if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('폴더 이름은 비워둘 수 없습니다.');
                return false;
            }
            if (hasDuplicateFolderName(layout, name)) {
                toastr.warning('같은 이름의 폴더가 이미 있습니다.');
                return false;
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const itemIds = [...form.querySelectorAll('.foldy-create-items input[type="checkbox"]:checked')]
        .map(input => String(input.value));
    return { name: nameInput.value.trim(), itemIds };
}

function regexFolderCreateContext(typeKey) {
    const { owner, layout } = readRegexLayout(typeKey);
    const scriptsById = new Map(getScriptsByType(REGEX_TYPES[typeKey].scriptType)
        .filter(script => script?.id)
        .map(script => [String(script.id), script]));
    const candidates = rootItemIds(layout).map(id => ({
        id,
        label: scriptsById.get(id)?.scriptName || id,
    }));
    return { owner, layout, candidates };
}

async function requestNewRegexFolder(defaultTypeKey = 'global') {
    const form = document.createElement('div');
    form.className = 'foldy-edit-form foldy-create-form';

    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = '새 폴더';

    const targetField = document.createElement('label');
    targetField.className = 'foldy-text-field foldy-target-field';
    const targetLabel = document.createElement('span');
    targetLabel.textContent = '대상';
    const targetControls = document.createElement('span');
    targetControls.className = 'foldy-target-options';
    REGEX_FOLDER_TARGETS.forEach(target => {
        const option = document.createElement('label');
        option.className = 'checkbox flex-container foldy-target-option';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'foldy_regex_folder_target';
        input.value = target.key;
        input.checked = target.key === defaultTypeKey;
        const text = document.createElement('span');
        text.textContent = target.label;
        option.append(input, text);
        targetControls.append(option);
    });
    targetField.append(targetLabel, targetControls);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = '폴더 이름';
    nameInput.autofocus = true;

    const nameField = document.createElement('label');
    nameField.className = 'foldy-text-field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '이름';
    nameField.append(nameLabel, nameInput);

    const group = document.createElement('div');
    group.className = 'foldy-create-items';
    const groupTitle = document.createElement('div');
    groupTitle.className = 'foldy-create-items-title';
    groupTitle.textContent = '폴더에 넣을 항목';
    const list = document.createElement('div');
    list.className = 'foldy-create-items-list';
    group.append(groupTitle, list);

    const selectedTypeKey = () => form.querySelector('input[name="foldy_regex_folder_target"]:checked')?.value || 'global';
    const renderCandidates = () => {
        list.innerHTML = '';
        const { candidates } = regexFolderCreateContext(selectedTypeKey());
        if (!candidates.length) {
            const empty = document.createElement('div');
            empty.className = 'foldy-empty-hint';
            empty.textContent = '폴더에 넣을 수 있는 루트 항목이 없습니다.';
            list.append(empty);
            return;
        }
        candidates.forEach(candidate => {
            const label = document.createElement('label');
            label.className = 'checkbox flex-container';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = String(candidate.id);
            const text = document.createElement('span');
            text.textContent = candidate.label;
            text.title = candidate.label;
            label.append(checkbox, text);
            list.append(label);
        });
    };

    targetControls.addEventListener('input', renderCandidates);
    form.append(title, targetField, nameField, group);
    renderCandidates();

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '만들기',
        cancelButton: '취소',
        onClosing: value => {
            if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('폴더 이름은 비워둘 수 없습니다.');
                return false;
            }
            const { layout } = regexFolderCreateContext(selectedTypeKey());
            if (hasDuplicateFolderName(layout, name)) {
                toastr.warning('같은 이름의 폴더가 이미 있습니다.');
                return false;
            }
            return true;
        },
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    const typeKey = selectedTypeKey();
    const itemIds = [...form.querySelectorAll('.foldy-create-items input[type="checkbox"]:checked')]
        .map(input => String(input.value));
    return { typeKey, name: nameInput.value.trim(), itemIds };
}

async function requestFolderSettings(layout, folder) {
    const form = document.createElement('div');
    form.className = 'foldy-edit-form foldy-folder-settings-form';

    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = '폴더 설정';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = folder.name;
    nameInput.placeholder = '폴더 이름';
    nameInput.autofocus = true;

    const nameField = document.createElement('label');
    nameField.className = 'foldy-text-field';
    const nameLabel = document.createElement('span');
    nameLabel.textContent = '이름';
    nameField.append(nameLabel, nameInput);

    const backgroundColor = createColorSetting('배경색', folder.color, themeColorHex('--SmartThemeBlurTintColor'));
    const borderColor = createColorSetting('테두리색', folder.borderColor, themeColorHex('--SmartThemeBorderColor'));
    const nameColor = createColorSetting('이름 색상', folder.nameColor, themeColorHex('--SmartThemeBodyColor', '#ffffff'));

    const applyAllField = document.createElement('label');
    applyAllField.className = 'checkbox flex-container foldy-apply-style-all';
    const applyAllCheckbox = document.createElement('input');
    applyAllCheckbox.type = 'checkbox';
    const applyAllText = document.createElement('span');
    applyAllText.textContent = '저장할 때 다른 폴더에도 색상 적용';
    applyAllField.append(applyAllCheckbox, applyAllText);

    form.append(title, nameField, backgroundColor.field, borderColor.field, nameColor.field, applyAllField);

    const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '저장',
        cancelButton: '취소',
        onClosing: value => {
            if (value.result !== POPUP_RESULT.AFFIRMATIVE) return true;
            const name = nameInput.value.trim();
            if (!name) {
                toastr.warning('폴더 이름은 비워둘 수 없습니다.');
                return false;
            }
            if (hasDuplicateFolderName(layout, name, folder.id)) {
                toastr.warning('같은 이름의 폴더가 이미 있습니다.');
                return false;
            }
            if (![backgroundColor, borderColor, nameColor].every(setting => setting.isValid())) {
                toastr.warning('transparent, #fff, #ffff, #ffffff, #ffffffff 형식으로 입력하거나 기본값을 쓰려면 비워두세요.');
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
        applyStyleToAll: applyAllCheckbox.checked,
    };
}

async function requestMoveTarget(layout, itemId) {
    if (!layout.folders.length) {
        toastr.info('먼저 폴더를 만들어 주세요.');
        return null;
    }

    const currentFolder = layout.folders.find(folder => folder.items.includes(String(itemId)));
    const currentValue = currentFolder?.id ?? '';
    const form = document.createElement('div');
    form.className = 'foldy-move-form';

    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = '폴더로 이동';

    const label = document.createElement('label');
    const text = document.createElement('span');
    text.textContent = '대상';
    const select = document.createElement('select');
    select.className = 'text_pole';

    const rootOption = document.createElement('option');
    rootOption.value = '';
    rootOption.textContent = '최상위 (폴더 없음)';
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
        okButton: '이동',
        cancelButton: '취소',
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

function rootItemIds(layout) {
    return layout.root
        .filter(node => node?.type === 'item' && node.id)
        .map(node => String(node.id));
}

function addFolderWithItems(layout, folderName, itemIds = []) {
    const selected = new Set(itemIds.map(String));
    const folder = { id: generateUUID(), name: folderName, color: '', items: [...selected] };
    layout.folders.push(folder);
    layout.root = [
        { type: 'folder', id: folder.id },
        ...layout.root.filter(node => node?.type !== 'item' || !selected.has(String(node.id))),
    ];
    return folder;
}

function collapseNewFolder(kind, owner, folderId) {
    const collapsed = ownerCollapsed(kind, owner);
    collapsed.add(folderId);
    saveCollapsed(kind, owner, collapsed);
}

function attachMoveToFolderButton(element, { kind, layout, itemId, onMove }) {
    if (!element || element.querySelector(':scope .foldy-move-to-folder') || !layout.folders.length) return;
    const title = '폴더로 이동';
    const button = kind === 'prompt' ? document.createElement('span') : createIconButton('fa-folder-open', title, 'foldy-move-to-folder');
    if (kind === 'prompt') {
        button.className = 'fa-solid fa-folder-open foldy-move-to-folder';
        button.title = title;
        button.setAttribute('aria-label', title);
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
    parent.querySelector(`.foldy-toolbar[data-foldy-toolbar="${key}"]`)?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'foldy-toolbar';
    toolbar.dataset.foldyToolbar = key;
    if (onCreate) {
        const create = createLabeledIconButton('fa-folder-plus', '새 폴더', '새 폴더', 'foldy-create-folder');
        create.addEventListener('click', onCreate);
        toolbar.append(create);
    }
    toolbar.append(...extra);
    parent.prepend(toolbar);
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function safeFilePart(value) {
    return String(value || 'current')
        .replace(/[<>:"/\\|?*\x00-\x1F\x7F]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'current';
}

function downloadJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

function bundleFilename(name) {
    return `${safeFilePart(name)}.json`;
}

async function readJsonFile() {
    return await new Promise(resolve => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        input.addEventListener('cancel', () => settle(null), { once: true });
        input.addEventListener('change', async () => {
            const file = input.files?.[0];
            if (!file) {
                settle(null);
                return;
            }
            try {
                settle(JSON.parse(await file.text()));
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] Failed to read bundle`, error);
                debugLog('error', '번들 파일 읽기 실패', error);
                toastr.error('Foldy 번들을 읽을 수 없습니다.');
                settle(null);
            }
        }, { once: true });
        input.click();
    });
}

function assertBundle(bundle, scope) {
    if (![BUNDLE_KIND, LEGACY_BUNDLE_KIND].includes(bundle?.kind) || bundle?.scope !== scope) {
        toastr.error('현재 항목에 맞는 Foldy 번들이 아닙니다.');
        return false;
    }
    if (bundle.version > BUNDLE_VERSION) {
        toastr.error('이 Foldy 번들은 더 새로운 버전에서 만들어졌습니다.');
        return false;
    }
    if (bundle.version !== BUNDLE_VERSION) {
        toastr.error('지원하지 않는 Foldy 번들 버전입니다.');
        return false;
    }
    return true;
}

function nameKey(value) {
    return String(value || '').trim().toLocaleLowerCase();
}

function remapImportedLayout(layout, itemIdMap) {
    const rootedFolderIds = new Set((layout?.root || [])
        .filter(node => node?.type === 'folder')
        .map(node => node.id));
    const sourceFolders = (layout?.folders || []).filter(folder => rootedFolderIds.has(folder.id));
    const folderIdMap = new Map(sourceFolders.map(folder => [folder.id, generateUUID()]));
    return {
        version: FOLDY_VERSION,
        root: (layout?.root || []).map(node => {
            if (node.type === 'folder') return { type: 'folder', id: folderIdMap.get(node.id) };
            return { type: 'item', id: itemIdMap.get(String(node.id)) };
        }).filter(node => node.id),
        folders: sourceFolders.map(folder => ({
            ...folder,
            id: folderIdMap.get(folder.id),
            items: (folder.items || []).map(id => itemIdMap.get(String(id))).filter(Boolean),
        })).filter(folder => folder.id),
    };
}

function removeItemsFromLayout(layout, itemIds) {
    const ids = new Set(itemIds);
    return {
        version: FOLDY_VERSION,
        root: (layout.root || []).filter(node => node.type !== 'item' || !ids.has(String(node.id))),
        folders: (layout.folders || []).map(folder => ({
            ...folder,
            items: (folder.items || []).filter(id => !ids.has(String(id))),
        })),
    };
}

function mergeImportedLayout(currentLayout, importedLayout, allIds) {
    const importedIds = flattenLayout(importedLayout);
    const baseLayout = removeItemsFromLayout(currentLayout, importedIds);
    return normalizeLayout({
        version: FOLDY_VERSION,
        root: [...importedLayout.root, ...baseLayout.root],
        folders: [...importedLayout.folders, ...baseLayout.folders],
    }, allIds);
}

function createBundleButtons(onExport, onImport) {
    const importButton = createIconCodeButton('f2f6', '번들 불러오기', 'bundle-button');
    const exportButton = createIconCodeButton('f2f5', '번들 내보내기', 'bundle-button');
    exportButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await onExport();
    });
    importButton.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        await onImport();
    });
    return [importButton, exportButton];
}

function createCollapseButtons(kind, owner, getLayout, onChange) {
    const expandAll = createIconButton('fa-folder-open', '모두 펼치기', 'expand-all');
    const collapseAll = createIconButton('fa-folder', '모두 접기', 'collapse-all');
    collapseAll.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const layout = getLayout();
        const collapsed = ownerCollapsed(kind, owner);
        for (const folder of layout.folders) collapsed.add(folder.id);
        saveCollapsed(kind, owner, collapsed);
        await onChange();
    });
    expandAll.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const collapsed = ownerCollapsed(kind, owner);
        collapsed.clear();
        saveCollapsed(kind, owner, collapsed);
        await onChange();
    });
    return [expandAll, collapseAll];
}

function createLoreCollapseButtons() {
    const setAll = async collapsedValue => {
        const name = selectedLorebookName();
        if (!name) return;
        const data = await loadWorldInfo(name);
        const allIds = Object.values(data?.entries || {})
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        const collapsed = ownerCollapsed('lore', name);
        collapsed.clear();
        if (collapsedValue) {
            for (const folder of layout.folders) collapsed.add(folder.id);
        }
        saveCollapsed('lore', name, collapsed);
        queueLoreRender();
    };
    const expandAll = createIconButton('fa-folder-open', '모두 펼치기', 'foldy-lore-expand-all');
    const collapseAll = createIconButton('fa-folder', '모두 접기', 'foldy-lore-collapse-all');
    collapseAll.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setAll(true);
    });
    expandAll.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        setAll(false);
    });
    return [expandAll, collapseAll];
}

function promptOrderIds(manager = promptManager) {
    return manager.getPromptOrderForCharacter(manager.activeCharacter).map(entry => String(entry.identifier));
}

function readPromptLayout(manager = promptManager, normalizeOptions = {}) {
    const owner = promptOwnerKey();
    const raw = settings().layouts.prompts[owner];
    return { owner, layout: normalizeLayout(raw, promptOrderIds(manager), normalizeOptions) };
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

function ensurePromptOrder(manager = promptManager) {
    if (!manager.activeCharacter) return [];
    manager.serviceSettings.prompt_order ??= [];
    const list = manager.serviceSettings.prompt_order.find(value => String(value.character_id) === String(manager.activeCharacter.id));
    if (list) return list.order;
    let order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    if (!order.length) {
        manager.addPromptOrderForCharacter(manager.activeCharacter, []);
        order = manager.getPromptOrderForCharacter(manager.activeCharacter);
    }
    return order;
}

async function requestPromptExportMode() {
    const form = document.createElement('div');
    form.className = 'foldy-export-form';

    const title = document.createElement('div');
    title.className = 'foldy-edit-title';
    title.textContent = '프롬프트 내보내기';

    const full = document.createElement('label');
    full.className = 'checkbox flex-container';
    const fullInput = document.createElement('input');
    fullInput.type = 'radio';
    fullInput.name = 'foldy_prompt_export_mode';
    fullInput.value = 'full';
    fullInput.checked = true;
    const fullText = document.createElement('span');
    fullText.textContent = '프리셋 내용과 폴더 구조';
    full.append(fullInput, fullText);

    const layoutOnly = document.createElement('label');
    layoutOnly.className = 'checkbox flex-container';
    const layoutInput = document.createElement('input');
    layoutInput.type = 'radio';
    layoutInput.name = 'foldy_prompt_export_mode';
    layoutInput.value = 'layout';
    const layoutText = document.createElement('span');
    layoutText.textContent = '폴더 구조만';
    layoutOnly.append(layoutInput, layoutText);

    const hint = document.createElement('div');
    hint.className = 'foldy-export-hint';
    hint.textContent = '구조만 내보내면 불러올 때 현재 프리셋의 프롬프트 내용은 그대로 두고 폴더 배치만 적용합니다.';

    form.append(title, full, layoutOnly, hint);
    const result = await new Popup(form, POPUP_TYPE.CONFIRM, '', {
        okButton: '내보내기',
        cancelButton: '취소',
    }).show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return null;
    return form.querySelector('input[name="foldy_prompt_export_mode"]:checked')?.value || 'full';
}

function promptLayoutRefs(manager, ids) {
    const promptById = new Map((manager.serviceSettings.prompts || [])
        .filter(prompt => prompt?.identifier)
        .map(prompt => [String(prompt.identifier), prompt]));
    return ids.map(id => ({
        id,
        name: promptById.get(id)?.name || '',
    }));
}

function promptLayoutOnlyBundle(bundle) {
    return bundle?.contents === 'layout'
        || (Array.isArray(bundle?.promptRefs) && !Array.isArray(bundle?.prompts) && !Array.isArray(bundle?.promptOrder));
}

async function importPromptLayoutBundle(bundle, manager = promptManager) {
    if (!bundle?.layout) {
        toastr.error('Foldy 프롬프트 구조 번들에 폴더 구조가 없습니다.');
        return;
    }
    const currentPreset = promptExportName();
    const sourcePreset = promptBundlePresetName(bundle) || '알 수 없는 프리셋';
    const confirmed = await Popup.show.confirm(
        '프롬프트 폴더 구조 불러오기',
        `"${sourcePreset}"의 폴더 구조를 현재 프리셋 "${currentPreset}"에 적용할까요? 프롬프트 내용은 바뀌지 않습니다.`,
    );
    if (!confirmed) return;

    const currentPrompts = manager.serviceSettings.prompts || [];
    const currentIds = promptOrderIds(manager);
    const currentById = new Map(currentPrompts
        .filter(prompt => prompt?.identifier)
        .map(prompt => [String(prompt.identifier), prompt]));
    const currentByName = new Map(currentPrompts
        .filter(prompt => prompt?.name && prompt?.identifier)
        .map(prompt => [nameKey(prompt.name), prompt]));
    const refsById = new Map((bundle.promptRefs || [])
        .filter(ref => ref?.id)
        .map(ref => [String(ref.id), ref]));
    const idMap = new Map();
    for (const sourceId of flattenLayout(bundle.layout)) {
        const ref = refsById.get(String(sourceId));
        const direct = currentById.get(String(sourceId));
        const byName = ref?.name ? currentByName.get(nameKey(ref.name)) : null;
        const target = direct || byName;
        if (target?.identifier) idMap.set(String(sourceId), String(target.identifier));
    }

    const currentLayout = normalizeLayout(null, currentIds);
    const importedLayout = remapImportedLayout(bundle.layout, idMap);
    const layout = mergeImportedLayout(currentLayout, importedLayout, currentIds);
    const owner = promptOwnerKey();
    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    await persistPromptLayout(owner, layout, manager);
    manager.render(false);
    toastr.success('Foldy 프롬프트 폴더 구조를 불러왔습니다.');
}

async function exportPromptBundle(manager = promptManager) {
    const owner = promptOwnerKey();
    const layout = currentPromptLayout
        ? normalizeLayout(currentPromptLayout, promptOrderIds(manager), { preserveUnrootedFolders: false })
        : readPromptLayout(manager, { preserveUnrootedFolders: false }).layout;
    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    const presetManager = promptPresetManager();
    const presetName = promptExportName();
    const ids = new Set(flattenLayout(layout));
    const mode = await requestPromptExportMode();
    if (!mode) return;

    if (mode === 'layout') {
        downloadJson({
            kind: BUNDLE_KIND,
            version: BUNDLE_VERSION,
            scope: 'prompts',
            contents: 'layout',
            owner,
            presetName,
            layout: cloneJson(layout),
            promptRefs: promptLayoutRefs(manager, [...ids]),
        }, bundleFilename(`${presetName}-folders`));
        toastr.success('Foldy 프롬프트 폴더 구조를 내보냈습니다.');
        return;
    }

    const prompts = (manager.serviceSettings.prompts || [])
        .filter(prompt => prompt?.identifier && ids.has(String(prompt.identifier)))
        .map(cloneJson);
    const promptOrder = manager.getPromptOrderForCharacter(manager.activeCharacter)
        .filter(entry => ids.has(String(entry.identifier)))
        .map(cloneJson);

    downloadJson({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope: 'prompts',
        owner,
        presetName,
        presetSettings: cloneJson(presetManager?.getPresetSettings?.(presetName) || {}),
        layout: cloneJson(layout),
        prompts,
        promptOrder,
    }, bundleFilename(presetName));
    toastr.success('Foldy 프롬프트 번들을 내보냈습니다.');
}

async function importPromptBundle(manager = promptManager) {
    const bundle = await readJsonFile();
    if (!bundle || !assertBundle(bundle, 'prompts')) return;
    if (promptLayoutOnlyBundle(bundle)) {
        await importPromptLayoutBundle(bundle, manager);
        return;
    }
    if (!Array.isArray(bundle.prompts) || !Array.isArray(bundle.promptOrder)) {
        toastr.error('Foldy 프롬프트 번들에 프롬프트 데이터가 없습니다.');
        return;
    }
    const presetManager = promptPresetManager();
    const presetName = promptBundlePresetName(bundle);
    if (!presetName) {
        toastr.error('Foldy 프롬프트 번들에 프리셋 이름이 없습니다.');
        return;
    }
    const exists = presetManager?.getAllPresets?.().includes(presetName);
    const confirmed = await Popup.show.confirm('프롬프트 번들 불러오기', exists
        ? `기존 프롬프트 프리셋 "${presetName}"을 이 Foldy 번들로 덮어쓸까요?`
        : `이 Foldy 번들로 새 프롬프트 프리셋 "${presetName}"을 만들까요?`);
    if (!confirmed) return;

    const presetSettings = cloneJson(bundle.presetSettings || presetManager?.getPresetSettings?.(presetName) || {});
    await presetManager.savePreset(presetName, presetSettings);
    const presetValue = presetManager.findPreset(presetName);
    if (presetValue !== undefined) presetManager.selectPreset(presetValue);
    await waitUntilCondition(() => presetManager.getSelectedPresetName() === presetName, 5000, 100);

    const importedPrompts = bundle.prompts.filter(prompt => prompt?.identifier);
    const currentPrompts = exists ? (manager.serviceSettings.prompts || []) : [];
    const promptsById = new Map(currentPrompts
        .filter(prompt => prompt?.identifier)
        .map(prompt => [String(prompt.identifier), prompt]));
    const promptsByName = new Map(currentPrompts
        .filter(prompt => prompt?.name)
        .map(prompt => [nameKey(prompt.name), prompt]));
    const usedIds = new Set(promptsById.keys());
    const idMap = new Map();
    importedPrompts.forEach(prompt => {
        const imported = cloneJson(prompt);
        const existing = promptsByName.get(nameKey(imported.name));
        const sourceId = String(imported.identifier);
        if (existing) {
            imported.identifier = existing.identifier;
        } else if (!imported.identifier || usedIds.has(String(imported.identifier))) {
            imported.identifier = generateUUID();
        }
        const targetId = String(imported.identifier);
        idMap.set(sourceId, targetId);
        usedIds.add(targetId);
        promptsById.set(targetId, imported);
    });
    manager.setPrompts([...promptsById.values()]);

    const owner = promptOwnerKeyForName(presetName);
    const currentIds = exists ? promptOrderIds(manager) : [];
    // Imports may reuse existing prompts, but the Foldy layout itself comes from the bundle.
    const currentLayout = normalizeLayout(null, currentIds);
    const importedLayout = remapImportedLayout(bundle.layout, idMap);
    const allIds = [...new Set([...currentIds, ...idMap.values()])];
    const layout = mergeImportedLayout(currentLayout, importedLayout, allIds);
    const orderById = new Map(bundle.promptOrder.map(entry => {
        const targetId = idMap.get(String(entry.identifier));
        return targetId ? [targetId, { ...cloneJson(entry), identifier: targetId }] : null;
    }).filter(Boolean));
    const order = ensurePromptOrder(manager);
    const existingOrderById = new Map(exists ? order.map(entry => [String(entry.identifier), entry]) : []);
    order.splice(0, order.length, ...flattenLayout(layout).map(id => orderById.get(id) ?? existingOrderById.get(id) ?? { identifier: id, enabled: true }));

    settings().layouts.prompts[owner] = layout;
    currentPromptLayout = layout;
    saveSettingsDebounced();
    await manager.saveServiceSettings();
    manager.render(false);
    toastr.success('Foldy 프롬프트 번들을 불러왔습니다.');
}

function promptLayoutFromDom(list, sourceLayout, { preserveFolderIds = new Set(), normalizeOptions = {} } = {}) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    const seenPreservedFolders = new Set();

    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const source = folderSource.get(id);
            if (!source) continue;
            const items = preserveFolderIds.has(id)
                ? [...source.items]
                : [...element.querySelector('.foldy-folder-items').children]
                    .map(item => item.dataset.pmIdentifier)
                    .filter(Boolean);
            folders.push({ ...source, items });
            root.push({ type: 'folder', id });
            if (preserveFolderIds.has(id)) seenPreservedFolders.add(id);
        } else if (element.dataset.pmIdentifier) {
            root.push({ type: 'item', id: element.dataset.pmIdentifier });
        }
    }

    if ([...preserveFolderIds].some(id => !seenPreservedFolders.has(id))) {
        return normalizeLayout(sourceLayout, promptOrderIds(), normalizeOptions);
    }

    return normalizeLayout({ version: 1, root, folders }, promptOrderIds(), normalizeOptions);
}

function setupPromptSortables(manager) {
    const list = manager.listElement;
    if (!list?.classList.contains('foldy-prompt-root')) return;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.foldy-prompt-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    let saving = false;
    const saveFromDom = async ({ preserveFolderIds = new Set() } = {}) => {
        if (saving) return;
        saving = true;
        try {
            const preservedFolders = new Map(currentPromptLayout.folders
                .filter(folder => preserveFolderIds.has(folder.id))
                .map(folder => [folder.id, folder]));
            list.querySelectorAll('.foldy-folder').forEach(element => {
                const preserved = preservedFolders.get(element.dataset.foldyId);
                if (!preserved) {
                    updateFolderCount(element);
                    return;
                }
                const countElement = element.querySelector('.foldy-folder-count');
                if (countElement) countElement.textContent = String(preserved.items.length);
            });
            const next = promptLayoutFromDom(list, currentPromptLayout, { preserveFolderIds });
            await persistPromptLayout(promptOwnerKey(), next, manager);
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save prompt folder order`, error);
            debugLog('error', '프롬프트 폴더 순서 저장 실패', error);
            toastr.error('프롬프트 폴더 순서를 저장하지 못했습니다.');
            manager.render(false);
        } finally {
            saving = false;
        }
    };

    let lastPointer = null;
    let lastFolderElement = null;
    let draggingPromptIntoFolder = false;
    let draggingFolderId = null;
    const clearFolderDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        draggingPromptIntoFolder = false;
        draggingFolderId = null;
        list.classList.remove('foldy-dropping-into-folder');
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
    };
    const rememberPointer = (event, ui) => {
        if (!draggingPromptIntoFolder) {
            lastFolderElement = null;
            list.classList.remove('foldy-dropping-into-folder');
            list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.foldy-prompt-folder'))
            .find(Boolean);
        lastFolderElement = pointedFolder ?? null;
        list.classList.toggle('foldy-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
        pointedFolder?.classList.add('foldy-drop-target');
        const placeholder = ui?.placeholder?.[0];
        const items = pointedFolder?.querySelector?.('.foldy-prompt-items');
        if (placeholder && items && !items.contains(placeholder)) items.append(placeholder);
    };
    const movePromptIntoPointedFolder = item => {
        if (!item?.classList?.contains('completion_prompt_manager_prompt_draggable') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.foldy-prompt-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.foldy-prompt-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
    };
    const afterPromptSort = task => {
        setTimeout(() => {
            task().catch(error => {
                console.error(`[${EXTENSION_NAME}] Failed to finish prompt folder sort`, error);
                debugLog('error', '프롬프트 폴더 정렬 완료 처리 실패', error);
                toastr.error('프롬프트 폴더 순서를 저장하지 못했습니다.');
                manager.render(false);
            });
        }, 0);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> .completion_prompt_manager_prompt_draggable, > .foldy-folder',
        placeholder: 'foldy-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: (_, ui) => {
            const item = ui.item?.[0];
            sortingPrompt = true;
            draggingPromptIntoFolder = item?.classList?.contains('completion_prompt_manager_prompt_draggable') ?? false;
            draggingFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
        },
        sort: rememberPointer,
        stop: (_, ui) => {
            afterPromptSort(async () => {
                try {
                    const item = ui.item?.[0];
                    if (draggingFolderId && item?.parentElement !== list) {
                        manager.render(false);
                        return;
                    }
                    const preserveFolderIds = item?.classList?.contains('foldy-folder')
                        ? new Set([item.dataset.foldyId].filter(Boolean))
                        : new Set();
                    movePromptIntoPointedFolder(item);
                    await saveFromDom({ preserveFolderIds });
                } finally {
                    sortingPrompt = false;
                    clearFolderDropState();
                }
            });
        },
    });
    list.querySelectorAll('.foldy-prompt-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> .completion_prompt_manager_prompt_draggable',
            connectWith: '#completion_prompt_manager_list, .foldy-prompt-items',
            placeholder: 'foldy-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: (_, ui) => {
                const item = ui.item?.[0];
                sortingPrompt = true;
                draggingPromptIntoFolder = item?.classList?.contains('completion_prompt_manager_prompt_draggable') ?? false;
                draggingFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('foldy-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => {
                afterPromptSort(async () => {
                    try {
                        const item = ui.item?.[0];
                        if (item?.classList?.contains('foldy-folder')) {
                            manager.render(false);
                            return;
                        }
                        const preserveFolderIds = item?.classList?.contains('foldy-folder')
                            ? new Set([item.dataset.foldyId].filter(Boolean))
                            : new Set();
                        movePromptIntoPointedFolder(item);
                        await saveFromDom({ preserveFolderIds });
                    } finally {
                        sortingPrompt = false;
                        clearFolderDropState();
                    }
                });
            },
        });
    });
}

async function enhancePromptList(manager) {
    const list = manager.listElement;
    if (!list || !featureEnabled('prompts')) return;
    const { owner, layout } = readPromptLayout(manager);
    currentPromptLayout = layout;
    list.classList.add('foldy-prompt-root');

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
        if (values.applyStyleToAll) applyFolderStyleToAll(currentPromptLayout, folder.id, values);
        delete values.applyStyleToAll;
        Object.assign(folder, values);
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    };
    const onDelete = async id => {
        const folder = currentPromptLayout.folders.find(value => value.id === id);
        if (!folder || !await Popup.show.confirm('폴더 삭제', `"${folder.name}" 폴더를 삭제하고 안의 프롬프트는 최상위로 옮길까요?`)) return;
        removeFolder(currentPromptLayout, id);
        currentPromptLayout = normalizeLayout(currentPromptLayout, promptOrderIds(manager), { preserveUnrootedFolders: false });
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
        const items = folderElement.querySelector('.foldy-folder-items');
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
        const promptsById = new Map((manager.serviceSettings.prompts || [])
            .filter(prompt => prompt?.identifier)
            .map(prompt => [String(prompt.identifier), prompt]));
        const candidates = rootItemIds(currentPromptLayout).map(id => ({
            id,
            label: promptsById.get(id)?.name || id,
        }));
        const values = await requestNewFolder(currentPromptLayout, candidates);
        if (!values) return;
        const folder = addFolderWithItems(currentPromptLayout, values.name, values.itemIds);
        collapseNewFolder('prompt', owner, folder.id);
        await persistPromptLayout(owner, currentPromptLayout, manager);
        rerender();
    }, [
        ...createCollapseButtons('prompt', owner, () => currentPromptLayout, async () => rerender()),
        ...createBundleButtons(() => exportPromptBundle(manager), () => importPromptBundle(manager)),
    ]);
}

async function installPromptIntegration() {
    await waitUntilCondition(() => promptManager && promptPresetManager(), 30000, 100);
    const manager = promptManager;
    if (!originalPromptRenderItems) originalPromptRenderItems = manager.renderPromptManagerListItems.bind(manager);
    if (!originalPromptMakeDraggable) originalPromptMakeDraggable = manager.makeDraggable.bind(manager);
    if (manager.__foldyInstalled) return;
    manager.__foldyInstalled = true;

    manager.renderPromptManagerListItems = async function (...args) {
        await originalPromptRenderItems.apply(this, args);
        if (featureEnabled('prompts')) await enhancePromptList(manager);
    };
    manager.makeDraggable = function (...args) {
        const result = originalPromptMakeDraggable.apply(this, args);
        if (featureEnabled('prompts')) setupPromptSortables(manager);
        return result;
    };
    manager.render(false);
}

function loreLayoutFromDom(list, sourceLayout, allIds) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const root = [];
    const folders = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const source = folderSource.get(id);
            if (!source) continue;
            const renderedItems = [...element.querySelector('.foldy-folder-items').children]
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

function loreEntryLabel(entry) {
    if (!entry) return '';
    const comment = String(entry.comment || '').trim();
    if (comment) return comment;
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    if (keys) return keys;
    const content = String(entry.content || '').trim().replace(/\s+/g, ' ');
    if (content) return content.slice(0, 80);
    return `UID ${entry.uid}`;
}

async function persistLoreLayout(owner, layout) {
    settings().layouts.lorebooks[owner] = layout;
    saveSettingsDebounced();
}

async function createLorebookFolder() {
    if (!featureEnabled('lorebooks')) return;
    const name = selectedLorebookName();
    if (!name) {
        toastr.warning('먼저 로어북을 선택해 주세요.');
        return;
    }

    const data = await loadWorldInfo(name);
    if (!data?.entries) return;
    const allIds = Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
    const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
    const entriesById = new Map(Object.values(data.entries)
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => [String(entry.uid), entry]));
    const candidates = rootItemIds(layout)
        .map(id => entriesById.get(id))
        .filter(Boolean)
        .map(entry => ({ id: String(entry.uid), label: loreEntryLabel(entry) }));
    const values = await requestNewFolder(layout, candidates);
    if (!values) return;

    const folder = addFolderWithItems(layout, values.name, values.itemIds);
    collapseNewFolder('lore', name, folder.id);
    await persistLoreLayout(name, layout);

    const sort = document.getElementById('world_info_sort_order');
    if (sort && sort.value !== LORE_SORT_VALUE) {
        sort.value = LORE_SORT_VALUE;
        accountStorage.setItem(SORT_ORDER_KEY, LORE_SORT_VALUE);
    }
    queueLoreRender();
}

function loreEntryIds(data) {
    return Object.values(data?.entries || {})
        .filter(entry => entry && typeof entry === 'object')
        .map(entry => String(entry.uid));
}

async function exportLorebookBundle() {
    const name = selectedLorebookName();
    if (!name) {
        toastr.warning('먼저 로어북을 선택해 주세요.');
        return;
    }
    const data = await loadWorldInfo(name);
    const layout = normalizeLayout(settings().layouts.lorebooks[name], loreEntryIds(data));
    settings().layouts.lorebooks[name] = layout;
    saveSettingsDebounced();

    downloadJson({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope: 'lorebooks',
        owner: name,
        layout: cloneJson(layout),
        data: cloneJson(data),
    }, bundleFilename(name));
    toastr.success('Foldy 로어북 번들을 내보냈습니다.');
}

async function importLorebookBundle() {
    const bundle = await readJsonFile();
    if (!bundle || !assertBundle(bundle, 'lorebooks')) return;
    if (!bundle.data?.entries) {
        toastr.error('Foldy 로어북 번들에 로어북 데이터가 없습니다.');
        return;
    }
    const name = String(bundle.owner || bundle.data.name || selectedLorebookName() || '').trim();
    if (!name) {
        toastr.warning('Foldy 로어북 번들에 로어북 이름이 없습니다.');
        return;
    }
    const exists = world_names.includes(name);
    const confirmed = await Popup.show.confirm('로어북 번들 불러오기', exists
        ? `기존 로어북 "${name}"을 이 Foldy 번들로 덮어쓸까요?`
        : `이 Foldy 번들로 새 로어북 "${name}"을 만들까요?`);
    if (!confirmed) return;

    const data = cloneJson(bundle.data);
    const layout = normalizeLayout(bundle.layout, loreEntryIds(data));
    await saveWorldInfo(name, data, true);
    settings().layouts.lorebooks[name] = layout;
    saveSettingsDebounced();
    await updateWorldInfoList();
    const index = world_names.indexOf(name);
    if (index >= 0) $('#world_editor_select').val(index).trigger('change');
    await reloadEditor(name, true);
    if (document.getElementById('world_info_sort_order')?.value === LORE_SORT_VALUE) queueLoreRender();
    toastr.success('Foldy 로어북 번들을 불러왔습니다.');
}

async function createLorebookEntryInFolderOrder() {
    if (handlingLoreAction) return;
    if (!featureEnabled('lorebooks')) return;
    handlingLoreAction = true;
    try {
        const name = selectedLorebookName();
        if (!name) return;
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;

        const entry = createWorldInfoEntry(name, data);
        if (!entry) return;
        syncLoreOriginalEntry(data, entry);

        const allIds = Object.values(data.entries)
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        const entryId = String(entry.uid);
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === entryId));
        for (const folder of layout.folders) {
            folder.items = folder.items.filter(id => id !== entryId);
        }
        layout.root.unshift({ type: 'item', id: entryId });

        await persistLoreLayout(name, layout);
        await saveWorldInfo(name, data, true);
        queueLoreRender();
    } finally {
        handlingLoreAction = false;
    }
}

function syncLoreOriginalEntry(data, entry) {
    if (!data?.originalData || !Array.isArray(data.originalData.entries) || !entry) return;
    const uid = Number(entry.uid);
    const existing = data.originalData.entries.find(value => value.uid === uid || value.id === uid);
    const original = existing ?? { uid, id: uid };
    // FRAGILE: mirrors SillyTavern World Info originalData entry shape used by world-info.js.
    original.uid = uid;
    original.id = uid;
    original.keys = Array.isArray(entry.key) ? [...entry.key] : [];
    original.secondary_keys = Array.isArray(entry.keysecondary) ? [...entry.keysecondary] : [];
    original.comment = entry.comment ?? '';
    original.content = entry.content ?? '';
    original.constant = !!entry.constant;
    original.selective = !!entry.selective;
    original.selectiveLogic = entry.selectiveLogic;
    original.insertion_order = Number(entry.order) || 0;
    original.enabled = !entry.disable;
    original.position = entry.position === 0 ? 'before_char' : 'after_char';
    original.extensions ??= {};
    original.extensions.display_index = entry.displayIndex ?? entry.uid;
    original.extensions.position = entry.position;
    original.extensions.role = entry.role;
    original.extensions.depth = entry.depth;
    original.extensions.probability = entry.probability;
    original.extensions.useProbability = entry.useProbability;
    original.extensions.exclude_recursion = entry.excludeRecursion;
    original.extensions.prevent_recursion = entry.preventRecursion;
    original.extensions.delay_until_recursion = entry.delayUntilRecursion;
    original.extensions.match_whole_words = entry.matchWholeWords;
    original.extensions.use_group_scoring = entry.useGroupScoring;
    original.extensions.case_sensitive = entry.caseSensitive;
    original.extensions.scan_depth = entry.scanDepth;
    original.extensions.automation_id = entry.automationId;
    original.extensions.vectorized = entry.vectorized;
    original.extensions.outlet_name = entry.outletName;
    original.extensions.group = entry.group;
    original.extensions.group_override = entry.groupOverride;
    original.extensions.group_weight = entry.groupWeight;
    original.extensions.triggers = Array.isArray(entry.triggers) ? [...entry.triggers] : [];
    original.extensions.ignore_budget = entry.ignoreBudget;
    if (!existing) data.originalData.entries.push(original);
}

async function deleteLorebookEntryInFolderOrder(uid) {
    if (handlingLoreAction) return;
    if (!featureEnabled('lorebooks')) return;
    handlingLoreAction = true;
    try {
        const name = selectedLorebookName();
        if (!name) return;
        const data = await loadWorldInfo(name);
        if (!data?.entries) return;

        const entryId = String(uid);
        const deleted = await deleteWorldInfoEntry(data, entryId);
        if (!deleted) return;
        deleteWIOriginalDataValue(data, entryId);

        const allIds = Object.values(data.entries)
            .filter(value => value && typeof value === 'object')
            .map(value => String(value.uid));
        const layout = normalizeLayout(settings().layouts.lorebooks[name], allIds);
        layout.root = layout.root.filter(node => !(node.type === 'item' && node.id === entryId));
        for (const folder of layout.folders) {
            folder.items = folder.items.filter(id => id !== entryId);
        }

        await persistLoreLayout(name, layout);
        await saveWorldInfo(name, data, true);
        queueLoreRender();
    } finally {
        handlingLoreAction = false;
    }
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
    list.querySelectorAll('.foldy-lore-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    const allIds = Object.keys(data.entries);
    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        if (renderingLorebook) {
            queueLoreRender();
            return;
        }
        saving = true;
        try {
            list.querySelectorAll('.foldy-folder').forEach(updateFolderCount);
            const next = loreLayoutFromDom(list, layout, allIds);
            Object.assign(layout, next);
            await persistLoreLayout(name, layout);
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save lorebook folder order`, error);
            debugLog('error', '로어북 폴더 순서 저장 실패', error);
            toastr.error('로어북 폴더 순서를 저장하지 못했습니다.');
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
    let draggingLoreIntoFolder = false;
    let draggingLoreFolderId = null;
    const clearLoreDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        draggingLoreIntoFolder = false;
        draggingLoreFolderId = null;
        list.classList.remove('foldy-dropping-into-folder');
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
    };
    const rememberPointer = event => {
        if (!draggingLoreIntoFolder) {
            lastFolderElement = null;
            list.classList.remove('foldy-dropping-into-folder');
            list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.foldy-lore-folder'))
            .find(Boolean);
        lastFolderElement = pointedFolder ?? null;
        list.classList.toggle('foldy-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
        pointedFolder?.classList.add('foldy-drop-target');
    };
    const moveLoreIntoPointedFolder = item => {
        if (!item?.hasAttribute?.('uid') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.foldy-lore-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.foldy-lore-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
        return folderElement.dataset.foldyId;
    };
    const afterLoreSort = task => {
        setTimeout(() => {
            task().catch(error => {
                console.error(`[${EXTENSION_NAME}] Failed to finish lorebook folder sort`, error);
                debugLog('error', '로어북 폴더 정렬 완료 처리 실패', error);
                toastr.error('로어북 폴더 순서를 저장하지 못했습니다.');
                queueLoreRender();
            });
        }, 0);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> [uid], > .foldy-folder',
        placeholder: 'foldy-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: (_, ui) => {
            const item = ui.item?.[0];
            sortingLore = true;
            draggingLoreIntoFolder = item?.hasAttribute?.('uid') ?? false;
            draggingLoreFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
        },
        sort: rememberPointer,
        stop: (_, ui) => {
            afterLoreSort(async () => {
                try {
                    const item = ui.item?.[0];
                    if (draggingLoreFolderId && item?.parentElement !== list) {
                        queueLoreRender();
                        return;
                    }
                    const folderId = moveLoreIntoPointedFolder(item);
                    if (folderId) await moveItemInLayout(String(item.getAttribute('uid')), folderId);
                    else await saveFromDom();
                } finally {
                    sortingLore = false;
                    clearLoreDropState();
                }
            });
        },
    });
    list.querySelectorAll('.foldy-lore-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> [uid]',
            connectWith: '#world_popup_entries_list, .foldy-lore-items',
            placeholder: 'foldy-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: (_, ui) => {
                const item = ui.item?.[0];
                sortingLore = true;
                draggingLoreIntoFolder = item?.hasAttribute?.('uid') ?? false;
                draggingLoreFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('foldy-folder')) $(ui.sender).sortable('cancel');
            },
            stop: (_, ui) => {
                afterLoreSort(async () => {
                    try {
                        const item = ui.item?.[0];
                        if (item?.classList?.contains('foldy-folder')) {
                            queueLoreRender();
                            return;
                        }
                        const folderId = moveLoreIntoPointedFolder(item);
                        if (folderId) await moveItemInLayout(String(item.getAttribute('uid')), folderId);
                        else await saveFromDom();
                    } finally {
                        sortingLore = false;
                        clearLoreDropState();
                    }
                });
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
        list.classList.add('foldy-lore-root');
        list.classList.toggle('foldy-searching', Boolean(query));
        $('#world_info_pagination').empty();
        const headers = await renderTemplateAsync('worldInfoKeywordHeaders');
        list.insertAdjacentHTML('beforeend', headers);

        const rerender = () => queueLoreRender();
        const onEdit = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder) return;
            const values = await requestFolderSettings(layout, folder);
            if (!values) return;
            if (values.applyStyleToAll) applyFolderStyleToAll(layout, folder.id, values);
            delete values.applyStyleToAll;
            Object.assign(folder, values);
            await persistLoreLayout(name, layout);
            rerender();
        };
        const onDelete = async id => {
            const folder = layout.folders.find(value => value.id === id);
            if (!folder || !await Popup.show.confirm('폴더 삭제', `"${folder.name}" 폴더를 삭제하고 안의 항목은 최상위로 옮길까요?`)) return;
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
            const items = folderElement.querySelector('.foldy-folder-items');
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
            folderElement.querySelector('.foldy-folder-count').textContent = String(folder.items.length);
            list.append(folderElement);
        }

        document.querySelector('#WorldInfo .foldy-toolbar[data-foldy-toolbar="lore"]')?.remove();
        list.querySelectorAll('textarea[name="comment"]').forEach(element => initScrollHeight($(element)));
        if (!query) setupLoreSortables(name, data, layout);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to render lorebook folders`, error);
        debugLog('error', '로어북 폴더 표시 실패', error);
        toastr.error('로어북 폴더를 표시하지 못했습니다.');
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
    setTimeout(async () => {
        loreRenderQueued = false;
        await renderLorebookFolders();
    }, 0);
}

function applyLorebookFeatureState() {
    const enabled = featureEnabled('lorebooks');
    const sort = document.getElementById('world_info_sort_order');
    const option = sort?.querySelector(`option[value="${LORE_SORT_VALUE}"]`);
    if (option) option.disabled = !enabled;
    [
        'foldy_lore_create',
        'foldy_lore_import',
        'foldy_lore_export',
        'foldy_lore_expand_all',
        'foldy_lore_collapse_all',
    ].forEach(id => {
        const element = document.getElementById(id);
        if (!element) return;
        element.hidden = !enabled;
        if (enabled) {
            element.style.removeProperty('display');
        } else {
            element.style.setProperty('display', 'none', 'important');
        }
    });
    if (enabled) return;

    document.querySelector('#WorldInfo .foldy-toolbar[data-foldy-toolbar="lore"]')?.remove();
    document.getElementById('world_popup_entries_list')?.classList.remove('foldy-lore-root', 'foldy-searching');
    if (sort?.value === LORE_SORT_VALUE) {
        sort.value = '0';
        accountStorage.setItem(SORT_ORDER_KEY, '0');
        const name = selectedLorebookName();
        if (name) reloadEditor(name, true);
    }
}

function installLorebookIntegration() {
    const sort = document.getElementById('world_info_sort_order');
    if (!sort) return;
    if (!sort.querySelector(`option[value="${LORE_SORT_VALUE}"]`)) {
        const option = document.createElement('option');
        option.value = LORE_SORT_VALUE;
        option.textContent = '폴더 순서';
        option.dataset.rule = 'custom';
        option.dataset.field = 'displayIndex';
        option.dataset.order = 'asc';
        sort.append(option);
    }
    if (!document.getElementById('foldy_lore_create')) {
        const create = createIconButton('fa-folder-plus', '추가', 'foldy-lore-create');
        create.id = 'foldy_lore_create';
        create.addEventListener('click', createLorebookFolder);
        document.getElementById('world_popup_new')?.after(create);
    }
    if (!document.getElementById('foldy_lore_export')) {
        const [importButton, exportButton] = createBundleButtons(exportLorebookBundle, importLorebookBundle);
        exportButton.id = 'foldy_lore_export';
        importButton.id = 'foldy_lore_import';
        exportButton.classList.add('foldy-lore-bundle');
        importButton.classList.add('foldy-lore-bundle');
        document.getElementById('foldy_lore_create')?.after(importButton, exportButton);
    }
    if (!document.getElementById('foldy_lore_collapse_all')) {
        const [expandAll, collapseAll] = createLoreCollapseButtons();
        collapseAll.id = 'foldy_lore_collapse_all';
        expandAll.id = 'foldy_lore_expand_all';
        document.getElementById('foldy_lore_export')?.after(expandAll, collapseAll);
    }
    applyLorebookFeatureState();
    document.querySelector('#WorldInfo .foldy-toolbar[data-foldy-toolbar="lore"]')?.remove();

    sort.addEventListener('change', event => {
        if (event.target.value !== LORE_SORT_VALUE) {
            const wasFolderOrder = storedLoreSortValue() === LORE_SORT_VALUE;
            document.querySelector('#WorldInfo .foldy-toolbar')?.remove();
            document.getElementById('world_popup_entries_list')?.classList.remove('foldy-lore-root', 'foldy-searching');
            if (wasFolderOrder && featureEnabled('lorebooks')) {
                event.stopImmediatePropagation();
                const value = String(event.target.value);
                if (value !== 'search') accountStorage.setItem(SORT_ORDER_KEY, value);
                const name = selectedLorebookName();
                if (name) reloadEditor(name, true);
            }
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
    document.getElementById('world_popup_new')?.addEventListener('click', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        createLorebookEntryInFolderOrder();
    }, true);
    document.getElementById('world_popup_entries_list')?.addEventListener('click', event => {
        if (sort.value !== LORE_SORT_VALUE || !featureEnabled('lorebooks')) return;
        const button = event.target.closest?.('.delete_entry_button');
        if (!button) return;
        const entry = button.closest?.('.world_entry');
        const uid = entry?.getAttribute('uid');
        if (!uid) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        deleteLorebookEntryInFolderOrder(uid);
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
    $('#world_editor_select').on('change.foldy', () => {
        if (sort.value === LORE_SORT_VALUE) setTimeout(queueLoreRender, 0);
    });
    if (featureEnabled('lorebooks') && storedLoreSortValue() === LORE_SORT_VALUE) {
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
    const reordered = orderItemsByLayout(layout, scripts);
    await saveScriptsByType(reordered, type);
}

async function exportRegexBundle(typeKey) {
    const { owner, layout } = readRegexLayout(typeKey);
    const type = REGEX_TYPES[typeKey].scriptType;
    const scripts = getScriptsByType(type).map(cloneJson);
    downloadJson({
        kind: BUNDLE_KIND,
        version: BUNDLE_VERSION,
        scope: 'regex',
        typeKey,
        owner,
        layout: cloneJson(layout),
        scripts,
    }, bundleFilename(regexExportName(typeKey)));
    toastr.success('Foldy 정규식 번들을 내보냈습니다.');
}

async function importRegexBundle(typeKey) {
    const bundle = await readJsonFile();
    if (!bundle || !assertBundle(bundle, 'regex')) return;
    if (!Array.isArray(bundle.scripts)) {
        toastr.error('Foldy 정규식 번들에 정규식 데이터가 없습니다.');
        return;
    }
    if (bundle.typeKey && bundle.typeKey !== typeKey) {
        toastr.error(`이 번들은 ${REGEX_TYPES[bundle.typeKey]?.label || bundle.typeKey} 정규식 목록용입니다.`);
        return;
    }
    const label = REGEX_TYPES[typeKey].label;
    const confirmed = await Popup.show.confirm('정규식 번들 불러오기', `이 Foldy 번들을 현재 ${label} 정규식 목록으로 불러올까요? 같은 이름의 정규식 스크립트는 대체되고, 나머지는 추가됩니다.`);
    if (!confirmed) return;

    const type = REGEX_TYPES[typeKey].scriptType;
    const owner = regexOwnerKey(typeKey);
    const currentScripts = getScriptsByType(type);
    const scriptsById = new Map(currentScripts
        .filter(script => script?.id)
        .map(script => [String(script.id), script]));
    const scriptsByName = new Map(currentScripts
        .filter(script => script?.scriptName)
        .map(script => [nameKey(script.scriptName), script]));
    const usedIds = new Set(scriptsById.keys());
    const idMap = new Map();
    bundle.scripts.filter(script => script).forEach(script => {
        const imported = cloneJson(script);
        const existing = scriptsByName.get(nameKey(imported.scriptName));
        const sourceId = String(imported.id || generateUUID());
        if (existing) {
            imported.id = existing.id;
        } else if (!imported.id || usedIds.has(String(imported.id))) {
            imported.id = generateUUID();
        }
        const targetId = String(imported.id);
        idMap.set(sourceId, targetId);
        usedIds.add(targetId);
        scriptsById.set(targetId, imported);
    });

    const currentLayout = normalizeLayout(null, currentScripts.map(script => String(script.id)).filter(Boolean));
    const importedLayout = remapImportedLayout(bundle.layout, idMap);
    const allIds = [...new Set([...currentScripts.map(script => String(script.id)).filter(Boolean), ...idMap.values()])];
    const layout = mergeImportedLayout(currentLayout, importedLayout, allIds);
    settings().layouts.regex[typeKey][owner] = layout;
    saveSettingsDebounced();
    const orderedScripts = orderItemsByLayout(layout, [...scriptsById.values()]);
    await saveScriptsByType(orderedScripts, type);
    if (getCurrentChatId()) await reloadCurrentChat();
    enhanceRegexLists();
    toastr.success('Foldy 정규식 번들을 불러왔습니다.');
}

function regexLayoutFromDom(list, sourceLayout, typeKey) {
    const folderSource = new Map(sourceLayout.folders.map(folder => [folder.id, folder]));
    const visibleIds = new Set([...list.querySelectorAll('.regex-script-label')]
        .map(element => element.id)
        .filter(Boolean));
    const root = [];
    const folders = [];
    for (const element of list.children) {
        if (element.classList.contains('foldy-folder')) {
            const id = element.dataset.foldyId;
            const source = folderSource.get(id);
            if (!source) continue;
            const visibleItems = [...element.querySelector('.foldy-folder-items').children]
                .map(item => item.id)
                .filter(Boolean);
            const hiddenItems = source.items.filter(itemId => !visibleIds.has(itemId));
            const items = [...hiddenItems, ...visibleItems];
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
    list.closest('.inline-drawer-content, .regex_settings, #regex_container')?.querySelector('.foldy-toolbar')?.remove();
}

function setupRegexSortable(typeKey, owner, layout) {
    const list = document.querySelector(REGEX_TYPES[typeKey].selector);
    if (!list) return;
    const folderItemsSelector = `.foldy-regex-items[data-foldy-regex-type="${typeKey}"]`;
    const $list = $(list);
    if ($list.sortable('instance')) $list.sortable('destroy');
    list.querySelectorAll('.foldy-regex-items').forEach(element => {
        const $element = $(element);
        if ($element.sortable('instance')) $element.sortable('destroy');
    });

    let saving = false;
    const saveFromDom = async () => {
        if (saving) return;
        saving = true;
        try {
            list.querySelectorAll('.foldy-folder').forEach(updateFolderCount);
            const next = regexLayoutFromDom(list, layout, typeKey);
            Object.assign(layout, next);
            await persistRegexLayout(typeKey, owner, layout);
            if (getCurrentChatId()) await reloadCurrentChat();
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Failed to save regex folder order`, error);
            debugLog('error', '정규식 폴더 순서 저장 실패', error);
            toastr.error('정규식 폴더 순서를 저장하지 못했습니다.');
        } finally {
            saving = false;
        }
    };

    let lastPointer = null;
    let lastFolderElement = null;
    let draggingRegexIntoFolder = false;
    let draggingRegexFolderId = null;
    const clearRegexDropState = () => {
        lastPointer = null;
        lastFolderElement = null;
        draggingRegexIntoFolder = false;
        draggingRegexFolderId = null;
        list.classList.remove('foldy-dropping-into-folder');
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
    };
    const rememberPointer = (event, ui) => {
        if (!draggingRegexIntoFolder) {
            lastFolderElement = null;
            list.classList.remove('foldy-dropping-into-folder');
            list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
            return;
        }
        lastPointer = { x: event.clientX, y: event.clientY };
        const pointedFolder = document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.foldy-regex-folder'))
            .find(Boolean);
        lastFolderElement = pointedFolder ?? null;
        list.classList.toggle('foldy-dropping-into-folder', Boolean(pointedFolder));
        list.querySelectorAll('.foldy-drop-target').forEach(element => element.classList.remove('foldy-drop-target'));
        pointedFolder?.classList.add('foldy-drop-target');
        const placeholder = ui?.placeholder?.[0];
        const items = pointedFolder?.querySelector?.('.foldy-regex-items');
        if (placeholder && items && !items.contains(placeholder)) items.append(placeholder);
    };
    const moveRegexIntoPointedFolder = item => {
        if (!item?.classList?.contains('regex-script-label') || !lastPointer) return;
        const folderElement = lastFolderElement || document.elementsFromPoint(lastPointer.x, lastPointer.y)
            .map(element => element.closest?.('.foldy-regex-folder'))
            .find(Boolean);
        const items = folderElement?.querySelector?.('.foldy-regex-items');
        if (!items || items.contains(item)) return;
        items.append(item);
        updateFolderCount(folderElement);
    };
    const afterRegexSort = task => {
        setTimeout(() => {
            task().catch(error => {
                console.error(`[${EXTENSION_NAME}] Failed to finish regex folder sort`, error);
                debugLog('error', '정규식 폴더 정렬 완료 처리 실패', error);
                toastr.error('정규식 폴더 순서를 저장하지 못했습니다.');
                enhanceRegexLists();
            });
        }, 0);
    };

    $list.sortable({
        delay: getSortableDelay(),
        handle: '.drag-handle',
        items: '> .regex-script-label, > .foldy-folder',
        placeholder: 'foldy-drop-placeholder',
        helper: 'clone',
        appendTo: document.body,
        zIndex: 10000,
        tolerance: 'pointer',
        forcePlaceholderSize: true,
        start: (_, ui) => {
            const item = ui.item?.[0];
            sortingRegex = true;
            draggingRegexIntoFolder = item?.classList?.contains('regex-script-label') ?? false;
            draggingRegexFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
        },
        sort: rememberPointer,
        stop: async (_, ui) => {
            afterRegexSort(async () => {
                try {
                    const item = ui.item?.[0];
                    if (draggingRegexFolderId && item?.parentElement !== list) {
                        enhanceRegexLists();
                        return;
                    }
                    moveRegexIntoPointedFolder(item);
                    await saveFromDom();
                } finally {
                    sortingRegex = false;
                    clearRegexDropState();
                }
            });
        },
    });
    list.querySelectorAll('.foldy-regex-items').forEach(element => {
        $(element).sortable({
            delay: getSortableDelay(),
            handle: '.drag-handle',
            items: '> .regex-script-label',
            connectWith: `${REGEX_TYPES[typeKey].selector}, ${folderItemsSelector}`,
            placeholder: 'foldy-drop-placeholder',
            helper: 'clone',
            appendTo: document.body,
            zIndex: 10000,
            tolerance: 'pointer',
            forcePlaceholderSize: true,
            start: (_, ui) => {
                const item = ui.item?.[0];
                sortingRegex = true;
                draggingRegexIntoFolder = item?.classList?.contains('regex-script-label') ?? false;
                draggingRegexFolderId = item?.classList?.contains('foldy-folder') ? item.dataset.foldyId : null;
            },
            sort: rememberPointer,
            receive: (_, ui) => {
                if (ui.item.hasClass('foldy-folder')) $(ui.sender).sortable('cancel');
            },
            stop: async (_, ui) => {
                afterRegexSort(async () => {
                    try {
                        const item = ui.item?.[0];
                        if (item?.classList?.contains('foldy-folder')) {
                            enhanceRegexLists();
                            return;
                        }
                        moveRegexIntoPointedFolder(item);
                        await saveFromDom();
                    } finally {
                        sortingRegex = false;
                        clearRegexDropState();
                    }
                });
            },
        });
    });
}

function enhanceRegexList(typeKey) {
    const list = document.querySelector(REGEX_TYPES[typeKey].selector);
    if (!list) return;
    if (!featureEnabled('regex')) {
        if (list.querySelector('.foldy-folder')) unwrapRegexFolders(list);
        return;
    }
    const { owner, layout } = readRegexLayout(typeKey);
    const itemMap = new Map([...list.querySelectorAll('.regex-script-label')].map(element => [element.id, element]));
    itemMap.forEach(element => element.remove());
    const scriptsById = new Map(getScriptsByType(REGEX_TYPES[typeKey].scriptType).map(script => [String(script.id), script]));
    itemMap.forEach((element, id) => {
        const script = scriptsById.get(id);
        const toggle = element.querySelector('.disable_regex');
        if (script && toggle) toggle.checked = !!script.disabled;
    });
    const collapsed = ownerCollapsed('regex', `${typeKey}:${owner}`);
    const folderMap = new Map(layout.folders.map(folder => [folder.id, folder]));
    list.classList.add('foldy-regex-root');

    const rerender = () => enhanceRegexLists();
    const onEdit = async id => {
        const folder = layout.folders.find(value => value.id === id);
        if (!folder) return;
        const values = await requestFolderSettings(layout, folder);
        if (!values) return;
        if (values.applyStyleToAll) applyFolderStyleToAll(layout, folder.id, values);
        delete values.applyStyleToAll;
        Object.assign(folder, values);
        await persistRegexLayout(typeKey, owner, layout, false);
        rerender();
    };
    const onDelete = async id => {
        const folder = layout.folders.find(value => value.id === id);
        if (!folder || !await Popup.show.confirm('폴더 삭제', `"${folder.name}" 폴더를 삭제하고 안의 정규식 스크립트는 최상위로 옮길까요?`)) return;
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
        const items = folderElement.querySelector('.foldy-folder-items');
        items.dataset.foldyRegexType = typeKey;
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

    const onCreate = typeKey === 'global' ? async () => {
        const values = await requestNewRegexFolder('global');
        if (!values) return;
        const { owner: targetOwner, layout: targetLayout } = readRegexLayout(values.typeKey);
        const folder = addFolderWithItems(targetLayout, values.name, values.itemIds);
        collapseNewFolder('regex', `${values.typeKey}:${targetOwner}`, folder.id);
        await persistRegexLayout(values.typeKey, targetOwner, targetLayout, false);
        rerender();
    } : null;
    ensureToolbar(list.parentElement, `regex-${typeKey}`, onCreate, [
        ...createCollapseButtons('regex', `${typeKey}:${owner}`, () => layout, async () => rerender()),
        ...createBundleButtons(() => exportRegexBundle(typeKey), () => importRegexBundle(typeKey)),
    ]);
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
        setTimeout(() => {
            regexRenderQueued = false;
            if (sortingRegex) return;
            enhanceRegexLists();
        }, 0);
    });
    regexObserver.observe(root, { childList: true, subtree: true });
    enhanceRegexLists();
}

async function renderSettings() {
    if (document.getElementById('foldy_settings')) return;
    const html = await renderExtensionTemplateAsync('third-party/Foldy', 'settings');
    $('#extensions_settings2').append(html);

    const sync = () => {
        $('#foldy_enable_prompts').prop('checked', featureEnabled('prompts'));
        $('#foldy_enable_lorebooks').prop('checked', featureEnabled('lorebooks'));
        $('#foldy_enable_regex').prop('checked', featureEnabled('regex'));
    };
    const rerender = () => {
        promptManager?.render?.(false);
        queueLoreRender();
        enhanceRegexLists();
    };
    $('#foldy_enable_prompts').on('input', function () {
        settings().features.prompts = !!this.checked;
        saveSettingsDebounced();
        debugLog('info', `프롬프트 폴더 ${this.checked ? '활성화' : '비활성화'}`);
        rerender();
    });
    $('#foldy_enable_lorebooks').on('input', function () {
        settings().features.lorebooks = !!this.checked;
        saveSettingsDebounced();
        debugLog('info', `로어북 폴더 ${this.checked ? '활성화' : '비활성화'}`);
        applyLorebookFeatureState();
        rerender();
    });
    $('#foldy_enable_regex').on('input', function () {
        settings().features.regex = !!this.checked;
        saveSettingsDebounced();
        debugLog('info', `정규식 폴더 ${this.checked ? '활성화' : '비활성화'}`);
        rerender();
    });
    $('#foldy_clear_prompts').on('click', async () => {
        if (!await Popup.show.confirm('프롬프트 폴더 데이터 초기화', '프롬프트 순서는 유지하고 Foldy 프롬프트 배치만 삭제합니다.')) return;
        settings().layouts.prompts = {};
        settings().collapsed.prompt = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#foldy_clear_lorebooks').on('click', async () => {
        if (!await Popup.show.confirm('로어북 폴더 데이터 초기화', '로어북 항목은 유지하고 Foldy 로어북 배치만 삭제합니다.')) return;
        settings().layouts.lorebooks = {};
        settings().collapsed.lore = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#foldy_clear_regex').on('click', async () => {
        if (!await Popup.show.confirm('정규식 폴더 데이터 초기화', '정규식 스크립트는 유지하고 Foldy 정규식 배치만 삭제합니다.')) return;
        settings().layouts.regex = { global: {}, scoped: {}, preset: {} };
        settings().collapsed.regex = {};
        saveSettingsDebounced();
        rerender();
    });
    $('#foldy_clear_all').on('click', async () => {
        if (!await Popup.show.confirm('모든 Foldy 데이터 초기화', '원본 항목은 유지하고 Foldy 배치와 접힘 상태만 삭제합니다.')) return;
        settings().layouts = { prompts: {}, lorebooks: {}, regex: { global: {}, scoped: {}, preset: {} } };
        settings().collapsed = { prompt: {}, lore: {}, regex: {} };
        saveSettingsDebounced();
        rerender();
    });
    sync();
}

export async function init() {
    settings();
    installDebugListeners();
    registerSlashCommands();
    debugLog('info', 'Foldy 초기화 시작');
    await renderSettings();
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
        debugLog('error', '프롬프트 폴더 초기화 실패', error);
    }
}
