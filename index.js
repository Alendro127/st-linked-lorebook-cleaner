/**
 * 角色卡与世界书联动删除 v1.3.0
 * 等待 SillyTavern 完成全部角色删除和 UI 更新后，才显示世界书确认。
 * 不会在 CHARACTER_DELETED 事件中弹窗或删除世界书。
 * 所有世界书删除仅能由本插件弹窗的【确认永久删除】按钮触发。
 */
import { world_info, world_names, selected_world_info, deleteWorldInfo } from '../../../world-info.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { eventSource, event_types, chat_metadata } from '../../../../script.js';
import { power_user } from '../../../power-user.js';

const VERSION = '1.3.0';
const KEY = 'st_linked_lorebook_cleaner';
// 沿用 v1.2 的队列键，升级后未处理的记录不会丢失。
const SESSION_KEY = 'st_linked_lorebook_cleaner_pending_v12';
const INSTANCE_KEY = '__stLinkedLorebookCleanerV13Instance';
const PREFIX = '[联动删除世界书]';
const DEFAULTS = { enabled: true, includeAdditional: false };

let pending = [];
let seq = 0;
let reviewTimer = null;
let reviewRetries = 0;
let isReviewOpen = false;
let deleting = false;
let lastEvent = '等待角色删除事件';

function config() {
    extension_settings[KEY] ??= {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (typeof extension_settings[KEY][key] !== typeof value) extension_settings[KEY][key] = value;
    }
    return extension_settings[KEY];
}

function notify(message, level = 'info') {
    try { if (window.toastr?.[level]) return window.toastr[level](message, '角色卡与世界书联动删除'); }
    catch (_) { /* ignore toastr problems */ }
    console[level === 'error' ? 'error' : 'info'](`${PREFIX} ${message}`);
}

function readPending() {
    try {
        const data = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? '[]');
        pending = Array.isArray(data) ? data.filter(item =>
            typeof item?.avatar === 'string' && typeof item?.name === 'string'
            && Array.isArray(item.books) && item.books.every(book => typeof book === 'string')) : [];
    } catch (err) { console.warn(PREFIX, '待处理记录读取失败', err); pending = []; }
}

function savePending() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(pending)); }
    catch (err) { console.warn(PREFIX, '本标签页记录保存失败', err); }
    updateUi();
}

function getBooks(character) {
    const books = new Set();
    const primary = character?.data?.extensions?.world;
    if (typeof primary === 'string' && primary.trim()) books.add(primary.trim());
    if (config().includeAdditional && typeof character?.avatar === 'string') {
        const stem = character.avatar.replace(/\.[^.]+$/, '');
        const entry = world_info?.charLore?.find(x => x.name === stem);
        for (const book of entry?.extraBooks ?? []) {
            if (typeof book === 'string' && book.trim()) books.add(book.trim());
        }
    }
    return [...books];
}

function uniqueBooks() {
    return [...new Set(pending.flatMap(item => item.books))];
}

/** 拒绝删除任何可检查到被其他地方引用的书。无法扫描全部历史聊天绑定。 */
function usedElsewhere(book) {
    const chars = getContext()?.characters;
    if (!Array.isArray(chars)) return '无法读取当前角色列表';
    const deletedAvatars = new Set(pending.map(item => item.avatar));
    const added = world_info?.charLore ?? [];
    for (const character of chars) {
        if (!character || deletedAvatars.has(character.avatar)) continue;
        if (character.data?.extensions?.world === book) {
            return `角色「${character.name ?? character.avatar}」仍作为主要世界书引用`;
        }
        const stem = character.avatar?.replace(/\.[^.]+$/, '');
        const additional = added.find(x => x.name === stem)?.extraBooks;
        if (Array.isArray(additional) && additional.includes(book)) {
            return `角色「${character.name ?? character.avatar}」仍作为附加世界书引用`;
        }
        if (character.shallow && !character.data?.extensions) {
            return '存在未完整加载的角色，无法确认共享情况';
        }
    }
    if (selected_world_info?.includes(book)) return '仍作为全局世界书启用';
    if (power_user?.persona_description_lorebook === book) return '当前用户人设正在引用';
    if (Object.values(power_user?.personas ?? {}).some(persona => persona?.lorebook === book)) return '其他用户人设正在引用';
    if (chat_metadata?.world_info === book) return '当前聊天正在引用';
    return null;
}

function classify() {
    const allowed = [], protectedBooks = [], missing = [];
    for (const book of uniqueBooks()) {
        if (!world_names?.includes(book)) { missing.push(book); continue; }
        const reason = usedElsewhere(book);
        if (reason) protectedBooks.push({ book, reason });
        else allowed.push(book);
    }
    return { allowed, protectedBooks, missing };
}

function updateUi() {
    const status = document.getElementById('slc-v13-status');
    const count = uniqueBooks().length;
    if (status) status.textContent = `版本 v${VERSION} 已加载｜待处理 ${pending.length} 张角色卡、${count} 本世界书。\n最近状态：${lastEvent}`;
    const review = document.getElementById('slc-v13-review');
    if (review) {
        review.disabled = count === 0 || deleting;
        review.textContent = count ? `查看待处理世界书（${count}）` : '暂无待处理世界书';
    }
    const floating = document.getElementById('slc-v13-floating');
    if (floating) {
        floating.hidden = count === 0 || deleting;
        floating.textContent = `待确认世界书 ${count} 本`;
    }
}

function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function clearReviewTimer() {
    if (reviewTimer !== null) clearTimeout(reviewTimer);
    reviewTimer = null;
}

/** 仅在酒馆完整更新角色列表并广播 CHAT_CHANGED 后调度；不在批量删除中间弹窗。 */
function onDeletionFinished() {
    if (!pending.length || !config().enabled || deleting) return;
    clearReviewTimer();
    reviewRetries = 0;
    lastEvent = `酒馆已完成角色删除和列表更新；准备确认 ${uniqueBooks().length} 本世界书`;
    updateUi();
    reviewTimer = setTimeout(tryAutomaticReview, 1100);
}

function tryAutomaticReview() {
    reviewTimer = null;
    if (!pending.length || isReviewOpen || deleting || !config().enabled) return;
    // 不能覆盖酒馆自身正在进行的删除/保存弹窗。
    const otherDialogOpen = [...document.querySelectorAll('dialog[open]')]
        .some(dialog => !dialog.classList.contains('slc-v13-modal'));
    if (otherDialogOpen) {
        if (++reviewRetries <= 16) {
            reviewTimer = setTimeout(tryAutomaticReview, 650);
        } else {
            lastEvent = '酒馆仍有窗口未关闭；请关闭原窗口后从右下角待确认入口手动处理';
            notify('世界书仍待确认，没有执行删除。请关闭酒馆窗口后，从右下角入口处理。', 'warning');
            updateUi();
        }
        return;
    }
    void presentDialog();
}

/** 显式确认是唯一的删除入口。测试、关闭、跳过均不删除。 */
async function presentDialog({ test = false } = {}) {
    if (isReviewOpen || deleting) return;
    if (!test && !pending.length) { notify('目前没有待处理的世界书'); return; }
    clearReviewTimer();
    isReviewOpen = true;
    const { allowed, protectedBooks, missing } = test ? { allowed: [], protectedBooks: [], missing: [] } : classify();
    const dialog = el('dialog', 'slc-v13-modal');
    dialog.setAttribute('aria-label', test ? '测试世界书确认弹窗' : '是否同时删除角色绑定的世界书');
    dialog.append(el('h3', '', test ? '弹窗测试（不会删除数据）' : '是否一并删除绑定的世界书？'));
    dialog.append(el('p', '', test
        ? '可以正常看到此窗口就表示弹窗功能正常。两个按钮均不会删除任何东西。'
        : `角色卡删除流程已完成。以下 ${allowed.length} 本世界书可供确认删除：`));
    if (!test) {
        if (allowed.length) {
            const list = el('ul');
            for (const name of allowed) list.append(el('li', '', name));
            dialog.append(list);
        } else dialog.append(el('p', 'slc-v13-warning', '没有符合安全条件的候选世界书。'));
        if (protectedBooks.length) {
            dialog.append(el('p', 'slc-v13-warning', `自动保留 ${protectedBooks.length} 本仍被引用的世界书：`));
            const list = el('ul');
            for (const { book, reason } of protectedBooks) list.append(el('li', '', `${book}（${reason}）`));
            dialog.append(list);
        }
        if (missing.length) dialog.append(el('p', '', `另有 ${missing.length} 本已不在世界书列表中：${missing.join('、')}（不会操作）`));
        dialog.append(el('p', 'slc-v13-warning', '永久删除不可撤销。插件无法扫描所有历史聊天的独立世界书绑定，请提前备份重要数据。'));
    }
    const actions = el('div', 'slc-v13-actions');
    const keep = el('button', 'menu_button', test ? '测试取消' : '保留世界书');
    const approve = el('button', 'menu_button slc-v13-danger', test ? '测试确认' : `确认永久删除 ${allowed.length} 本`);
    keep.type = approve.type = 'button';
    approve.disabled = !test && !allowed.length;
    actions.append(keep, approve);
    dialog.append(actions);
    document.body.append(dialog);

    let closed = false;
    const close = () => {
        if (closed) return false;
        closed = true;
        isReviewOpen = false;
        try { if (dialog.open) dialog.close(); } catch (_) { /* ignore */ }
        dialog.remove();
        updateUi();
        return true;
    };
    keep.addEventListener('click', () => {
        if (!close()) return;
        if (test) return notify('测试取消正常；没有删除任何数据。', 'success');
        pending = [];
        lastEvent = '你选择保留世界书；没有进行世界书删除';
        savePending();
        notify('世界书已保留', 'success');
    });
    approve.addEventListener('click', () => {
        if (!close()) return;
        if (test) return notify('测试确认正常；没有删除任何数据。', 'success');
        void commitDeletion(allowed);
    });
    dialog.addEventListener('cancel', e => {
        e.preventDefault();
        if (close()) notify('确认窗已关闭；世界书仍待处理，可在插件设置重新打开。');
    });
    try {
        if (typeof dialog.showModal !== 'function') throw new Error('浏览器不支持 dialog.showModal');
        dialog.showModal();
        keep.focus();
        console.info(PREFIX, '确认弹窗已显示', { test, allowed, protectedBooks, missing });
    } catch (err) {
        console.error(PREFIX, '无法展示弹窗；没有执行删除', err);
        close();
        lastEvent = `无法打开弹窗：${String(err?.message ?? err)}`;
        updateUi();
        notify('弹窗未能打开，世界书未删除；可从扩展设置重新打开。', 'error');
    }
}

async function commitDeletion(approved) {
    if (deleting) return;
    deleting = true;
    updateUi();
    const done = [], protectedNow = [], alreadyMissing = [], failures = [];
    try {
        for (const name of approved) {
            if (!world_names?.includes(name)) { alreadyMissing.push(name); continue; }
            const why = usedElsewhere(name);
            if (why) { protectedNow.push(`${name}（${why}）`); continue; }
            try {
                const ok = await deleteWorldInfo(name);
                if (ok === true) done.push(name);
                else if (!world_names?.includes(name)) alreadyMissing.push(name);
                else failures.push(name);
            } catch (err) {
                console.error(PREFIX, `删除「${name}」出错`, err);
                // 某些版本的 ST 可能已删除文件但列表刷新失败：不可直接判断为失败。
                failures.push(name);
            }
        }
        lastEvent = `确认后：成功 ${done.length} 本；保留共享 ${protectedNow.length} 本；已不存在 ${alreadyMissing.length} 本；未确认成功 ${failures.length} 本`;
        console.info(PREFIX, '删除结果', { done, protectedNow, alreadyMissing, failures });
        notify(lastEvent, failures.length ? 'warning' : 'success');
    } finally {
        // 已处理的书清空；失败的书保留为待确认（下次需再次手动确认）。
        pending = failures.length ? [{ avatar: `retry-${Date.now()}`, name: '上次删除失败的世界书', books: failures }] : [];
        deleting = false;
        savePending();
    }
}

function onCharacterDeleted(evt) {
    if (!config().enabled) return;
    const char = evt?.character;
    if (!char?.avatar) {
        lastEvent = '收到角色删除事件但缺少角色信息，没有执行任何世界书操作';
        updateUi();
        return;
    }
    const books = getBooks(char);
    if (!books.length) {
        lastEvent = `角色「${char.name || char.avatar}」已删除，未绑定待处理世界书`;
        updateUi();
        return;
    }
    // 避免重复角色删除事件在同一轮中造成双重待处理记录。
    if (!pending.some(item => item.avatar === char.avatar)) {
        pending.push({ id: `${Date.now()}-${++seq}`, avatar: char.avatar, name: char.name || char.avatar, books });
    }
    lastEvent = `收到「${char.name || char.avatar}」删除事件；等待酒馆完成剩余角色删除`;
    console.info(PREFIX, lastEvent, books);
    savePending();
    // 这里绝对不弹窗！批量删除可能仍在处理后续角色。
}

function makeSettingsUi() {
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host || document.getElementById('st-linked-lorebook-cleaner')) return;
    const panel = el('div', 'inline-drawer slc-v13-panel');
    panel.id = 'st-linked-lorebook-cleaner';
    panel.innerHTML = `
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>角色卡与世界书联动删除 <span class="slc-v13-version">v${VERSION}</span></b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label"><input type="checkbox" id="slc-enabled"><span>删除角色卡后询问是否删除主要世界书</span></label>
        <label class="checkbox_label"><input type="checkbox" id="slc-extra"><span>包括附加世界书（默认关闭）</span></label>
        <p id="slc-v13-status" class="slc-v13-status" aria-live="polite"></p>
        <div class="slc-v13-panel-actions">
          <button type="button" class="menu_button" id="slc-v13-test">测试弹窗（不删除数据）</button>
          <button type="button" class="menu_button" id="slc-v13-review">查看待处理世界书</button>
        </div>
        <p class="slc-v13-note">批量删除时等待酒馆把所有角色处理完，才会弹出一次世界书确认。只有明确按下「确认永久删除」才会删除世界书。</p>
      </div>`;
    host.append(panel);
    const settings = config();
    const enabled = panel.querySelector('#slc-enabled');
    const extra = panel.querySelector('#slc-extra');
    enabled.checked = settings.enabled;
    extra.checked = settings.includeAdditional;
    enabled.addEventListener('change', () => { settings.enabled = enabled.checked; getContext()?.saveSettingsDebounced?.(); });
    extra.addEventListener('change', () => { settings.includeAdditional = extra.checked; getContext()?.saveSettingsDebounced?.(); });
    panel.querySelector('#slc-v13-test').addEventListener('click', () => { void presentDialog({ test: true }); });
    panel.querySelector('#slc-v13-review').addEventListener('click', () => { void presentDialog(); });
    // 不重复绑定 .inline-drawer-toggle；酒馆已经对这个 class 绑定了全局折叠事件。
    panel.querySelector('.inline-drawer-content').style.display = 'none';
    const floating = el('button', 'menu_button', '待确认世界书');
    floating.id = 'slc-v13-floating';
    floating.type = 'button';
    floating.addEventListener('click', () => { void presentDialog(); });
    document.body.append(floating);
    updateUi();
}

// 防止同一页面重复初始化 v1.3。不影响检测不同路径的旧版插件，请手动确保仅安装一份。
if (window[INSTANCE_KEY]) {
    console.warn(PREFIX, '检测到同版本脚本重复加载，已跳过二次注册。');
} else {
    window[INSTANCE_KEY] = true;
    readPending();
    config();
    eventSource.on(event_types.CHARACTER_DELETED, onCharacterDeleted);
    eventSource.on(event_types.CHAT_CHANGED, onDeletionFinished);
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, () => {
        const settings = config();
        const enabled = document.getElementById('slc-enabled');
        const extra = document.getElementById('slc-extra');
        if (enabled) enabled.checked = settings.enabled;
        if (extra) extra.checked = settings.includeAdditional;
        updateUi();
    });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', makeSettingsUi, { once: true });
    else makeSettingsUi();
    console.info(`${PREFIX} v${VERSION} 已加载；仅在角色列表更新完成后的 CHAT_CHANGED 事件上弹出确认。`);
}
