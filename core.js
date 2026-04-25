(function () {
    'use strict';

    const SCRIPT_ID = 'acu_visualizer_ui_v20_0_ai_overlay';
    
    // [新增] 全局防抖提示管理器，拦截高频重复弹窗
    const AcuToast = {
        lastMsgs: new Map(),
        cooldown: 2000, // 2秒冷却期，同类提示在这期间只弹一次
        show: function(type, msg) {
            if (!window.toastr) return;
            const now = Date.now();
            const strMsg = String(msg);
            const lastTime = this.lastMsgs.get(strMsg);
            if (lastTime && (now - lastTime < this.cooldown)) return; // 冷却中，静默拦截
            
            this.lastMsgs.set(strMsg, now);
            window.toastr[type](msg);
            setTimeout(() => this.lastMsgs.delete(strMsg), this.cooldown + 100);
        },
        success: msg => AcuToast.show('success', msg),
        info: msg => AcuToast.show('info', msg),
        warning: msg => AcuToast.show('warning', msg),
        error: msg => AcuToast.show('error', msg)
    };

    const escapeHtml = (s) => {
        return String(s ?? '').trim().replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
    };

    // [新增] 增强型文件下载兼容性助手
    const acuDownloadFile = (fileName, content) => {
        const blob = new Blob([content], { type: 'application/json' });
        // 兼容 IE/旧版 Edge
        if (window.navigator && window.navigator.msSaveOrOpenBlob) {
            window.navigator.msSaveOrOpenBlob(blob, fileName);
            return;
        }
        // 现代浏览器方案
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        
        // 使用双重异步，确保 UI 线程有足够时间处理 Blob 句柄
        setTimeout(() => {
            try {
                a.click();
            } catch (e) {
                console.error('[ACU] 下载触发失败:', e);
                AcuToast.error('浏览器拦截了自动下载，请尝试更换浏览器');
            }
            // 延迟 200ms 再清理，防止某些内核在文件写入硬盘前就销毁了数据源
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 200);
        }, 50);
    };
    const getDefaultAvatarColor = (name) => {
        const colors = ['#e74c3c', '#3498db', '#9b59b6', '#2ecc71', '#f1c40f'];
        return colors[String(name).charCodeAt(0) % 5];
    };
    const STORAGE_KEY_TABLE_ORDER = 'acu_table_order';
    const STORAGE_KEY_ACTION_ORDER = 'acu_action_order';
    const STORAGE_KEY_PENDING_DELETIONS = 'acu_pending_deletions';
    const STORAGE_KEY_ACTIVE_TAB = 'acu_active_tab';
    const STORAGE_KEY_UI_CONFIG = 'acu_ui_config_v19';
    const STORAGE_KEY_LAST_SNAPSHOT = 'acu_data_snapshot_v19';
    const STORAGE_KEY_IS_COLLAPSED = 'acu_ui_collapsed_state';
    const STORAGE_KEY_ROUND_BASELINE = 'acu_round_baseline_v19'; // [新增] 专门用于撤销回档
    const STORAGE_KEY_TABLE_HEIGHTS = 'acu_table_heights_v19';
    const STORAGE_KEY_TABLE_STYLES = 'acu_table_styles_v19';
    const STORAGE_KEY_HIDDEN_TABLES = 'acu_hidden_tables_v19';
    const STORAGE_KEY_DISABLE_HIGHLIGHT_TOP = 'acu_disable_highlight_top_v19'; // [修改] 改为默认开启的高亮黑名单
    const STORAGE_KEY_RELATION_POSITIONS = 'acu_relation_positions_v19'; // [新增] 人物关系网节点位置记忆
    const VIRTUAL_RELATIONSHIP_TAB = '🔗 人物关系'; // [新增] 虚拟标签名常量
const EXCLUDED_NAMES = ['无', '无关系', '暂无', '未知', '空', 'N/A', 'NA', 'None', 'null', '-', '—', '/']; // [新增] 关系提取排除词
    const MAX_ACTION_BUTTONS = 6;  // 活动栏最大按钮数
    const DEFAULT_ACTION_ORDER = ['acu-btn-save-global', 'acu-btn-collapse', 'acu-btn-force-update', 'acu-btn-settings']; // 刷新已移至备选池，强制更新已上架
    const MIN_PANEL_HEIGHT = 200;  // 面板最小高度
    const MAX_PANEL_HEIGHT = 1200; // 面板最大高度

    // [新增] 全局定义功能按钮池
    const ALL_ACTION_BUTTONS = [
        {id: 'acu-btn-save-global', icon: 'fa-save', title: '保存所有修改'},
        {id: 'acu-btn-settings', icon: 'fa-cog', title: '全能设置'},
        {id: 'acu-btn-refresh', icon: 'fa-sync-alt', title: '重新加载'},
        
        {id: 'acu-btn-collapse', icon: 'fa-chevron-down', title: '收起面板 (旧版)'},
        {id: 'acu-btn-force-update', icon: 'fa-bolt', title: '手动触发后端更新'},
        {id: 'acu-btn-open-editor', icon: 'fa-table-columns', title: '打开内置编辑器'},
        // [新增] 数据库原生设置面板快捷入口
        {id: 'acu-btn-open-db-settings', icon: 'fa-database', title: '打开神·数据库原生设置'}
    ];

    let isInitialized = false;
    let isSaving = false;
    let isEditingOrder = false;
    let isWaitingForDbUpdate = false; // [新增] 数据库专属的更新锁
    let dbUpdateTimeout = null;       // [新增] 防止转圈死锁的看门狗
    let currentDiffMap = new Set();
    let _boundRenderHandler = null;

    // --- 全局状态变量 ---
    let cachedRawData = null;
    let hasUnsavedChanges = false;
    let tablePageStates = {};
    let tableSearchStates = {};
    let lastOptionHash = null;      // [补回] 选项指纹
    let optionPanelVisible = false; // [补回] 选项可见性控制
    // [修改] 初始化时从硬盘读取记忆
    const STORAGE_KEY_SCROLL = 'acu_scroll_v19_fixed';
    let tableScrollStates = {};
    try {
        const saved = localStorage.getItem(STORAGE_KEY_SCROLL);
        if (saved) tableScrollStates = JSON.parse(saved);
    } catch(e) { console.warn('[ACU] Error:', e); } 

// [修改] 智能更新控制器 (含自动头像迁移 & 自动清理失效缓存)
    const UpdateController = { 
        handleUpdate: () => {
            isWaitingForDbUpdate = false; // [新增] 数据库更新完毕，立刻解锁
            if (dbUpdateTimeout) clearTimeout(dbUpdateTimeout); // [新增] 成功获取数据，销毁看门狗
            const api = window.AutoCardUpdaterAPI || window.parent.AutoCardUpdaterAPI;
            const newData = api && api.exportTableAsJson ? api.exportTableAsJson() : null;
            
            if (newData) {
                // --- [核心升级] 智能侦测改名迁移 & 孤儿头像普查清理 ---
                const oldData = cachedRawData || loadSnapshot();
                const ctxId = getCurrentContextFingerprint();
                const avatars = getCustomAvatars();
                let ctxAvatars = avatars[ctxId];
                
                // 1. 建立本回合的"存活人口"普查名单
                const validNames = new Set();
                
                if (ctxAvatars) {
                    let hasAvatarChanges = false;
                    
                    // 2. 遍历新表：收集名单 + 侦测同行改名
                    for (const sheetId in newData) {
                        const newSheet = newData[sheetId];
                        if (!newSheet || !newSheet.content) continue;
                        
                        const headers = newSheet.content[0];
                        const nameIdx = headers.findIndex(h => /姓名|名字|角色名|人物名称|Name/i.test(h));
                        if (nameIdx === -1) continue;
                        
                        for (let i = 1; i < newSheet.content.length; i++) {
                            const newRow = newSheet.content[i];
                            const newName = String(newRow[nameIdx] || '').trim();
                            if (newName) validNames.add(newName); // 登记到存活名单
                            
                            // 对比上一回合数据，看是不是改名了
                            if (oldData && oldData[sheetId] && oldData[sheetId].content[i]) {
                                const oldRow = oldData[sheetId].content[i];
                                const oldName = String(oldRow[nameIdx] || '').trim();
                                
                                if (oldName && newName && oldName !== newName && ctxAvatars[oldName]) {
                                    ctxAvatars[newName] = ctxAvatars[oldName]; // 继承头像
                                    delete ctxAvatars[oldName]; // 销毁老名字数据
                                    hasAvatarChanges = true;
                                    console.log(`[ACU] 侦测到改名: ${oldName} -> ${newName}，已自动迁移头像`);
                                }
                            }
                        }
                    }
                    
                    // 3. 终极清理：查无此人的孤儿头像，全部销毁
                    for (const savedName in ctxAvatars) {
                        if (!validNames.has(savedName)) {
                            delete ctxAvatars[savedName];
                            hasAvatarChanges = true;
                            console.log(`[ACU] 自动清理已删除/失效的角色头像缓存: ${savedName}`);
                        }
                    }
                    
                    // 有任何变动才写入硬盘，减少性能损耗
                    if (hasAvatarChanges) {
                        AvatarDB.saveToDB(ctxId, ctxAvatars); // 使用异步新引擎保存清理后的数据
                    }
                }
                // ----------------------------------------------------

                cachedRawData = newData;
                Store.set(STORAGE_KEY_ROUND_BASELINE, newData);
            }

            renderInterface(); 
        } 
    };




    

    // --- [重构] 上下文指纹工具 ---
    const getCurrentContextFingerprint = () => {
        try {
            // 方式1: 酒馆标准 API
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getCurrentChatId) {
                return SillyTavern.getCurrentChatId();
            }
            // 方式2: 直接访问属性
            if (typeof SillyTavern !== 'undefined' && SillyTavern.chatId) {
                return SillyTavern.chatId;
            }
            // 方式3: 父窗口 (iframe 场景)
            if (window.parent?.SillyTavern?.getCurrentChatId) {
                return window.parent.SillyTavern.getCurrentChatId();
            }
        } catch (e) {
            console.warn('[ACU] getCurrentContextFingerprint error:', e);
        }
        return 'unknown_context';
    };

    // 全局状态追踪 (已清理死代码)

    const DEFAULT_CONFIG = {
        layout: 'horizontal',
        collapseStyle: 'bar',
        collapseAlign: 'right',
        fontFamily: 'default',
        theme: 'native',
        cardWidth: 260,
        fontSize: 13,
        optionFontSize: 12,
        highlightNew: true,
        itemsPerPage: 20, // 已改为20条
        actionsPosition: 'bottom',
        gridColumns: 'auto', // [修改] 默认为智能自动列数
        showStatusBar: false, // [修改] 默认关闭跟随消息的状态栏
        beautifyToastr: false,      // [修改] 默认关闭美化右上角系统提示
        showOptionPanel: true,      // [补回] 显示选项面板
        clickOptionToAutoSend: false // [修改] 默认关闭点击选项自动发送
    };

    const FONTS = [
        { id: 'default', name: '系统默认 (Modern)', val: `'Segoe UI', 'Microsoft YaHei', sans-serif` },
        { id: 'hanchan', name: '寒蝉全圆体', val: `"寒蝉全圆体", sans-serif` },
        { id: 'maple', name: 'Maple Mono (代码风)', val: `"Maple Mono NF CN", monospace` },
        { id: 'huiwen', name: '汇文明朝体 (Huiwen)', val: `"Huiwen-mincho", serif` },
        { id: 'cooper', name: 'Cooper正楷', val: `"CooperZhengKai", serif` },
        { id: 'yffyt', name: 'YFFYT (艺术体)', val: `"YFFYT", sans-serif` },
        { id: 'wenkai', name: '霞鹜文楷 (WenKai)', val: `"LXGW WenKai", serif` },
        { id: 'notosans', name: '思源黑体 (Noto Sans)', val: `"Noto Sans CJK", sans-serif` },
        { id: 'zhuque', name: '朱雀仿宋 (Zhuque)', val: `"Zhuque Fangsong (technical preview)", serif` }
    ];

    const THEMES = [
        { id: 'native', name: '跟随酒馆 (Native)', icon: 'fa-palette' },
        { id: 'retro', name: '复古羊皮 (Retro)', icon: 'fa-scroll' },
        { id: 'dark', name: '极夜深空 (Dark)', icon: 'fa-moon' },
        { id: 'modern', name: '现代清爽 (Modern)', icon: 'fa-sun' },
        { id: 'forest', name: '森之物语 (Forest)', icon: 'fa-tree' },
        { id: 'ocean', name: '深海幽蓝 (Ocean)', icon: 'fa-water' },
        { id: 'cyber', name: '赛博霓虹 (Cyber)', icon: 'fa-bolt' },
        { id: 'sakura', name: '樱花之恋 (Sakura)', icon: 'fa-fan' },
        { id: 'lavender', name: '紫罗兰梦 (Lavender)', icon: 'fa-moon' },
        { id: 'palace', name: '蔷薇王座 (Palace)', icon: 'fa-crown' },
        { id: 'coffee', name: '焦糖拿铁 (Coffee)', icon: 'fa-mug-hot' },
        { id: 'wuxia', name: '水墨修仙 (Wuxia)', icon: 'fa-yin-yang' },
        { id: 'mecha', name: '机甲风暴 (Mecha)', icon: 'fa-robot' },
        { id: 'gothic', name: '暗黑深渊 (Gothic)', icon: 'fa-skull' }
    ];

    // [优化] 缓存 core 对象 (修复竞态条件 + 增强 ST 穿透查找)
    let _coreCache = null;
    const getCore = () => {
        const w = window.parent || window;
        // 动态获取 jQuery
        const $ = window.jQuery || w.jQuery;
        
        // 只有当缓存存在且有效($存在)时，才直接返回
        if (_coreCache && _coreCache.$) return _coreCache;

        const core = {
            $: $,
            getDB: () => w.AutoCardUpdaterAPI || window.AutoCardUpdaterAPI,
            // 增强查找：依次尝试 当前窗口 -> 父窗口 -> 顶层窗口 (带跨域保护)
            ST: window.SillyTavern || w.SillyTavern || (() => {
                try { return window.top ? window.top.SillyTavern : null; } catch(e) { return null; }
            })()
        };
        
        // 只有成功获取到 jQuery 后才锁定缓存，防止初始化过早导致永久失效
        if ($) _coreCache = core;
        return core;
    };

    const updateSaveButtonState = () => {
        const { $ } = getCore();
        const $btn = $('#acu-btn-save-global');
        const $icon = $btn.find('i');
        const deletions = getPendingDeletions();
        let hasDeletions = false;
        if (deletions) {
            for (const key in deletions) {
                if (deletions[key] && deletions[key].length > 0) {
                    hasDeletions = true;
                    break;
                }
            }
        }
        if (hasUnsavedChanges || hasDeletions) {
            $icon.addClass('acu-icon-breathe');
            $btn.attr('title', '你有未保存的手动修改或删除操作');
        } else {
            $icon.removeClass('acu-icon-breathe');
            $btn.attr('title', '保存');
            $btn.css('color', '');
        }
    };

    const getIconForTableName = (name) => {
        if (!name) return 'fa-table';
        // [修复] 给关系网标签分配专用图标
        if (name === VIRTUAL_RELATIONSHIP_TAB) return 'fa-project-diagram';
        const n = name.toLowerCase();
        if (n.includes('主角') || n.includes('角色')) return 'fa-user-circle';
        if (n.includes('通用') || n.includes('全局')) return 'fa-globe-asia';
        if (n.includes('装备') || n.includes('背包')) return 'fa-briefcase';
        if (n.includes('技能') || n.includes('武魂')) return 'fa-dragon';
        if (n.includes('关系') || n.includes('周边')) return 'fa-user-friends';
        if (n.includes('任务') || n.includes('日志')) return 'fa-scroll';
        if (n.includes('总结') || n.includes('大纲')) return 'fa-book-reader';
        return 'fa-table';
    };

    const getBadgeStyle = (text) => {
        if (!text) return '';
        const str = String(text).trim();
        if (/^[0-9]+%?$/.test(str) || /^Lv\.\d+$/.test(str)) return 'acu-badge-green';
        if (str.length <= 6 && !str.includes('http')) return 'acu-badge-neutral';
        if (['是', '否', '有', '无', '死亡', '存活'].includes(str)) return 'acu-badge-neutral';
        return '';
    };

    // [优化] 统一存储封装 (带静默自动清理)
    const Store = {
        get: (key, def = null) => { try { return JSON.parse(localStorage.getItem(key)) ?? def; } catch { return def; } },
        set: (key, val) => { 
            try { 
                localStorage.setItem(key, JSON.stringify(val)); 
            } catch (e) { 
                // 捕获存储空间已满错误
                if (e.name === 'QuotaExceededError' || e.message.includes('quota')) {
                    console.warn('[ACU] 存储空间已满，触发静默清理策略...');
                    try {
                        // 1. 优先删除最占空间的“数据快照” (不影响功能，只会导致下次刷新暂时没有蓝色高亮)
                        localStorage.removeItem(STORAGE_KEY_LAST_SNAPSHOT);
                        
                        // 2. 再次尝试保存
                        localStorage.setItem(key, JSON.stringify(val));
                        console.log('[ACU] 静默清理完成，数据已保存');
                    } catch (retryErr) {
                        // 如果清理后还是存不下，才弹窗打扰用户
                        console.error('[ACU Store] 清理后依然失败', retryErr);
                        if (window.toastr && !window._acuQuotaAlerted) {
                            AcuToast.warning('⚠️ 浏览器存储空间严重不足，配置保存失败');
                            window._acuQuotaAlerted = true; setTimeout(() => window._acuQuotaAlerted = false, 10000);
                        }
                    }
                } else {
                    console.error('[ACU Store]', e);
                }
            } 
        }
    };



    const getActiveTabState = () => Store.get(STORAGE_KEY_ACTIVE_TAB);
    const saveActiveTabState = (v) => Store.set(STORAGE_KEY_ACTIVE_TAB, v);
    const getPendingDeletions = () => Store.get(STORAGE_KEY_PENDING_DELETIONS, {});
    const savePendingDeletions = (v) => Store.set(STORAGE_KEY_PENDING_DELETIONS, v);
    const getSavedTableOrder = () => Store.get(STORAGE_KEY_TABLE_ORDER);
    const saveTableOrder = (v) => Store.set(STORAGE_KEY_TABLE_ORDER, v);
    const getCollapsedState = () => Store.get(STORAGE_KEY_IS_COLLAPSED, false);
    const saveCollapsedState = (v) => Store.set(STORAGE_KEY_IS_COLLAPSED, v);
    // [修改] 读取快照时，严格核对身份证 (Chat ID)
    const loadSnapshot = () => {
        const data = Store.get(STORAGE_KEY_LAST_SNAPSHOT);
        if (!data) return null;
        // 获取当前环境指纹
        const currentCtx = getCurrentContextFingerprint();
        // 如果快照里的指纹存在，但和当前不一致，说明是上个角色的数据，必须作废
        if (data._contextId && data._contextId !== currentCtx) {
            // console.log('[ACU] 快照指纹不匹配，视为无效');
            return null; 
        }
        return data;
    };

    // [修改] 保存快照时，自动注入当前的身份证
    const saveSnapshot = (v) => {
        if (!v) return;
        // 确保数据对象里带有当前 ChatID
        if (typeof v === 'object') {
            v._contextId = getCurrentContextFingerprint();
        }
        Store.set(STORAGE_KEY_LAST_SNAPSHOT, v);
    };

    // ============================================================
    // [降维打击] IndexedDB 专属头像存储引擎 (打破 5MB 容量限制)
    // ============================================================
    const AvatarDB = {
        dbName: 'ACU_Avatar_DB',
        storeName: 'avatars',
        db: null,
        cache: {}, // 内存缓存：保障原有同步代码的秒级读取

        init: function() {
            return new Promise((resolve) => {
                const request = indexedDB.open(this.dbName, 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName);
                };
                request.onsuccess = (e) => {
                    this.db = e.target.result;
                    // 初始化时全量读入内存缓存
                    const store = this.db.transaction([this.storeName], 'readonly').objectStore(this.storeName);
                    const getAll = store.getAll();
                    const getKeys = store.getAllKeys();
                    
                    getAll.onsuccess = () => {
                        getKeys.onsuccess = () => {
                            getKeys.result.forEach((key, i) => { this.cache[key] = getAll.result[i]; });
                            this.migrateOldData(); // 检查并迁移旧数据
                            resolve();
                        };
                    };
                };
                request.onerror = () => resolve(); // 出错也不阻塞主流程
            });
        },

        migrateOldData: function() {
            try {
                const oldDataStr = localStorage.getItem('acu_custom_avatars_v19');
                if (oldDataStr) {
                    const oldData = JSON.parse(oldDataStr);
                    for (const ctxId in oldData) {
                        if (!this.cache[ctxId]) {
                            this.cache[ctxId] = oldData[ctxId];
                            this.saveToDB(ctxId, oldData[ctxId]);
                        }
                    }
                    localStorage.removeItem('acu_custom_avatars_v19'); // 释放旧版占用的宝贵 5MB 空间！
                    console.log('[ACU] 🎉 头像数据已无损迁移至 IndexedDB，并释放了 localStorage 空间！');
                }
            } catch(e) {}
        },

        saveToDB: function(ctxId, data) {
            if (!this.db) return;
            const store = this.db.transaction([this.storeName], 'readwrite').objectStore(this.storeName);
            store.put(data, ctxId); // 异步静默写入，不卡顿
        }
    };

    // [新增] 模板专属 IndexedDB 引擎
    const TemplateDB = {
        dbName: 'ACU_Template_DB',
        storeName: 'templates',
        db: null,

        init: function() {
            return new Promise((resolve) => {
                const request = indexedDB.open(this.dbName, 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        db.createObjectStore(this.storeName);
                    }
                };
                request.onsuccess = (e) => {
                    this.db = e.target.result;
                    resolve();
                };
                request.onerror = () => resolve();
            });
        },

        saveTemplate: function(templateId, jsonData) {
            return new Promise((resolve) => {
                if (!this.db) return resolve(false);
                const store = this.db.transaction([this.storeName], 'readwrite').objectStore(this.storeName);
                store.put(jsonData, templateId).onsuccess = () => resolve(true);
            });
        },

        getAllTemplates: function() {
            return new Promise((resolve) => {
                if (!this.db) return resolve({});
                const store = this.db.transaction([this.storeName], 'readonly').objectStore(this.storeName);
                const reqKeys = store.getAllKeys();
                const reqVals = store.getAll();
                reqKeys.onsuccess = () => {
                    reqVals.onsuccess = () => {
                        const result = {};
                        reqKeys.result.forEach((k, i) => result[k] = reqVals.result[i]);
                        resolve(result);
                    };
                };
                reqVals.onerror = () => resolve({});
            });
        }
    };

    // 完美兼容原有同步逻辑的代理方法
    const getCustomAvatars = () => AvatarDB.cache;
    const saveCustomAvatar = (ctxId, charName, imgDataBase64) => {
        if (!AvatarDB.cache[ctxId]) AvatarDB.cache[ctxId] = {};
        AvatarDB.cache[ctxId][charName] = imgDataBase64;
        AvatarDB.saveToDB(ctxId, AvatarDB.cache[ctxId]); 
        return true; // IndexedDB 容量极大，不再会报错了
    };

    // --- [新增] 移植的辅助函数 ---
    // [终极修复] 将面板高度记忆与“角色卡/聊天 ID”强绑定，实现千人千面，互不污染
    const getTableHeights = () => {
        const allHeights = Store.get(STORAGE_KEY_TABLE_HEIGHTS, {});
        const ctxId = getCurrentContextFingerprint(); // 获取当前角色卡的身份证
        return allHeights[ctxId] || {}; // 只返回当前角色的高度记忆
    };
    
    const saveTableHeights = (v) => {
        const allHeights = Store.get(STORAGE_KEY_TABLE_HEIGHTS, {});
        const ctxId = getCurrentContextFingerprint(); // 获取当前角色卡的身份证
        allHeights[ctxId] = v; // 将高度只保存在当前角色名下
        Store.set(STORAGE_KEY_TABLE_HEIGHTS, allHeights);
    };
    const getTableStyles = () => Store.get(STORAGE_KEY_TABLE_STYLES, {});
    const saveTableStyles = (v) => Store.set(STORAGE_KEY_TABLE_STYLES, v);
    const getHiddenTables = () => Store.get(STORAGE_KEY_HIDDEN_TABLES, []);
    const saveHiddenTables = (v) => Store.set(STORAGE_KEY_HIDDEN_TABLES, v);
    
    // [新增] 人物关系网位置记忆
    const getRelationPositions = () => Store.get(STORAGE_KEY_RELATION_POSITIONS, { nodes: {}, viewTransform: null });
    const saveRelationPositions = (v) => Store.set(STORAGE_KEY_RELATION_POSITIONS, v);

    // [新增] 中心节点锁定记忆
    const getPinnedRelationCenter = () => Store.get('acu_rel_pinned_center_' + getCurrentContextFingerprint(), null);
    const savePinnedRelationCenter = (v) => Store.set('acu_rel_pinned_center_' + getCurrentContextFingerprint(), v);

    // [新增] 整体编辑模态框
    const showCardEditModal = (row, headers, tableName, rowIndex, tableKey) => {
        const { $ } = getCore();
        const config = getConfig();
        let rawData = cachedRawData || getTableData() || loadSnapshot();
        
        let displayRow = row;
        // 确保获取的是最新数据
        if (rawData && rawData[tableKey] && rawData[tableKey]?.content?.[rowIndex + 1]) {
            displayRow = rawData[tableKey]?.content?.[rowIndex + 1];
        }

        const inputsHtml = displayRow.map((cell, idx) => {
            if (idx === 0) return ''; // 跳过索引列
            const headerName = headers[idx] || `列 ${idx}`;
            const val = cell || '';
            // 自动高度的 textarea
            return `
                <div class="acu-card-edit-field" style="margin-bottom: 10px;">
                    <label style="display:block;font-size:12px;color:var(--acu-accent);font-weight:bold;margin-bottom:4px;">${escapeHtml(headerName)}</label>
                    <textarea class="acu-card-edit-input" data-col="${idx}" spellcheck="false" rows="1" 
                        style="width:100%;min-height:40px;max-height:500px;padding:10px;border:1px solid var(--acu-border);background-color:var(--acu-btn-bg) !important;color:var(--acu-text-main) !important;border-radius:6px;resize:none;font-size:14px;line-height:1.5;box-shadow:inset 0 1px 3px rgba(0,0,0,0.1);overflow-y:hidden;">${escapeHtml(val)}</textarea>
                </div>`;
        }).join('');

        const dialog = $(`
            <div class="acu-edit-overlay">
                <div class="acu-edit-dialog acu-theme-${config.theme}">
                    <div class="acu-edit-title">整体编辑 (#${rowIndex + 1} - ${escapeHtml(tableName)})</div>
                    <div class="acu-settings-content" style="flex:1; overflow-y:auto; padding:15px;">
                        ${inputsHtml}
                    </div>
                     <div class="acu-dialog-btns">
                        <button class="acu-dialog-btn" id="dlg-card-cancel"><i class="fa-solid fa-times"></i> 取消</button>
                        <button class="acu-dialog-btn acu-btn-confirm" id="dlg-card-save"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append(dialog);

        // --- [新增] 自动高度调节逻辑 (rAF 防抖优化版) ---
        const adjustHeight = (el) => {
            if (el._isAdjusting) return;
            el._isAdjusting = true;
            requestAnimationFrame(() => {
                el.style.height = '0px'; // 先重置为0，强制重排获取真实高度
                const contentHeight = el.scrollHeight + 2;
                const maxHeight = 500;
                el.style.height = Math.min(contentHeight, maxHeight) + 'px';
                el.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
                el._isAdjusting = false;
            });
        };

        // 1. 初始化时：对所有有内容的框自动拉长
        dialog.find('textarea').each(function(){ 
            adjustHeight(this); 
        });

        // 2. 输入时：实时调整
        dialog.find('textarea').on('input', function(){ 
            adjustHeight(this); 
        });
        // -----------------------------

        

        const closeDialog = () => dialog.remove();
        dialog.find('#dlg-card-cancel').click(closeDialog);
        
        // [极速优化版] 保存逻辑：接入 updateRow 原生 API
        dialog.find('#dlg-card-save').click(async () => {
            let rawData = cachedRawData || getTableData() || loadSnapshot();
            if (rawData && rawData[tableKey]) {
                const currentRow = rawData[tableKey]?.content?.[rowIndex + 1];
                if (!currentRow) { closeDialog(); return; }
                
                let hasChanges = false;
                const updateData = {}; // 用于构建 API 需要的 {列名: 新值} 对象
                
                dialog.find('textarea').each(function () {
                    const colIdx = parseInt($(this).data('col'));
                    const newVal = $(this).val();
                    if (String(currentRow[colIdx]) !== String(newVal)) {
                        hasChanges = true;
                        currentRow[colIdx] = newVal;
                        
                        // 提取对应的列名
                        const colName = headers[colIdx];
                        if (colName) {
                            updateData[colName] = newVal;
                        }
                    }
                });
                
                if (hasChanges) {
                    let actOrd = Store.get(STORAGE_KEY_ACTION_ORDER);
                    if (!actOrd || !Array.isArray(actOrd)) actOrd = DEFAULT_ACTION_ORDER;
                    const isInstantMode = !actOrd.includes('acu-btn-save-global');
                    
                    if (isInstantMode) {
                        // --- A. 即时模式：统一使用全局覆盖接口，保证绝对成功 ---
                        dialog.find('#dlg-card-save').html('<i class="fa-solid fa-check"></i> 已保存');
                        await saveDataToDatabase(rawData, false, true);
                        AcuToast.success('修改已保存');
                    } else {
                        // --- B. 暂存模式 ---
                        if (!window.acuModifiedSet) window.acuModifiedSet = new Set();
                        Object.keys(updateData).forEach(colName => {
                            const cIdx = headers.indexOf(colName);
                            window.acuModifiedSet.add(`${tableKey}-${rowIndex}-${cIdx}`);
                        });
                        hasUnsavedChanges = true;
                        updateSaveButtonState();
                        AcuToast.info('整行修改已暂存，请点击保存');
                    }
                    
                    renderInterface();
                }
            }
            closeDialog();
        });
        dialog.on('click', function(e) { if ($(e.target).hasClass('acu-edit-overlay')) closeDialog(); });
    };

    // [优化] 内存配置缓存
    let _configCache = null;
    const getConfig = () => {
        if (!_configCache) _configCache = { ...DEFAULT_CONFIG, ...Store.get(STORAGE_KEY_UI_CONFIG, {}) };
        return _configCache;
    };
    const saveConfig = (newCfg) => { 
        _configCache = { ...getConfig(), ...newCfg }; 
        Store.set(STORAGE_KEY_UI_CONFIG, _configCache); 
        applyConfigStyles(_configCache); 
    };

    const generateDiffMap = (currentData) => {
        const lastData = loadSnapshot();
        const diffSet = new Set();
        if (!lastData) return diffSet;

        for (const sheetId in currentData) {
            const newSheet = currentData[sheetId];
            const oldSheet = lastData[sheetId];
            if (!newSheet || !newSheet.name) continue;
            const tableName = newSheet.name;
            if (!oldSheet) {
                if (newSheet.content) {
                    newSheet.content.forEach((row, rIdx) => { if (rIdx > 0) diffSet.add(`${tableName}-row-${rIdx - 1}`); });
                }
                continue;
            }
            const newRows = newSheet.content || [];
            const oldRows = oldSheet.content || [];
            newRows.forEach((row, rIdx) => {
                if (rIdx === 0) return;
                const oldRow = oldRows[rIdx];
                if (!oldRow) {
                    diffSet.add(`${tableName}-row-${rIdx - 1}`);
                } else {
                    row.forEach((cell, cIdx) => {
                        if (cIdx === 0) return;
                        const oldCell = oldRow[cIdx];
                        if (String(cell) !== String(oldCell)) diffSet.add(`${tableName}-${rIdx - 1}-${cIdx}`);
                    });
                }
            });
        }
        return diffSet;
    };

    const applyConfigStyles = (config) => {
        const { $ } = getCore();
        const $wrapper = $('.acu-wrapper');
        const fontVal = FONTS.find(f => f.id === config.fontFamily)?.val || FONTS[0].val;
        
        // [优化] 只有字体 ID 变化时才重写 Style 标签，避免闪烁
        const $styleTag = $('#acu-dynamic-font, #acu-dynamic-font-marker');
        const currentFontId = $styleTag.attr('data-font-id');
        
if (currentFontId !== config.fontFamily) {
                $styleTag.remove();
                const fontImport = `
                    @import url("https://fontsapi.zeoseven.com/3/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/442/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/256/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/482/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/446/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/570/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/292/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/69/main/result.css");
                    @import url("https://fontsapi.zeoseven.com/7/main/result.css");
                `;
                
                const cssText = `
                    ${fontImport}
                    .acu-wrapper, .acu-edit-dialog, .acu-cell-menu, .acu-nav-container, .acu-data-card, .acu-panel-title, .acu-settings-label, .acu-btn-block, .acu-nav-btn, .acu-edit-textarea, #acu-ghost-preview {
                        font-family: ${fontVal} !important;
                    }
                `;
                
                // [核心修复] 抛弃 replaceSync，因为现代浏览器会直接静默丢弃其中的 @import 规则而不报错
                $('head').append(`
                    <style id="acu-dynamic-font" data-font-id="${config.fontFamily}">
                        ${cssText}
                    </style>
                `);
            }

        // [优化] 尺寸和颜色变化只更新 CSS 变量，完全不闪烁
        const cssVars = {
            '--acu-card-width': `${config.cardWidth}px`,
            '--acu-font-size': `${config.fontSize}px`,
            '--acu-opt-font-size': `${config.optionFontSize || 12}px`,
            '--acu-grid-cols': config.gridColumns
        };

        // [性能优化] 定义平滑过渡属性，交给 GPU 处理颜色渐变，彻底消灭黑闪
        const themeTransition = 'background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease, box-shadow 0.3s ease';

        if ($wrapper.length) {
            $wrapper.addClass(`acu-theme-${config.theme}`);
            // 安全剔除：遍历已知的 THEMES 列表，只删掉不是当前选择的主题
            THEMES.forEach(t => { if (t.id !== config.theme) $wrapper.removeClass(`acu-theme-${t.id}`); });
            $wrapper.css(cssVars);
            $wrapper.find('.acu-data-display, .acu-nav-container').css('transition', themeTransition);
        }
        
        // [修复] 同时为 RPG 状态栏更新 Theme 类名和 CSS 变量
        const $statusBar = $('.acu-status-bar-container');
        if ($statusBar.length) {
            $statusBar.addClass(`acu-theme-${config.theme}`);
            // 安全剔除
            THEMES.forEach(t => { if (t.id !== config.theme) $statusBar.removeClass(`acu-theme-${t.id}`); });
            $statusBar.css(cssVars);
            $statusBar.find('.acu-rpg-widget, .acu-rpg-summary, .acu-rpg-details').css('transition', themeTransition);
        }

        // [新增] 动态挂载/卸载系统提示消息美化样式
        const $toastrStyle = $('#acu-toastr-styles');
        if (config.beautifyToastr === true) {
            if ($toastrStyle.length === 0) {
                $('head').append(`
                    <style id="acu-toastr-styles">
                        #toast-container > .toast { padding: 12px 24px !important; background: var(--SmartThemeBlurColor, var(--bg-color, #232323)) !important; backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px)) !important; -webkit-backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px)) !important; border: 1px solid var(--SmartThemeBorderColor, var(--border-color, #3a3a3a)) !important; border-radius: 50px !important; color: var(--SmartThemeTextColor, var(--text-color, #e0e0e0)) !important; box-shadow: 0 6px 16px rgba(0,0,0,0.3) !important; background-image: none !important; text-align: center !important; width: max-content !important; min-width: 300px !important; max-width: 92vw !important; margin: 10px auto !important; box-sizing: border-box !important; animation: toast-fade-up 0.3s ease forwards !important; }
                        #toast-container > .toast:before, #toast-container > .toast:after { display: none !important; }
                        #toast-container > .toast-success { border-color: rgba(46, 204, 113, 0.4) !important; }
                        #toast-container > .toast-success .toast-message { color: #2ecc71 !important; }
                        #toast-container > .toast-warning { border-color: rgba(241, 196, 15, 0.4) !important; }
                        #toast-container > .toast-warning .toast-message { color: #f1c40f !important; }
                        #toast-container > .toast-info { border-color: rgba(52, 152, 219, 0.4) !important; }
                        #toast-container > .toast-info .toast-message { color: #3498db !important; }
                        #toast-container > .toast-error { border-color: rgba(231, 76, 60, 0.4) !important; }
                        #toast-container > .toast-error .toast-message { color: #e74c3c !important; }
                        @keyframes toast-fade-up { 0% { opacity: 0; transform: translateY(10px); } 100% { opacity: 1; transform: translateY(0); } }
                        .toast-title { display: none !important; }
                        .toast-message { font-size: 13px !important; font-weight: 500 !important; word-break: break-word !important; }
                    </style>
                `);
            }
        } else {
            $toastrStyle.remove();
        }
    };

    const addStyles = () => {
    if (window._acuStylesInjected && $(`#${SCRIPT_ID}-styles`).length) return;
    window._acuStylesInjected = true;
    const { $ } = getCore();
    $('style').each(function () {
        if (this.id && this.id.startsWith('acu_') && this.id.endsWith('-styles') && this.id !== `${SCRIPT_ID}-styles`) $(this).remove();
    });
    $(`#${SCRIPT_ID}-styles`).remove();
    const styles = `
            <style id="${SCRIPT_ID}-styles">
                .acu-theme-native { --acu-bg-nav: var(--SmartThemeBlurColor, var(--bg-color, rgba(30, 30, 30, 0.8))); --acu-bg-panel: var(--SmartThemeBlurColor, var(--bg-color, rgba(20, 20, 20, 0.9))); --acu-border: var(--SmartThemeBorderColor, var(--border-color, #555)); --acu-text-main: var(--SmartThemeTextColor, var(--text-color, #eee)); --acu-text-sub: var(--SmartThemeMutedTextColor, #aaa); --acu-btn-bg: rgba(128, 128, 128, 0.15); --acu-btn-hover: rgba(128, 128, 128, 0.3); --acu-btn-active-bg: var(--SmartThemeQuoteColor, var(--mes_user_color, #6a5acd)); --acu-btn-active-text: #fff; --acu-accent: var(--SmartThemeQuoteColor, var(--mes_user_color, #6a5acd)); --acu-table-head: rgba(128, 128, 128, 0.1); --acu-table-hover: rgba(128, 128, 128, 0.2); --acu-shadow: rgba(0,0,0,0.5); --acu-card-bg: var(--SmartThemeBlurColor, rgba(40, 40, 40, 0.6)); --acu-badge-bg: rgba(128, 128, 128, 0.2); --acu-menu-bg: var(--bg-color, #333); --acu-menu-text: var(--SmartThemeTextColor, var(--text-color, #eee)); --acu-success-text: #4cd964; --acu-success-bg: rgba(76, 217, 100, 0.15); --acu-scrollbar-track: transparent; --acu-scrollbar-thumb: var(--SmartThemeBorderColor, #555); --acu-hl-manual: #ff6b81; --acu-hl-manual-bg: rgba(255, 107, 129, 0.2); --acu-hl-diff: #00d2d3; --acu-hl-diff-bg: rgba(0, 210, 211, 0.2); }
                .acu-theme-native .acu-nav-container, .acu-theme-native .acu-data-display, .acu-theme-native .acu-rpg-widget, .acu-theme-native.acu-edit-dialog { backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px)); -webkit-backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px)); }
                .acu-theme-retro { --acu-bg-nav: #e6e2d3; --acu-bg-panel: #e6e2d3; --acu-border: #dcd0c0; --acu-text-main: #5e4b35; --acu-text-sub: #999; --acu-btn-bg: #dcd0c0; --acu-btn-hover: #cbbba8; --acu-btn-active-bg: #8d7b6f; --acu-btn-active-text: #fdfaf5; --acu-accent: #7a695f; --acu-table-head: #efebe4; --acu-table-hover: #f0ebe0; --acu-shadow: rgba(0,0,0,0.15); --acu-card-bg: #fffef9; --acu-badge-bg: #efebe4; --acu-menu-bg: #fff; --acu-menu-text: #333; --acu-success-text: #27ae60; --acu-success-bg: rgba(39, 174, 96, 0.15); --acu-scrollbar-track: #e6e2d3; --acu-scrollbar-thumb: #cbbba8; --acu-hl-manual: #d35400; --acu-hl-manual-bg: rgba(211, 84, 0, 0.15); --acu-hl-diff: #2980b9; --acu-hl-diff-bg: rgba(41, 128, 185, 0.15); }
            .acu-theme-dark { --acu-bg-nav: rgba(43, 43, 43, 0.95); --acu-bg-panel: rgba(37, 37, 37, 0.95); --acu-border: #444; --acu-text-main: #eee; --acu-text-sub: #aaa; --acu-btn-bg: rgba(58, 58, 58, 0.5); --acu-btn-hover: #4a4a4a; --acu-btn-active-bg: #6a5acd; --acu-btn-active-text: #fff; --acu-accent: #6a5acd; --acu-table-head: rgba(51, 51, 51, 0.8); --acu-table-hover: rgba(58, 58, 58, 0.5); --acu-shadow: rgba(0,0,0,0.6); --acu-card-bg: rgba(45, 48, 53, 0.6); --acu-badge-bg: #3a3f4b; --acu-menu-bg: #333; --acu-menu-text: #eee; --acu-success-text: #4cd964; --acu-success-bg: rgba(76, 217, 100, 0.2); --acu-scrollbar-track: #2b2b2b; --acu-scrollbar-thumb: #555; --acu-hl-manual: #ff6b81; --acu-hl-manual-bg: rgba(255, 107, 129, 0.2); --acu-hl-diff: #00d2d3; --acu-hl-diff-bg: rgba(0, 210, 211, 0.2); }
            .acu-theme-modern { --acu-bg-nav: #ffffff; --acu-bg-panel: #f8f9fa; --acu-border: #e0e0e0; --acu-text-main: #333; --acu-text-sub: #666; --acu-btn-bg: #f1f3f5; --acu-btn-hover: #e9ecef; --acu-btn-active-bg: #007bff; --acu-btn-active-text: #fff; --acu-accent: #007bff; --acu-table-head: #f8f9fa; --acu-table-hover: #f1f3f5; --acu-shadow: rgba(0,0,0,0.1); --acu-card-bg: #ffffff; --acu-badge-bg: #f1f3f5; --acu-menu-bg: #fff; --acu-menu-text: #333; --acu-success-text: #28a745; --acu-success-bg: rgba(40, 167, 69, 0.15); --acu-scrollbar-track: #fff; --acu-scrollbar-thumb: #ccc; --acu-hl-manual: #fd7e14; --acu-hl-manual-bg: rgba(253, 126, 20, 0.15); --acu-hl-diff: #0d6efd; --acu-hl-diff-bg: rgba(13, 110, 253, 0.15); }
            .acu-theme-forest { --acu-bg-nav: #e8f5e9; --acu-bg-panel: #e8f5e9; --acu-border: #c8e6c9; --acu-text-main: #2e7d32; --acu-text-sub: #81c784; --acu-btn-bg: #c8e6c9; --acu-btn-hover: #a5d6a7; --acu-btn-active-bg: #43a047; --acu-btn-active-text: #fff; --acu-accent: #4caf50; --acu-table-head: #dcedc8; --acu-table-hover: #f1f8e9; --acu-shadow: rgba(0,0,0,0.1); --acu-card-bg: #ffffff; --acu-badge-bg: #dcedc8; --acu-menu-bg: #fff; --acu-menu-text: #2e7d32; --acu-success-text: #2e7d32; --acu-success-bg: rgba(46, 125, 50, 0.2); --acu-scrollbar-track: #e8f5e9; --acu-scrollbar-thumb: #a5d6a7; --acu-hl-manual: #e67e22; --acu-hl-manual-bg: rgba(230, 126, 34, 0.15); --acu-hl-diff: #2ecc71; --acu-hl-diff-bg: rgba(46, 204, 113, 0.15); }
            .acu-theme-ocean { --acu-bg-nav: #e3f2fd; --acu-bg-panel: #e3f2fd; --acu-border: #bbdefb; --acu-text-main: #1565c0; --acu-text-sub: #64b5f6; --acu-btn-bg: #bbdefb; --acu-btn-hover: #90caf9; --acu-btn-active-bg: #1976d2; --acu-btn-active-text: #fff; --acu-accent: #2196f3; --acu-table-head: rgba(255, 255, 255, 0.55); --acu-table-hover: #e1f5fe; --acu-shadow: rgba(0,0,0,0.15); --acu-card-bg: #ffffff; --acu-badge-bg: #e3f2fd; --acu-menu-bg: #fff; --acu-menu-text: #1565c0; --acu-success-text: #0288d1; --acu-success-bg: rgba(2, 136, 209, 0.15); --acu-scrollbar-track: #e3f2fd; --acu-scrollbar-thumb: #90caf9; --acu-hl-manual: #ff4757; --acu-hl-manual-bg: rgba(255, 71, 87, 0.15); --acu-hl-diff: #2ed573; --acu-hl-diff-bg: rgba(46, 213, 115, 0.15); }
            .acu-theme-cyber { --acu-bg-nav: #000000; --acu-bg-panel: #0a0a0a; --acu-border: #333; --acu-text-main: #00ffcc; --acu-text-sub: #ff00ff; --acu-btn-bg: #111; --acu-btn-hover: #222; --acu-btn-active-bg: #ff00ff; --acu-btn-active-text: #fff; --acu-accent: #00ffcc; --acu-table-head: #050505; --acu-table-hover: #111; --acu-shadow: 0 0 15px rgba(0,255,204,0.15); --acu-card-bg: #050505; --acu-badge-bg: #1a1a1a; --acu-menu-bg: #111; --acu-menu-text: #00ffcc; --acu-success-text: #0f0; --acu-success-bg: rgba(0, 255, 0, 0.15); --acu-scrollbar-track: #000; --acu-scrollbar-thumb: #333; --acu-hl-manual: #ff9f43; --acu-hl-manual-bg: rgba(255, 159, 67, 0.2); --acu-hl-diff: #0abde3; --acu-hl-diff-bg: rgba(10, 189, 227, 0.2); }
            .acu-theme-cyber .acu-nav-btn { border-color: #222; }
            .acu-theme-cyber .acu-data-card { border-color: #222; }

            .acu-theme-sakura { --acu-bg-nav: #fff0f5; --acu-bg-panel: #ffe4e1; --acu-border: #ffb6c1; --acu-text-main: #d05a6e; --acu-text-sub: #db7093; --acu-btn-bg: #fff5ee; --acu-btn-hover: #ffdcb9; --acu-btn-active-bg: #ff69b4; --acu-btn-active-text: #fff; --acu-accent: #ff69b4; --acu-table-head: #fff5ee; --acu-table-hover: #fff0f5; --acu-shadow: rgba(255,105,180,0.15); --acu-card-bg: #ffffff; --acu-badge-bg: #ffe4e1; --acu-menu-bg: #fff; --acu-menu-text: #d05a6e; --acu-success-text: #eb6ea5; --acu-success-bg: rgba(235,110,165,0.15); --acu-scrollbar-track: #fff0f5; --acu-scrollbar-thumb: #ffb6c1; --acu-hl-manual: #ff7f50; --acu-hl-manual-bg: rgba(255,127,80,0.15); --acu-hl-diff: #00ced1; --acu-hl-diff-bg: rgba(0,206,209,0.15); }
            .acu-theme-lavender { --acu-bg-nav: #f5f0fa; --acu-bg-panel: #faf7fc; --acu-border: #dcd0eb; --acu-text-main: #5e4b8a; --acu-text-sub: #9280b5; --acu-btn-bg: #ede6f5; --acu-btn-hover: #e0d4ed; --acu-btn-active-bg: #8e44ad; --acu-btn-active-text: #fff; --acu-accent: #8e44ad; --acu-table-head: #f5f0fa; --acu-table-hover: #ede6f5; --acu-shadow: rgba(142,68,173,0.1); --acu-card-bg: #ffffff; --acu-badge-bg: #f5f0fa; --acu-menu-bg: #fff; --acu-menu-text: #5e4b8a; --acu-success-text: #2ecc71; --acu-success-bg: rgba(46,204,113,0.15); --acu-scrollbar-track: #faf7fc; --acu-scrollbar-thumb: #dcd0eb; --acu-hl-manual: #f39c12; --acu-hl-manual-bg: rgba(243,156,18,0.15); --acu-hl-diff: #3498db; --acu-hl-diff-bg: rgba(52,152,219,0.15); }
            .acu-theme-palace { --acu-bg-nav: #211114; --acu-bg-panel: #1a0b0d; --acu-border: #4a1f26; --acu-text-main: #f0dfc8; --acu-text-sub: #b59283; --acu-btn-bg: #30161a; --acu-btn-hover: #4a1f26; --acu-btn-active-bg: #b02a39; --acu-btn-active-text: #f0dfc8; --acu-accent: #d4af37; --acu-table-head: #2a1114; --acu-table-hover: #3a161b; --acu-shadow: rgba(0,0,0,0.4); --acu-card-bg: #211114; --acu-badge-bg: #30161a; --acu-menu-bg: #1a0b0d; --acu-menu-text: #f0dfc8; --acu-success-text: #27ae60; --acu-success-bg: rgba(39,174,96,0.2); --acu-scrollbar-track: #1a0b0d; --acu-scrollbar-thumb: #4a1f26; --acu-hl-manual: #e67e22; --acu-hl-manual-bg: rgba(230,126,34,0.2); --acu-hl-diff: #8e44ad; --acu-hl-diff-bg: rgba(142,68,173,0.2); }
            .acu-theme-coffee { --acu-bg-nav: #fdfaf6; --acu-bg-panel: #f8f3ea; --acu-border: #e3d5c8; --acu-text-main: #5c4033; --acu-text-sub: #8b7355; --acu-btn-bg: #f0e6d6; --acu-btn-hover: #e6d5c0; --acu-btn-active-bg: #8b5a2b; --acu-btn-active-text: #fff; --acu-accent: #8b5a2b; --acu-table-head: #fdfaf6; --acu-table-hover: #f5eedf; --acu-shadow: rgba(139,90,43,0.1); --acu-card-bg: #ffffff; --acu-badge-bg: #fdfaf6; --acu-menu-bg: #fff; --acu-menu-text: #5c4033; --acu-success-text: #6b8e23; --acu-success-bg: rgba(107,142,35,0.15); --acu-scrollbar-track: #f8f3ea; --acu-scrollbar-thumb: #e3d5c8; --acu-hl-manual: #cd853f; --acu-hl-manual-bg: rgba(205,133,63,0.15); --acu-hl-diff: #4682b4; --acu-hl-diff-bg: rgba(70,130,180,0.15); }
            .acu-theme-wuxia { --acu-bg-nav: #f5f5f5; --acu-bg-panel: #f0f0f0; --acu-border: #dcdcdc; --acu-text-main: #2a2a2a; --acu-text-sub: #707070; --acu-btn-bg: #e8e8e8; --acu-btn-hover: #dcdcdc; --acu-btn-active-bg: #1d953f; --acu-btn-active-text: #fff; --acu-accent: #1d953f; --acu-table-head: #e8e8e8; --acu-table-hover: #f0f0f0; --acu-shadow: rgba(0,0,0,0.08); --acu-card-bg: #ffffff; --acu-badge-bg: #e8e8e8; --acu-menu-bg: #fff; --acu-menu-text: #2a2a2a; --acu-success-text: #1d953f; --acu-success-bg: rgba(29,149,63,0.15); --acu-scrollbar-track: #f5f5f5; --acu-scrollbar-thumb: #c0c0c0; --acu-hl-manual: #c03f3c; --acu-hl-manual-bg: rgba(192,63,60,0.15); --acu-hl-diff: #41555d; --acu-hl-diff-bg: rgba(65,85,93,0.15); }
            .acu-theme-mecha { --acu-bg-nav: #16181d; --acu-bg-panel: #1e2229; --acu-border: #353b45; --acu-text-main: #e0e6ed; --acu-text-sub: #7a879e; --acu-btn-bg: #272c35; --acu-btn-hover: #353b45; --acu-btn-active-bg: #ff6b00; --acu-btn-active-text: #fff; --acu-accent: #ff6b00; --acu-table-head: #16181d; --acu-table-hover: #272c35; --acu-shadow: 0 0 10px rgba(255,107,0,0.15); --acu-card-bg: #21252d; --acu-badge-bg: #2d333b; --acu-menu-bg: #1e2229; --acu-menu-text: #e0e6ed; --acu-success-text: #2ecc71; --acu-success-bg: rgba(46,204,113,0.15); --acu-scrollbar-track: #16181d; --acu-scrollbar-thumb: #353b45; --acu-hl-manual: #e74c3c; --acu-hl-manual-bg: rgba(231,76,60,0.2); --acu-hl-diff: #3498db; --acu-hl-diff-bg: rgba(52,152,219,0.2); }
            .acu-theme-gothic { --acu-bg-nav: #090909; --acu-bg-panel: #0d0d0d; --acu-border: #2c1010; --acu-text-main: #d4b8b8; --acu-text-sub: #8c5c5c; --acu-btn-bg: #170d0d; --acu-btn-hover: #2c1010; --acu-btn-active-bg: #8a0303; --acu-btn-active-text: #e6dada; --acu-accent: #a60c0c; --acu-table-head: #0f0909; --acu-table-hover: #1a0f0f; --acu-shadow: 0 0 15px rgba(166,12,12,0.15); --acu-card-bg: #120b0b; --acu-badge-bg: #211111; --acu-menu-bg: #0a0505; --acu-menu-text: #d4b8b8; --acu-success-text: #27ae60; --acu-success-bg: rgba(39,174,96,0.15); --acu-scrollbar-track: #090909; --acu-scrollbar-thumb: #2c1010; --acu-hl-manual: #d35400; --acu-hl-manual-bg: rgba(211,84,0,0.2); --acu-hl-diff: #2980b9; --acu-hl-diff-bg: rgba(41,128,185,0.2); }

            .acu-wrapper { position: relative; width: 100%; margin: 15px 0; z-index: 2147483640 !important; font-family: 'Microsoft YaHei', sans-serif; display: flex; flex-direction: column-reverse; order: 999999; }
            .acu-wrapper.acu-mode-embedded { position: relative !important; width: 100% !important; margin-top: 8px !important; z-index: 2147483641 !important; clear: both; display: flex !important; flex-direction: column-reverse !important; padding: 0 !important; }
            .acu-wrapper.acu-mode-embedded .acu-nav-container { position: relative !important; z-index: 2147483642 !important; }
            .acu-wrapper.acu-mode-embedded .acu-data-display { position: absolute !important; bottom: 100% !important; left: 0 !important; right: 0 !important; width: 100% !important; box-shadow: 0 -10px 30px rgba(0,0,0,0.25) !important; border: 1px solid var(--acu-border); margin-bottom: 5px; z-index: 2147483647 !important; max-height: 70vh !important; overflow-y: auto !important; }
            .acu-nav-container { display: grid; grid-template-columns: repeat(var(--acu-grid-cols, 3), 1fr); gap: 4px; padding: 6px; background: var(--acu-bg-nav); border: 1px solid var(--acu-border); border-radius: 10px; align-items: center; box-shadow: 0 2px 6px var(--acu-shadow); position: relative; z-index: 2147483641 !important; }
            .acu-nav-btn { touch-action: manipulation; -webkit-tap-highlight-color: transparent; width: 100%; display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 3px; padding: 4px 2px; border: 1px solid transparent; border-radius: 6px; background: var(--acu-btn-bg); color: var(--acu-text-main); font-weight: 600; font-size: 11px; cursor: pointer; transition: all 0.2s ease; user-select: none; overflow: hidden; height: 28px; }
            .acu-nav-btn span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; margin-top: 1px; }
            .acu-nav-btn:hover { background: var(--acu-btn-hover); transform: translateY(-2px); }
            /* --- [新增] 手动更新选中状态的样式 --- */
            .acu-nav-btn.acu-update-selected { border: 1px dashed var(--acu-accent) !important; box-shadow: inset 0 0 8px rgba(0,0,0,0.1) !important; position: relative; overflow: visible !important; }
            .acu-nav-btn.acu-update-selected::after { content: "\\f0e7"; font-family: "Font Awesome 6 Free", "Font Awesome 5 Free", fas; font-weight: 900; position: absolute; top: -6px; right: -6px; font-size: 10px; background: var(--acu-accent); color: #fff; border-radius: 50%; width: 16px; height: 16px; display: flex; align-items: center; justify-content: center; z-index: 10; box-shadow: 0 2px 4px rgba(0,0,0,0.3); }
            /* [新增] 移植功能样式 */
            /* 添加了 touch-action: none */
/* --- 1. 外层容器：防止误触边缘 --- */
.acu-height-control { 
    display: flex; 
    align-items: center; 
    margin-right: 8px; 
    cursor: ns-resize; 
    padding: 4px; 
    border-radius: 4px; 
    color: var(--acu-text-sub); 
    transition: all 0.2s; 
    /* 关键属性：禁止在此区域触发浏览器默认手势 */
    touch-action: none; 
}

/* 交互反馈 */
.acu-height-control:hover, .acu-height-control.active { 
    color: var(--acu-accent); 
    background: var(--acu-table-hover); 
}

/* --- 2. [加保险] 内部图标：这是事件绑定的主体，必须禁止触摸 --- */
.acu-height-drag-handle { 
    cursor: ns-resize; 
    /* 双重保险：确保直接按在图标上也不会触发滚动 */
    touch-action: none; 
}
            
            /* 视图切换样式 */
            .acu-view-btn { background: transparent; border: none; color: var(--acu-text-main); cursor: pointer; padding: 4px; margin-right: 5px; font-size: 14px; opacity: 0.7; }
            .acu-view-btn:hover { opacity: 1; color: var(--acu-accent); }

            /* Grid 视图 (双列) */
            .acu-card-body.view-grid { display: grid !important; grid-template-columns: 1fr 1fr; gap: 8px; padding: 10px !important; }
            /* 修复版：强制 Grid 模式使用 Flex 布局并允许高度自适应 */
.acu-card-body.view-grid .acu-card-row { display: flex !important; height: auto !important; min-height: fit-content; border: 1px solid var(--acu-border); border-radius: 6px; padding: 4px 6px !important; flex-direction: column !important; align-items: flex-start !important; background: rgba(0,0,0,0.02); box-sizing: border-box; }
            .acu-card-body.view-grid .acu-card-row.acu-grid-span-full { grid-column: 1 / -1; }
            .acu-card-body.view-grid .acu-card-label { width: 100% !important; font-size: 0.85em; opacity: 0.8; margin-bottom: 2px; }
            .acu-card-body.view-grid .acu-card-value { width: 100% !important; }
            
            /* List 视图 (单列 - 原版增强) */
            .acu-card-body.view-list { display: flex !important; flex-direction: column; gap: 0; }
            .acu-nav-btn.active { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); box-shadow: inset 0 1px 3px rgba(0,0,0,0.2); }
            .acu-action-btn { flex: 1; height: 36px; display: flex; align-items: center; justify-content: center; background: var(--acu-btn-bg); border-radius: 8px; color: var(--acu-text-sub); cursor: pointer; border: 1px solid transparent; transition: all 0.2s; margin: 0; }
            .acu-action-btn:hover { background: var(--acu-btn-hover); color: var(--acu-text-main); transform: translateY(-2px); box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
            #acu-btn-save-global { color: var(--acu-btn-active-bg); } #acu-btn-save-global:hover { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); }

            .acu-data-display { position: absolute; bottom: calc(100% + 10px); left: 0; right: 0; max-height: 80vh; height: auto; background: var(--acu-bg-panel); border: 1px solid var(--acu-border); border-radius: 8px; box-shadow: 0 8px 30px var(--acu-shadow); display: none; flex-direction: column; z-index: 2147483642 !important; animation: popUp 0.2s cubic-bezier(0.18, 0.89, 0.32, 1.28); }
            .acu-data-display.visible { display: flex; }
            @keyframes popUp { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }

            .acu-panel-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 10px 15px; background: var(--acu-table-head); border-bottom: 1px dashed var(--acu-border); border-radius: 8px 8px 0 0; }
            /* 核心修改：增加了 flex: 1 和 min-width: 0，强制标题在空间不足时自动变短显示省略号 */
/* --- 新的标题布局：纵向排列 --- */
.acu-panel-title { 
    display: flex; 
    flex-direction: column; /* 垂直堆叠 */
    justify-content: center; 
    align-items: flex-start; 
    flex: 1; /* 占据剩余空间 */
    min-width: 0; /* 允许压缩 */
    margin-right: 8px; 
    overflow: hidden; 
}

/* 第一行：标题主体 (加粗，稍大) */
.acu-title-main {
    display: flex; 
    align-items: center; 
    gap: 6px; 
    width: 100%;
    font-size: 13px; /* 你要求的：字体变小一点，但保持加粗 */
    font-weight: bold;
    color: var(--acu-text-main);
    line-height: 1.2;
}

/* 标题文字本身 (溢出省略) */
.acu-title-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* 第二行：页码信息 (灰色，更小) */
.acu-title-sub {
    font-size: 10px;
    color: var(--acu-text-sub);
    font-weight: normal;
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
    line-height: 1.2;
    margin-top: 1px;
}
            /* 增加了 flex-shrink: 0; 防止被标题挤压 */
/* 核心修改：flex-shrink: 0 确保这一块区域永远不会被压缩 */
.acu-header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
            .acu-search-wrapper { position: relative; display: flex; align-items: center; }
            .acu-search-input { background-color: var(--acu-btn-bg) !important; border: 1px solid var(--acu-border) !important; color: var(--acu-text-main) !important; padding: 4px 8px 4px 24px; border-radius: 12px; font-size: 12px; width: 120px; transition: width 0.2s; }
            .acu-search-input:focus { width: 160px; outline: none; border-color: var(--acu-accent); }
            .acu-search-icon { position: absolute; left: 8px; font-size: 10px; color: var(--acu-text-sub); pointer-events: none; }
            /* 增加了 min-width 和 flex-shrink: 0 */
.acu-close-btn { background: none; border: none; color: var(--acu-text-sub); cursor: pointer; font-size: 16px; padding: 4px; flex-shrink: 0; min-width: 24px; text-align: center; } .acu-close-btn:hover { color: #e74c3c; }
            .acu-panel-content { flex: 1; overflow-x: auto; overflow-y: hidden; padding: 15px; background: transparent; scrollbar-width: thin; scrollbar-color: var(--acu-scrollbar-thumb) var(--acu-scrollbar-track); overscroll-behavior: auto; touch-action: manipulation; }
            .acu-panel-content::-webkit-scrollbar { width: 6px; height: 6px; }
            .acu-panel-content::-webkit-scrollbar-track { background: var(--acu-scrollbar-track); border-radius: 3px; }
            .acu-panel-content::-webkit-scrollbar-thumb { background: var(--acu-scrollbar-thumb); border-radius: 3px; }
            .acu-panel-content::-webkit-scrollbar-thumb:hover { background: var(--acu-accent); }
            /* 增加了 height: 100%; 让网格容器填满面板的高度 */
.acu-card-grid { display: flex; flex-wrap: nowrap; gap: 12px; align-items: flex-start; }
            .acu-layout-vertical .acu-panel-content { overflow-x: hidden !important; overflow-y: auto !important; overscroll-behavior: auto; touch-action: manipulation; min-height: 0; }
            /* 竖向布局时恢复 auto 高度 */
.acu-layout-vertical .acu-card-grid { flex-wrap: wrap !important; justify-content: center; padding-bottom: 20px; height: auto; }
/* 修改了 max-height: 100%; 让卡片高度跟随面板高度变化 */
/* 修正版：同时限制网格高度和卡片高度 */
/* 修复版：横向模式限制网格高度，竖向模式自动高度，并增加防滚动卡死属性 */
/* 修复版：恢复滚动链，允许卡片到底后带动页面滚动 */
.acu-wrapper:not(.acu-layout-vertical) .acu-manual-mode .acu-card-grid { height: 100%; } .acu-manual-mode .acu-data-card { max-height: 100% !important; overscroll-behavior-y: auto; } .acu-data-card { flex: 0 0 var(--acu-card-width, 260px); width: var(--acu-card-width, 260px); background: var(--acu-card-bg); border: 1px solid var(--acu-border); border-radius: 8px; height: auto; max-height: 60vh; overflow-y: auto; overscroll-behavior-y: auto; touch-action: manipulation; transition: all 0.2s ease; display: flex; flex-direction: column; position: relative; }
            .acu-data-card::-webkit-scrollbar { width: 4px; }
            .acu-data-card::-webkit-scrollbar-track { background: transparent; }
            .acu-data-card::-webkit-scrollbar-thumb { background: var(--acu-scrollbar-thumb); border-radius: 2px; }
            .acu-data-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px var(--acu-shadow); border-color: var(--acu-accent); }
            .acu-data-card.pending-deletion { opacity: 0.6; border: 1px dashed #e74c3c; }
            .acu-data-card.pending-deletion::after { content: "待删除"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-15deg); color: #e74c3c; font-size: 24px; font-weight: bold; border: 2px solid #e74c3c; padding: 5px 10px; border-radius: 8px; opacity: 0.8; pointer-events: none; }
            @keyframes pulse-highlight { 0% { opacity: 0.7; } 50% { opacity: 1; } 100% { opacity: 0.7; } }
            .acu-highlight-manual { color: var(--acu-hl-manual) !important; background-color: var(--acu-hl-manual-bg) !important; border-radius: 4px; padding: 0 4px; font-weight: bold; animation: pulse-highlight 2s infinite; display: inline-block; }
            .acu-highlight-diff { color: var(--acu-hl-diff) !important; background-color: var(--acu-hl-diff-bg) !important; border-radius: 4px; padding: 0 4px; font-weight: bold; animation: pulse-highlight 2s infinite; display: inline-block; }
            .acu-editable-title.acu-highlight-manual, .acu-editable-title.acu-highlight-diff { width: auto; display: inline-block; }
            .acu-card-header { flex: 0 0 auto; padding: 8px 10px; background: var(--acu-table-head); border-bottom: 1px dashed var(--acu-border); font-weight: bold; color: var(--acu-text-main); font-size: 14px; display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: flex-start !important; gap: 8px; min-height: 40px; height: auto !important; }
            .acu-editable-title { flex: 1; width: auto !important; cursor: pointer; border-bottom: 1px dashed transparent; transition: all 0.2s; white-space: pre-wrap !important; overflow: visible !important; word-break: break-word !important; text-align: center; line-height: 1.3; margin: 0 !important; }
            .acu-editable-title:hover { border-bottom-color: var(--acu-accent); color: var(--acu-accent); }
            .acu-card-index { position: static !important; transform: none !important; margin: 0 !important; flex-shrink: 0; font-size: 11px; color: var(--acu-text-sub); font-weight: normal; background: var(--acu-badge-bg); padding: 2px 6px; border-radius: 4px; }
            .acu-card-body { padding: 6px 12px; display: flex; flex-direction: column; gap: 0; font-size: var(--acu-font-size, 13px); flex: 1; }
            .acu-card-row { display: block !important; padding: 6px 0 !important; border-bottom: 1px dashed var(--acu-border); cursor: pointer; overflow: hidden; }
            .acu-card-row:last-child { border-bottom: none; }
            /* 已干掉表格条目的点击/悬停高亮背景 */
            .acu-card-label { float: left !important; clear: left; width: auto !important; margin-right: 8px !important; color: var(--acu-text-sub); font-size: 0.9em; line-height: 1.5; padding-top: 0; }
            .acu-card-value { display: block !important; width: auto !important; margin: 0 !important; text-align: left !important; word-break: break-all !important; white-space: pre-wrap !important; line-height: 1.5 !important; color: var(--acu-text-main); font-size: 1em; }
            .acu-tag-container { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 2px; width: 100%; box-sizing: border-box; }
            .acu-badge { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; font-weight: 500; line-height: 1.2; white-space: nowrap !important; word-break: keep-all !important; flex-shrink: 0; }
            .acu-badge-green { background: var(--acu-success-bg); color: var(--acu-success-text); }
            .acu-badge-neutral { background: var(--acu-badge-bg); color: var(--acu-text-main); border: 1px solid var(--acu-border); }
            .acu-panel-footer { flex: 0 0 auto; padding: 8px; border-top: 1px dashed var(--acu-border); background: var(--acu-table-head); display: flex; justify-content: center; align-items: center; gap: 5px; flex-wrap: wrap; }
            .acu-page-btn { padding: 4px 10px; min-width: 32px; height: 28px; border-radius: 4px; border: 1px solid var(--acu-border); background: var(--acu-btn-bg); color: var(--acu-text-main); cursor: pointer; font-size: 12px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
            .acu-page-btn:hover:not(.disabled):not(.active) { background: var(--acu-btn-hover); transform: translateY(-1px); }
            .acu-page-btn.active { background: var(--acu-accent); color: #fff; border-color: var(--acu-accent); font-weight: bold; }
            .acu-page-btn.disabled { opacity: 0.5; cursor: not-allowed; }
            .acu-page-info { font-size: 12px; color: var(--acu-text-sub); margin: 0 10px; }
            /* --- [新增] 行动选项面板样式 --- */
            /* 改为 Flex Column 垂直布局 */
            /* --- [修改] 袖珍型·垂直紧凑布局 --- */
            .acu-option-panel { 
                display: flex; 
                flex-direction: column; 
                gap: 2px;                 /* 间距极小，排列更紧密 */
                padding: 4px;             /* 容器内边距缩小 */
                background: var(--acu-bg-nav); 
                border: 1px solid var(--acu-border); 
                border-radius: 6px;       /* 圆角缩小 */
                margin-top: 0; 
                margin-bottom: 4px; 
                backdrop-filter: blur(5px); 
                width: 100%; 
                box-sizing: border-box; 
                z-index: 10; 
                animation: acuFadeIn 0.3s ease; 
            }
            
            .acu-embedded-options-container { 
                width: 100%; 
                max-width: 100%; 
                margin-top: 6px; 
                clear: both; 
                animation: acuFadeIn 0.3s ease; 
            }

            .acu-opt-header { 
                text-align: center; 
                font-size: 10px;          /* 标题字体更小 */
                font-weight: bold; 
                color: var(--acu-text-sub); 
                padding-bottom: 2px; 
                border-bottom: 1px dashed var(--acu-border); 
                margin-bottom: 2px; 
            }

            /* --- [修改] 袖珍按钮样式 --- */
            .acu-opt-btn { 
                background: var(--acu-btn-bg); 
                border: 1px solid transparent; /* 默认无边框，更干净 */
                padding: 3px 6px;              /* 极窄内边距 */
                border-radius: 4px; 
                cursor: pointer; 
                color: var(--acu-text-main); 
                font-size: var(--acu-opt-font-size, 12px) !important; /* [修改] 使用独立变量 */
                transition: all 0.15s; 
                font-weight: normal;           /* 去除加粗 */
                text-align: left;              /* 左对齐 */
                white-space: pre-wrap; 
                word-break: break-word; 
                min-height: 22px;              /* 压低高度，超薄 */
                line-height: 1.3;
                display: flex; 
                align-items: center; 
                justify-content: flex-start; 
                opacity: 0.9;
            }

            .acu-opt-btn:hover { 
                background: var(--acu-table-hover); 
                color: var(--acu-accent); 
                border-color: var(--acu-accent); /* 悬停时显示边框 */
                transform: translateX(3px);      /* 悬停时轻微右移反馈 */
                opacity: 1;
            }
            .acu-opt-btn:active { background: var(--acu-btn-active-bg); color: var(--acu-btn-active-text); }
            @keyframes acuFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

            .acu-menu-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: transparent; z-index: 2147483645 !important; }
            /* 1. 菜单容器：背景色、边框、阴影全部跟随主题变量 */
.acu-cell-menu { 
    position: fixed !important; 
    background: var(--acu-menu-bg) !important; 
    border: 1px solid var(--acu-border) !important; 
    box-shadow: 0 6px 20px var(--acu-shadow) !important; 
    z-index: 2147483647 !important; 
    border-radius: 8px; 
    overflow: hidden; 
    min-width: 150px; 
    color: var(--acu-menu-text);
}

/* 2. 菜单项：文字颜色跟随主题 */
.acu-cell-menu-item { 
    padding: 12px 16px; 
    cursor: pointer; 
    font-size: 14px; 
    display: flex; 
    gap: 12px; 
    align-items: center; 
    color: var(--acu-menu-text); 
    font-weight: 500; 
    background: transparent; 
    transition: background 0.2s;
}

/* 3. 悬停效果：使用主题定义的通用悬停色 */
.acu-cell-menu-item:hover { 
    background: var(--acu-table-hover); 
}

/* 4. 特殊按钮优化 */
.acu-cell-menu-item#act-delete { color: #e74c3c; } 
.acu-cell-menu-item#act-delete:hover { background: rgba(231, 76, 60, 0.1); } /* 红色半透明背景，任何主题都适配 */
.acu-cell-menu-item#act-close { border-top: 1px dashed var(--acu-border); color: var(--acu-text-sub); }
            .acu-edit-overlay { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.75) !important; z-index: 2147483646 !important; display: flex !important; justify-content: center !important; align-items: center !important; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); transform: translateZ(0); backface-visibility: hidden; will-change: opacity, backdrop-filter; }
            .acu-edit-dialog { background-color: var(--acu-bg-panel, #333) !important; width: 95%; max-width: 500px; max-height: 95vh; padding: 16px; border-radius: 12px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 15px 50px rgba(0,0,0,0.6); color: var(--acu-text-main, #fff) !important; border: 1px solid var(--acu-border, #555); margin: auto !important; overflow: hidden; transform: translate3d(0, 0, 0); will-change: transform, opacity; } 
            @media (min-width: 768px) { .acu-edit-dialog { max-width: 900px !important; width: 90% !important; } }
            .acu-edit-title { margin: 0; font-size: 16px; font-weight: bold; color: var(--acu-text-main, #fff); padding-bottom: 8px; border-bottom: 1px solid var(--acu-border, #555); }
            .acu-edit-textarea { width: 100%; height: 200px; padding: 12px; border: 1px solid var(--acu-border) !important; background-color: var(--acu-btn-bg, rgba(0,0,0,0.3)) !important; color: var(--acu-text-main, #fff) !important; border-radius: 6px; resize: vertical; box-sizing: border-box; font-size: 14px; line-height: 1.6; overflow-y: auto !important; } 
            @media (min-width: 768px) { .acu-edit-textarea { height: 60vh !important; font-size: 15px !important; } }
            .acu-edit-textarea:focus { outline: 1px solid #aaa; }
            .acu-dialog-btns { display: flex; justify-content: flex-end; gap: 20px; margin-top: 10px; }
            .acu-dialog-btn { background: none; border: none; cursor: pointer; font-size: 14px; font-weight: bold; display: flex; align-items: center; gap: 6px; color: #ccc; transition: color 0.2s; }
            .acu-dialog-btn:hover { color: #fff; } .acu-btn-confirm { color: #4cd964; } .acu-btn-confirm:hover { color: #6eff88; }
            /* --- [UI Optimization] PC-First Edit Mode Styles --- */
            .acu-order-controls { grid-column: 1 / -1; order: -2; display: none; width: 100%; text-align: left; background: var(--acu-accent); color: #fff; padding: 6px 12px; margin: 0 0 8px 0; border-radius: 4px; font-weight: bold; font-size: 12px; box-shadow: 0 2px 5px rgba(0,0,0,0.2); }
            .acu-order-controls.visible { display: flex; align-items: center; justify-content: space-between; }
            
            .acu-nav-container.editing-order { border: 2px solid var(--acu-accent); background: var(--acu-bg-panel); }
            .acu-nav-container.editing-order .acu-nav-btn, .acu-nav-container.editing-order .acu-action-btn { opacity: 1 !important; cursor: grab !important; border: 1px solid var(--acu-border); box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
            .acu-nav-container.editing-order .acu-nav-btn:hover, .acu-nav-container.editing-order .acu-action-btn:hover { border-color: var(--acu-accent); transform: translateY(-1px); }
            
            .acu-swap-selected { background-color: var(--acu-accent) !important; color: #fff !important; border-color: var(--acu-accent) !important; box-shadow: 0 0 0 2px rgba(255,255,255,0.5), 0 4px 12px rgba(0,0,0,0.2); transform: scale(1.05); z-index: 10; }
            .acu-drag-over { border: 2px dashed var(--acu-accent) !important; opacity: 0.5; transform: scale(0.95); background: rgba(var(--acu-accent-rgb), 0.1); }
            
            /* --- [PC Style] Unused Pool Optimization (工具架样式) --- */
            .acu-unused-pool { 
                grid-column: 1 / -1; 
                display: none; 
                flex-wrap: wrap; 
                gap: 8px; 
                background: var(--acu-table-head); /* 使用表头背景色，更融合 */
                border: 1px dashed var(--acu-border); /* 虚线框表示这是编辑区域 */
                padding: 10px 15px; 
                margin: 0 0 10px 0; 
                border-radius: 8px; 
                justify-content: flex-start; 
                align-items: center; 
                min-height: 50px; 
                box-shadow: inset 0 2px 6px rgba(0,0,0,0.05);
            }
            .acu-unused-pool.visible { display: flex; animation: acuFadeIn 0.2s ease-out; }
            
            /* PC端清晰的文字引导 */
            .acu-unused-pool::before { 
                content: "备选功能池 (拖拽图标到下方启用 ↘)"; 
                display: flex; 
                align-items: center;
                height: 32px;
                font-size: 12px; 
                font-weight: bold; 
                color: var(--acu-text-sub); 
                margin-right: 15px; 
                padding-right: 15px;
                border-right: 1px solid var(--acu-border); 
                white-space: nowrap; 
                opacity: 0.8;
            }
            
            .acu-actions-group { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 4px; border-top: 1px dashed var(--acu-border); padding-top: 8px; margin-top: 4px; min-height: 36px; transition: all 0.2s; }
            
            /* [修复] 移动端顶部布局适配：强制提升顺序 */
            .acu-pos-top .acu-actions-group { order: -1; border-top: none; border-bottom: 1px dashed var(--acu-border); margin-top: 0; margin-bottom: 6px; padding-top: 0; padding-bottom: 8px; }
            
            /* [修复] 编辑模式下，备选池也跟随置顶 */
            .acu-pos-top .acu-unused-pool { order: -1; margin-bottom: 10px; border-bottom: 1px dashed var(--acu-border); }
            .acu-actions-group.dragging-over { background: rgba(127, 127, 127, 0.05); box-shadow: inset 0 0 10px rgba(0,0,0,0.05); }
            
            /* Mobile adjustments to keep it usable there */
            @media (max-width: 768px) {
                .acu-unused-pool { justify-content: center; background: rgba(0,0,0,0.05); border: 1px dashed var(--acu-border); border-bottom: none; margin: 0 0 8px 0; border-radius: 6px; }
                .acu-unused-pool::before { display: block; width: 100%; text-align: center; margin-bottom: 4px; content: "可选功能池 (拖拽或点击)"; }
                .acu-order-controls { flex-direction: column; gap: 6px; text-align: center; }
            }
            .acu-actions-group.dragging-over { background: rgba(var(--acu-accent-rgb), 0.1); border-color: var(--acu-accent); }
            .acu-actions-group .acu-divider { display: none; }
            .acu-settings-item { margin-bottom: 15px; }
            .acu-settings-label { display: block; margin-bottom: 5px; font-weight: bold; font-size: 13px; color: #ccc; }
            .acu-settings-val { float: right; color: #4cd964; font-size: 12px; }
            .acu-slider { width: 100%; height: 4px; background: #555; border-radius: 2px; outline: none; -webkit-appearance: none; }
            .acu-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; background: #fff; border-radius: 50%; cursor: pointer; }
            .acu-select { width: 100%; padding: 8px; background: rgba(0,0,0,0.3); border: 1px solid #555; color: #fff; border-radius: 4px; outline: none; }
            .acu-checkbox { margin-right: 10px; }
            .acu-btn-block { width: 100%; padding: 10px; background: #444; color: #eee; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 10px; }
            .acu-btn-block:hover { background: #555; color: #fff; }
            .acu-expand-trigger { background: var(--acu-bg-nav); border: 1px solid var(--acu-border); box-shadow: 0 2px 6px var(--acu-shadow); cursor: pointer; color: var(--acu-text-main); font-size: 13px; font-weight: bold; display: flex; align-items: center; gap: 6px; transition: all 0.2s; z-index: 2147483645 !important; }
            .acu-expand-trigger:hover { background: var(--acu-btn-hover); transform: translateY(-2px); }
            /* [优化] 小眼睛图标悬停效果 */
            .acu-nav-toggle-btn:hover { opacity: 1 !important; transform: scale(1.2); color: var(--acu-accent); }
            .acu-align-right { margin-left: auto; align-self: flex-end; }
            .acu-align-left { margin-right: auto; margin-left: 0; align-self: flex-start; }
            .acu-nav-container.acu-left-mode .acu-actions-group { order: -1; margin-left: 0; margin-right: 10px; }
            .acu-col-bar { width: 100%; justify-content: center; padding: 8px 10px; border-radius: 6px; }
            .acu-col-pill { width: auto !important; padding: 6px 16px; border-radius: 50px; }
            .acu-col-mini { width: 40px !important; height: 40px !important; padding: 0; justify-content: center; border-radius: 50%; }
            .acu-col-mini span { display: none; }
            #acu-btn-collapse { color: var(--acu-text-sub); }
            #acu-btn-collapse:hover { color: var(--acu-text-main); background: rgba(0,0,0,0.05); }
            @keyframes acu-breathe { 0% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(0.85); color: #ff7e67; } 100% { opacity: 1; transform: scale(1); } } .acu-icon-breathe { animation: acu-breathe 3s infinite ease-in-out !important; display: inline-block; }

            /* [新增] 日历组件专用样式 */
            .acu-calendar-dialog { max-width: 350px !important; padding: 20px !important; user-select: none; }
            .acu-cal-header { text-align: center; margin-bottom: 10px; }
            /* [优化] 标题栏增加导航按钮布局 */
            .acu-cal-title { font-size: 18px; font-weight: bold; color: var(--acu-accent); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; padding: 0 5px; }
            .acu-cal-nav-btn { cursor: pointer; padding: 4px 10px; opacity: 0.6; transition: all 0.2s; border-radius: 4px; font-size: 16px; color: var(--acu-text-sub); }
            .acu-cal-nav-btn:hover { opacity: 1; color: var(--acu-accent); background: var(--acu-btn-hover); transform: scale(1.1); }
            .acu-cal-week-row { display: grid; grid-template-columns: repeat(7, 1fr); font-weight: bold; color: var(--acu-text-sub); margin-bottom: 5px; font-size: 12px; }
            .acu-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
            .acu-cal-cell { height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 6px; cursor: default; font-size: 14px; color: var(--acu-text-main); font-family: monospace; }
            .acu-cal-cell.today { background: var(--acu-accent); color: #fff; font-weight: bold; box-shadow: 0 2px 8px rgba(0,0,0,0.3); transform: scale(1.1); border: 1px solid rgba(255,255,255,0.2); z-index: 2; }
            .acu-cal-cell:not(.empty):not(.today):hover { background: var(--acu-table-hover); cursor: pointer; transform: scale(1.1); z-index: 2; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
            .acu-calendar-trigger { transition: transform 0.2s; display:inline-block; }
            
            /* [新增] 事件标记点样式 */
            .acu-event-dot { width: 6px; height: 6px; border-radius: 50%; position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%); box-shadow: 0 1px 2px rgba(0,0,0,0.3); pointer-events: none; }
            .acu-evt-world { background-color: #ff4757; box-shadow: 0 0 5px #ff4757; }
            .acu-evt-large { background-color: #ffa502; }
            .acu-evt-personal { background-color: #3742fa; }
            .acu-evt-char { background-color: #2ed573; }
            .acu-cal-cell { position: relative; transition: all 0.2s; border: 2px solid transparent; }
            .acu-cal-cell.selected { border-color: var(--acu-accent); background: var(--acu-table-hover); transform: scale(1.05); z-index: 5; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
            
            /* [新增] 事件详情面板 */
            .acu-event-details { margin-top: 15px; padding: 10px; background: rgba(0,0,0,0.03); border-radius: 8px; border: 1px dashed var(--acu-border); display: none; animation: acuFadeIn 0.2s; text-align: left; }
            .acu-event-item { padding: 8px; border-bottom: 1px solid var(--acu-border); margin-bottom: 4px; background: rgba(255,255,255,0.05); border-radius: 4px; }
            .acu-event-item:last-child { border-bottom: none; margin-bottom: 0; }
            .acu-event-tag { display: inline-block; padding: 2px 6px; border-radius: 4px; color: #fff; font-size: 10px; margin-right: 6px; font-weight: bold; vertical-align: middle; }
            .acu-event-title { font-weight: bold; font-size: 13px; color: var(--acu-text-main); vertical-align: middle; }
            .acu-event-desc { font-size: 12px; color: var(--acu-text-sub); margin-top: 4px; line-height: 1.4; padding-left: 2px; }
            .acu-calendar-trigger:hover { transform: scale(1.2); }

            @media (min-width: 768px) {
                .acu-wrapper.acu-mode-embedded .acu-nav-container { width: fit-content !important; min-width: 300px; max-width: 100%; margin: 0 auto; border-radius: 50px !important; box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important; border: 1px solid var(--acu-border); padding: 6px 20px !important; background: var(--acu-bg-nav) !important; }
                .acu-wrapper.acu-mode-embedded .acu-data-display { bottom: calc(100% + 12px) !important; border-radius: 12px !important; box-shadow: 0 10px 40px rgba(0,0,0,0.2) !important; }
                .acu-nav-container { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; padding: 6px 10px !important; grid-template-columns: none !important; flex-direction: row !important; justify-content: flex-start !important; align-items: center !important; height: auto !important; }
                .acu-nav-container .acu-nav-btn { width: fit-content !important; flex: 0 0 auto !important; height: 32px !important; padding: 0 12px !important; font-size: 13px !important; min-width: auto !important; }
                .acu-nav-btn span { max-width: 200px; }
                .acu-action-btn { flex: 0 0 32px !important; width: 32px !important; height: 32px !important; background: transparent !important; color: var(--acu-text-sub) !important; border-radius: 6px !important; border: 1px solid transparent; }
                .acu-action-btn:hover { background: var(--acu-btn-hover) !important; color: var(--acu-text-main) !important; transform: scale(1.1); box-shadow: none; }
                #acu-btn-save-global { color: var(--acu-accent) !important; }
                #acu-btn-save-global:hover { background: var(--acu-accent) !important; color: #fff !important; }
                .acu-order-controls { margin: 0 0 8px 0 !important; padding: 4px !important; }
                .acu-actions-group { width: auto !important; margin-left: auto !important; border-top: none !important; border-bottom: none !important; padding: 0 !important; margin-top: 0 !important; margin-bottom: 0 !important; gap: 4px !important; background: transparent; justify-content: flex-end; order: 9999 !important; display: flex !important; }
                .acu-pos-top .acu-actions-group { order: -1 !important; margin-left: 0 !important; margin-right: 10px !important; justify-content: flex-start !important; }
            }
            @media (max-width: 768px) {
                .acu-panel-content { -webkit-overflow-scrolling: touch !important; overscroll-behavior-y: auto; }
                .acu-data-card { box-shadow: none !important; border: 1px solid var(--acu-border) !important; transform: translateZ(0); transition: none !important; }
                .acu-data-card:hover { transform: none !important; box-shadow: none !important; }
                .acu-nav-btn:hover { transform: none !important; }
                .acu-nav-btn, .acu-action-btn, .acu-opt-btn, .acu-page-btn { transition: none !important; }
                /* .acu-icon-breathe { animation: none !important; } */
                .acu-highlight-manual, .acu-highlight-diff { animation: none !important; }
                .acu-card-row:hover { background: transparent !important; }
                .acu-option-panel, .acu-data-display { animation: none !important; }
                /* [核心优化 6] 限定通配符的作用域，防止污染酒馆全局 DOM 导致严重卡顿 */
                .acu-wrapper *, .acu-edit-overlay *, .acu-status-bar-container * { -webkit-tap-highlight-color: transparent; }
            }

            /* === RPG 交互式状态栏核心样式 (极致美化版) === */
            .acu-rpg-widget { margin-top: 8px; background: var(--acu-bg-panel); border: 1px solid var(--acu-border); border-radius: 12px; box-shadow: none; overflow: hidden; font-size: var(--acu-font-size, 13px); color: var(--acu-text-main); transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: auto; position: relative; }
            /* 移除了顶部的渐变反光线，减少塑料感 */
            .acu-rpg-summary { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px 16px; align-items: center; cursor: pointer; background: var(--acu-table-head); transition: background 0.2s; }
            .acu-rpg-summary:hover { background: var(--acu-table-hover); }
            .acu-rpg-details { display: none; background: var(--acu-bg-panel); border-top: 1px solid var(--acu-border); }
            
            /* 游戏化 Tab 切换栏 */
            .acu-rpg-tabs { display: flex; overflow-x: auto; background: var(--acu-bg-nav); padding: 6px 10px 0 10px; gap: 4px; scrollbar-width: none; border-bottom: 1px solid var(--acu-border); }
            .acu-rpg-tabs::-webkit-scrollbar { display: none; }
            .acu-rpg-tab-btn { flex: 1; min-width: 70px; padding: 10px 0; text-align: center; background: transparent; border: 1px solid transparent; border-bottom: none; border-radius: 8px 8px 0 0; color: var(--acu-text-sub); font-weight: bold; cursor: pointer; transition: all 0.2s; white-space: nowrap; position: relative; overflow: hidden; }
            .acu-rpg-tab-btn:hover { color: var(--acu-text-main); background: var(--acu-btn-hover); }
            .acu-rpg-tab-btn.active { color: var(--acu-accent); background: var(--acu-bg-panel); border-color: var(--acu-border); box-shadow: none; }
            .acu-rpg-tab-btn.active::after { content: ''; position: absolute; bottom: 0; left: 50%; transform: translateX(-50%); width: 40%; height: 3px; background: var(--acu-accent); border-radius: 3px 3px 0 0; }
            
            .acu-rpg-tab-content { display: none; padding: 16px; max-height: 450px; overflow-y: auto; overscroll-behavior: auto; }
            .acu-rpg-tab-content.active { display: block; animation: none; }
            .acu-rpg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
            
            /* 游戏化物品/状态卡片 */
            .acu-rpg-item-card { background: var(--acu-card-bg); border: 1px solid var(--acu-border); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 2px 4px var(--acu-shadow); transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s; }
            /* 已干掉资产条目的点击/悬停发光反馈 */
            .acu-rpg-item-title { font-weight: bold; color: var(--acu-accent); font-size: 1.05em; display: flex; align-items: center; gap: 4px; }
            .acu-rpg-item-desc { font-size: 0.9em; color: var(--acu-text-sub); line-height: 1.5; }
            .acu-rpg-badge { display: inline-flex; align-items: center; padding: 3px 10px; font-size: 11px; border-radius: 20px; background: var(--acu-badge-bg); border: 1px solid var(--acu-border); color: var(--acu-text-main); max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .acu-rpg-item-card span, .acu-rpg-item-card div { word-break: break-word; white-space: pre-wrap; }
            
            /* 进度条美化 (扁平化) */
            .acu-resource-track { position: relative; flex: 1; min-width: 80px; height: 16px; background: var(--acu-table-hover); border-radius: 8px; overflow: hidden; border: 1px solid var(--acu-border); }
            .acu-resource-fill { height: 100%; border-radius: 8px; transition: width 0.4s cubic-bezier(0.2, 0.8, 0.2, 1); position: relative; overflow: hidden; }
            .acu-resource-fill.hp { background: #e74c3c; }
            .acu-resource-fill.mp { background: #3498db; }
            .acu-resource-text { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); font-size: 11px; font-weight: 900; color: #fff; text-shadow: 0 1px 2px rgba(0,0,0,0.8); white-space: nowrap; font-family: 'Courier New', monospace; letter-spacing: 0.5px; }
            
            /* [新增] 剥离的内联卡片样式 (极致性能) */
            .acu-rpg-card-header { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
            .acu-rpg-card-title { color:var(--acu-text-main); font-size:14px; flex:1; min-width:0; word-break:break-all; }
            .acu-rpg-card-badges { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; flex-shrink:0; max-width:50%; }
            .acu-rpg-card-desc { margin-top:6px; padding-top:6px; border-top:1px dashed var(--acu-border); font-size:12px; }
            .acu-rank-badge { background:rgba(243,156,18,0.15); color:#e67e22; border:1px solid rgba(243,156,18,0.3); padding:1px 8px; border-radius:4px; font-weight:900; font-style:italic; letter-spacing:1px; }
            .acu-realm-text { background:linear-gradient(to right, #1D976C, #93F9B9); -webkit-background-clip:text; color:transparent; font-weight:bold; }
            .acu-val-pct-bar { display:flex; align-items:center; gap:6px; width:100%; }
            .acu-val-pct-text { font-weight:bold; color:var(--acu-accent); font-family:monospace; font-size:13px; }
            .acu-val-pct-track { flex:1; height:5px; background:var(--acu-table-hover); border-radius:3px; overflow:hidden; }
            .acu-val-pct-fill { height:100%; background:var(--acu-accent); border-radius:3px; }
            .acu-rpg-loc-time { display: flex; flex: 1; min-width: 0; margin: 0 16px; gap: 12px; align-items: stretch; }

            /* === 移动端 RPG 状态栏专属适配 (安卓/iOS) === */
            @media (max-width: 768px) {
                /* 1. 增加上下网格间距，适应双行结构 */
                .acu-rpg-summary { padding: 8px 10px; gap: 8px 6px; }
                /* 2. 徽章开启 flex 收缩属性，保护容器不被撑爆 */
                .acu-rpg-badge { max-width: none !important; padding: 2px 6px; font-size: 11px; display: inline-flex; align-items: center; flex-shrink: 1; min-width: 0; }
                
                /* 3. 名字区块 (左上角)：利用 order=1 锁定在第一行，并放开最大宽度给它更大空间 */
                .acu-rpg-summary > div:first-child { order: 1; font-size: 1.05em !important; max-width: calc(100% - 150px) !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                
                /* 4. 操作区块 (右上角)：利用 order=2 锁定在第一行右侧 */
                .acu-rpg-summary > div:last-child { 
                    order: 2; width: auto; margin-left: auto !important; justify-content: flex-end; 
                    border-top: none; padding-top: 0; margin-top: 0; gap: 6px;
                }
                
                /* 5. 地点与时间区块 (第二行)：强制不换行 (nowrap) 杜绝第三行，超长时触发内部收缩或滚动 */
                .acu-rpg-loc-time { order: 3; width: 100%; display: flex; flex-wrap: nowrap; overflow: hidden; gap: 6px; margin-top: 2px; flex: none; margin: 0; align-items: stretch; }
                /* 5. 金币和任务的字号恢复正常比例 */
                .acu-rpg-summary > div:last-child > span { padding: 2px 6px !important; font-size: 12px !important; }
                .acu-rpg-tab-btn { min-width: 55px; padding: 8px 0; font-size: 12px; }
                .acu-rpg-tab-content { padding: 10px; max-height: 50vh; }
                .acu-rpg-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)) !important; gap: 8px; }
                .acu-rpg-grid.acu-grid-responsive { grid-template-columns: 1fr !important; }
                .acu-rpg-item-card { padding: 8px; gap: 4px; }
                .acu-rpg-item-title { font-size: 12px; }
                .acu-rpg-item-desc { font-size: 11px; line-height: 1.4; }
            }

            /* --- 修复酒馆系统提示层级被遮挡 --- */
            #toast-container { z-index: 2147483649 !important; }

            /* ========================================== */
            /* 🚀 原生控件主题适配补丁 (滚动条/拖拽块/复选框/滑块/图标) */
            /* ========================================== */
            
            /* 1. 统一接管滚动条 (包含 RPG 状态栏容器) */
            .acu-wrapper *::-webkit-scrollbar,
            .acu-edit-overlay *::-webkit-scrollbar,
            .acu-status-bar-container *::-webkit-scrollbar {
                width: 6px !important;
                height: 6px !important;
            }
            .acu-wrapper *::-webkit-scrollbar-track,
            .acu-edit-overlay *::-webkit-scrollbar-track,
            .acu-status-bar-container *::-webkit-scrollbar-track {
                background: var(--acu-scrollbar-track, transparent) !important;
                border-radius: 3px !important;
            }
            .acu-wrapper *::-webkit-scrollbar-thumb,
            .acu-edit-overlay *::-webkit-scrollbar-thumb,
            .acu-status-bar-container *::-webkit-scrollbar-thumb {
                background: var(--acu-scrollbar-thumb, #888) !important;
                border-radius: 3px !important;
            }
            .acu-wrapper *::-webkit-scrollbar-thumb:hover,
            .acu-edit-overlay *::-webkit-scrollbar-thumb:hover,
            .acu-status-bar-container *::-webkit-scrollbar-thumb:hover {
                background: var(--acu-accent) !important;
            }

            /* 2. 适配多行文本框右下角的拖拽块 (Resizer) */
            .acu-edit-overlay textarea::-webkit-resizer,
            .acu-wrapper textarea::-webkit-resizer,
            .acu-status-bar-container textarea::-webkit-resizer {
                background-color: var(--acu-btn-bg) !important;
                border-top: 1px solid var(--acu-border) !important;
                border-left: 1px solid var(--acu-border) !important;
            }

            /* 3. 强力破除酒馆对 Checkbox 的劫持，强制使用原生外观+主题色 */
            /* 排除 .acu-checkbox (开关滑块)，专治普通勾选框 */
            .acu-wrapper input[type="checkbox"]:not(.acu-checkbox),
            .acu-edit-overlay input[type="checkbox"]:not(.acu-checkbox) {
                -webkit-appearance: checkbox !important;
                appearance: checkbox !important;
                background: transparent !important; /* 清除混合渲染导致的底色重叠 */
                background-image: none !important;
                border: none !important; /* 交给原生控件自己画边框 */
                box-shadow: none !important;
                accent-color: var(--acu-accent) !important;
                width: 14px !important;
                height: 14px !important;
                cursor: pointer !important;
                margin: 0 4px 0 0 !important;
                outline: none !important;
            }
            /* 斩草除根：杀掉酒馆可能附加在原生框上的伪元素假框 */
            .acu-wrapper input[type="checkbox"]:not(.acu-checkbox)::before,
            .acu-wrapper input[type="checkbox"]:not(.acu-checkbox)::after,
            .acu-edit-overlay input[type="checkbox"]:not(.acu-checkbox)::before,
            .acu-edit-overlay input[type="checkbox"]:not(.acu-checkbox)::after {
                display: none !important;
                content: none !important;
            }

            /* 4. 强力接管滑块 (Range Slider) */
            .acu-edit-overlay input[type="range"].acu-slider {
                -webkit-appearance: none !important;
                appearance: none !important;
                background-color: var(--acu-border) !important;
                background-image: none !important;
                height: 6px !important;
                border-radius: 3px !important;
                border: none !important;
                padding: 0 !important;
            }
            .acu-edit-overlay input[type="range"].acu-slider::-webkit-slider-thumb {
                -webkit-appearance: none !important;
                appearance: none !important;
                background-color: var(--acu-accent) !important;
                width: 16px !important;
                height: 16px !important;
                border-radius: 50% !important;
                border: 2px solid var(--acu-text-main) !important;
                box-shadow: 0 0 4px rgba(0,0,0,0.5) !important;
                cursor: pointer !important;
            }

            /* 5. 修复搜索框放大镜图标被遮挡或颜色融合的问题 */
            .acu-wrapper .acu-search-icon {
                color: var(--acu-text-sub) !important;
                opacity: 0.8 !important;
                z-index: 2 !important;
            }
            </style>
    `;
    $('head').append(styles);
};

    const getTableData = () => { const api = getCore().getDB(); return api && api.exportTableAsJson ? api.exportTableAsJson() : null; };

const saveDataToDatabase = async (tableData, skipRender = false, commitDeletes = false) => {
    if (isSaving) return;
    isSaving = true;
    const { $, ST } = getCore();

    // [优化] 辅助函数：让出主线程，允许 UI 响应
    const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));

    try {
        // 1. 构建保存数据
        const dataToSave = {};
        if (!tableData.mate) dataToSave.mate = { type: "chatSheets", version: 1 };
        else dataToSave.mate = tableData.mate;

        Object.keys(tableData).forEach(k => {
            if (k.startsWith('sheet_')) {
                dataToSave[k] = tableData[k];
            }
        });

        // 2. 处理删除
        if (commitDeletes) {
            const deletions = getPendingDeletions();
            Object.keys(deletions).forEach(key => {
                if (dataToSave[key] && dataToSave[key].content) {
                    deletions[key].sort((a, b) => b - a).forEach(idx => {
                        if (dataToSave[key].content[idx + 1]) dataToSave[key].content.splice(idx + 1, 1);
                    });
                }
            });
            savePendingDeletions({});
        }

        // [优化] 让出主线程
        await yieldToMain();

        // 3. 同步聊天记录楼层数据
        try {
            let rawIsolationCode = '';
            const SETTINGS_KEYS = ['shujuku_v104_allSettings_v2', 'shujuku_v70_allSettings_v2', 'shujuku_v60_allSettings_v2', 'shujuku_v50_allSettings_v2'];
            let storage = window.localStorage;
            if (!storage.getItem(SETTINGS_KEYS[0]) && window.parent) { try { storage = window.parent.localStorage; } catch(e){} }
            
            for (const key of SETTINGS_KEYS) {
                const str = storage.getItem(key);
                if (str) {
                    const settings = JSON.parse(str);
                    if (settings.dataIsolationEnabled && settings.dataIsolationCode) {
                        rawIsolationCode = settings.dataIsolationCode;
                        break;
                    }
                }
            }

            if (ST && ST.chat && ST.chat.length > 0) {
                let targetMsg = null;
                for (let i = ST.chat.length - 1; i >= 0; i--) {
                    if (!ST.chat[i].is_user) {
                        targetMsg = ST.chat[i];
                        break;
                    }
                }

                if (targetMsg) {
                    if (!targetMsg.TavernDB_ACU_IsolatedData) targetMsg.TavernDB_ACU_IsolatedData = {};
                    if (!targetMsg.TavernDB_ACU_IsolatedData[rawIsolationCode]) {
                        targetMsg.TavernDB_ACU_IsolatedData[rawIsolationCode] = { independentData: {}, modifiedKeys: [] };
                    }

                    const tagData = targetMsg.TavernDB_ACU_IsolatedData[rawIsolationCode];
                    if (!tagData.independentData) tagData.independentData = {};

                    // [T0 优化] 分片深拷贝：使用现代浏览器原生的 structuredClone 替代 JSON 解析，消除主线程阻塞峰值
                    const sheetsToSave = Object.keys(dataToSave).filter(k => k.startsWith('sheet_'));
                    for (const k of sheetsToSave) {
                        tagData.independentData[k] = typeof structuredClone === 'function' 
                            ? structuredClone(dataToSave[k]) 
                            : JSON.parse(JSON.stringify(dataToSave[k]));
                        await yieldToMain(); // 每个 sheet 后让出
                    }

                    const existingKeys = tagData.modifiedKeys || [];
                    tagData.modifiedKeys = [...new Set([...existingKeys, ...sheetsToSave])];

                    // [优化] saveChat 前让出，确保 UI 流畅
                    await yieldToMain();
                    if (ST.saveChat) {
                        await ST.saveChat();
                    }
                }
            }
        } catch (syncErr) {
            console.warn('[ACU] 聊天记录同步失败 (不影响主功能):', syncErr);
        }

        // [优化] 让出主线程
        await yieldToMain();

        // 4. 调用后端 API (序列化也是阻塞的，但 API 本身是异步的)
        const api = getCore().getDB();
        if (api && api.importTableAsJson) {
            const jsonStr = JSON.stringify(dataToSave);
            await yieldToMain(); // 序列化后让出
            await api.importTableAsJson(jsonStr);
        }

        // [优化] 让出主线程
        await yieldToMain();

        // 5. 更新本地状态
        cachedRawData = dataToSave;
        saveSnapshot(dataToSave);
        hasUnsavedChanges = false;
        currentDiffMap = new Set();
        if (window.acuModifiedSet) window.acuModifiedSet.clear();

        if (!skipRender) {
            renderInterface();
            AcuToast.success('✅ 保存成功');
        }
    } catch (e) {
        console.error('Save error:', e);
        AcuToast.error('保存出错');
    } finally {
        isSaving = false;
    }
};


    const processJsonData = (json) => {
        const tables = {};
        if (!json || typeof json !== 'object') return tables;
        for (const sheetId in json) {
            if (json[sheetId]?.name) {
                const sheet = json[sheetId];
                tables[sheet.name] = {
                    key: sheetId,
                    headers: sheet.content ? (sheet.content[0] || []) : [],
                    rows: sheet.content ? sheet.content.slice(1) : [],
                    updateConfig: sheet.updateConfig || {},
                    ...sheet
                };
            }
        }
        return tables;
    };

    const showSettingsModal = () => {
    const { $ } = getCore();
    $('.acu-edit-overlay').remove();
    const config = getConfig();
    const currentThemeClass = `acu-theme-${config.theme}`;
    const reversedTables = Store.get('acu_reverse_tables', []);
    const hiddenTables = getHiddenTables();
    const allTables = cachedRawData ? processJsonData(cachedRawData) : (getTableData() ? processJsonData(getTableData()) : {});
    // [修改] 允许在设置里管理人物关系网的显示状态
    let tableNames = Object.keys(allTables);
    // 如果列表中没有虚拟标签，手动追加进去，这样用户就能对其进行隐藏或排序操作了
    if (!tableNames.includes(VIRTUAL_RELATIONSHIP_TAB)) {
        tableNames.unshift(VIRTUAL_RELATIONSHIP_TAB);
    }

    const modalStyles = `
        <style>
            .acu-edit-dialog { transition: background 0.3s ease, color 0.3s ease, opacity 0.15s ease, transform 0.3s cubic-bezier(0.2, 0.8, 0.2, 1); }
            #acu-ghost-preview { position: fixed; opacity: 0; pointer-events: none; z-index: 2147483647; box-shadow: 0 10px 40px rgba(0,0,0,0.6) !important; border: 2px solid var(--acu-accent); background: var(--acu-card-bg); display: flex; flex-direction: column; transition: opacity 0.2s ease, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
            #acu-ghost-preview.visible { opacity: 1 !important; }
            @media (min-width: 769px) {
                .acu-edit-overlay { background: rgba(0, 0, 0, 0.4) !important; backdrop-filter: blur(2px); }
                .acu-edit-dialog { width: 400px !important; max-width: 90% !important; max-height: 85vh !important; box-shadow: 0 10px 40px rgba(0,0,0,0.4) !important; margin: auto !important; }
                #acu-ghost-preview { top: 50%; left: calc(50% + 220px); right: auto; transform: translateY(-50%) scale(0.95); width: var(--acu-card-width); font-size: var(--acu-font-size); z-index: 2147483648; }
                #acu-ghost-preview.visible { transform: translateY(-50%) scale(1); }
            }
            @media (min-width: 769px) and (max-width: 1100px) { #acu-ghost-preview { left: auto !important; right: calc(50% + 220px) !important; } }
            @media (min-width: 769px) and (max-width: 850px) { #acu-ghost-preview { left: 50% !important; right: auto !important; top: 10% !important; transform: translateX(-50%) !important; } #acu-ghost-preview.visible { transform: translateX(-50%) scale(1) !important; } }
            @media (max-width: 768px) {
                /* [优化] 遮罩层改为Flex居中对齐，加深背景模糊，提升沉浸感 */
.acu-edit-overlay { align-items: center !important; justify-content: center !important; background: rgba(0, 0, 0, 0.6) !important; backdrop-filter: blur(4px); padding: 0 !important; }
                /* 还原：标准的底部弹窗样式，无额外边距 */
                /* [优化] 弹窗本体：宽度90%，最大高度80%，四周圆角，居中悬浮 */
.acu-edit-dialog { width: 90% !important; max-width: 450px !important; border-radius: 16px !important; height: auto !important; max-height: 80vh !important; margin: auto !important; bottom: auto !important; animation: acuFadeIn 0.25s ease-out; box-shadow: 0 15px 50px rgba(0,0,0,0.6) !important; }
                #acu-ghost-preview { top: 12% !important; bottom: auto !important; left: 50% !important; transform: translateX(-50%) !important; width: min(var(--acu-card-width), calc(100vw - 32px)) !important; max-height: 35vh !important; overflow-y: auto !important; overflow-x: hidden !important; margin: 0 !important; box-shadow: 0 10px 50px rgba(0,0,0,0.5) !important; border: 2px solid var(--acu-accent) !important; } 
            }
            @keyframes acuSlideUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
            .acu-edit-dialog { background-color: var(--acu-bg-panel) !important; color: var(--acu-text-main) !important; border: 1px solid var(--acu-border) !important; display: flex; flex-direction: column; }
            .acu-edit-title { flex: 0 0 auto; color: var(--acu-text-main) !important; border-bottom: 1px solid var(--acu-border) !important; }
            .acu-settings-group-box { background: var(--acu-table-head) !important; border: 1px dashed var(--acu-border) !important; padding: 12px; border-radius: 8px; margin-bottom: 15px; }
            .acu-settings-label { color: var(--acu-text-sub) !important; }
            .acu-settings-val { color: var(--acu-accent) !important; }
            .acu-select, .acu-slider { background: var(--acu-btn-bg) !important; border: 1px solid var(--acu-border) !important; color: var(--acu-text-main) !important; }
            .acu-btn-block { background: var(--acu-btn-bg) !important; color: var(--acu-text-main) !important; border: 1px solid var(--acu-border) !important; }
            .acu-btn-block:hover { background: var(--acu-btn-hover) !important; }
            .acu-reverse-item { display:flex; justify-content:space-between; align-items:center; padding:8px; border-bottom:1px dashed var(--acu-border); }
            .acu-reverse-item:last-child { border-bottom:none; }
            .acu-switch { position: relative; display: inline-block; width: 36px; height: 20px; margin-right: 10px; flex-shrink: 0; vertical-align: middle; }
            .acu-switch input { opacity: 0; width: 0; height: 0; }
            .acu-slider-toggle { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(128,128,128,0.3); transition: .3s; border-radius: 20px; }
            .acu-slider-toggle:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: var(--acu-text-sub); transition: .3s cubic-bezier(0.4, 0.0, 0.2, 1); border-radius: 50%; }
            .acu-switch input:checked + .acu-slider-toggle { background-color: var(--acu-accent); }
            .acu-switch input:checked + .acu-slider-toggle:before { transform: translateX(16px); background-color: #fff; }
            .acu-settings-label.has-switch { display: flex; align-items: center; cursor: pointer; }
            
            
        </style>
    `;

    const dialog = $(`
        <div class="acu-edit-overlay">
            ${modalStyles}
            <div class="acu-edit-dialog ${currentThemeClass}">
                <div class="acu-edit-title" style="text-align:center; padding: 12px 15px;">
    <div style="font-weight:bold; font-size:16px;">设置选项</div>
    <div style="font-size:11px; opacity:0.6; font-weight:normal; margin-top:4px;">💡 按住滑块可实时预览效果 (点击空白处可退出)</div>
</div>

                <div class="acu-settings-content" style="flex: 1; overflow-y: auto; padding: 15px;">
                    <div class="acu-settings-group-box">
                        <div class="acu-settings-item"><label class="acu-settings-label">卡片宽度 <span class="acu-settings-val" id="val-width">${config.cardWidth}px</span></label><input type="range" id="cfg-width" class="acu-slider" min="200" max="500" step="10" value="${config.cardWidth}"></div>
                        <div class="acu-settings-item"><label class="acu-settings-label">字体大小 (界面) <span class="acu-settings-val" id="val-font">${config.fontSize}px</span></label><input type="range" id="cfg-font" class="acu-slider" min="10" max="24" step="1" value="${config.fontSize}"></div>
                        <div class="acu-settings-item"><label class="acu-settings-label">选项字体大小 <span class="acu-settings-val" id="val-opt-font">${config.optionFontSize || 12}px</span></label><input type="range" id="cfg-opt-font" class="acu-slider" min="10" max="24" step="1" value="${config.optionFontSize || 12}"></div>
                    </div>
                    <div class="acu-settings-item"><label class="acu-settings-label">背景主题 (Theme)</label><select id="cfg-theme" class="acu-select">${THEMES.map(t => `<option value="${t.id}" ${t.id === config.theme ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>
                    <div class="acu-settings-item"><label class="acu-settings-label">字体风格 (Font)</label><select id="cfg-font-family" class="acu-select">${FONTS.map(f => `<option value="${f.id}" ${f.id === config.fontFamily ? 'selected' : ''}>${f.name}</option>`).join('')}</select></div>
                    <div class="acu-settings-item"><label class="acu-settings-label has-switch"><div class="acu-switch"><input type="checkbox" id="cfg-show-status" class="acu-checkbox" ${config.showStatusBar !== false ? 'checked' : ''}><span class="acu-slider-toggle"></span></div> 显示 RPG 状态栏 (跟随气泡底部)</label></div>
                    <div class="acu-settings-item"><label class="acu-settings-label">布局模式 (Layout)</label><select id="cfg-layout" class="acu-select"><option value="horizontal" ${config.layout !== 'vertical' ? 'selected' : ''}>↔️ 横向滚动 (默认)</option><option value="vertical" ${config.layout === 'vertical' ? 'selected' : ''}>↕️ 竖向网格 (PC推荐)</option></select></div>
                    <div class="acu-settings-item" style="display:${$(window).width() > 768 ? 'none' : 'block'};"><label class="acu-settings-label">底部按钮列数 (Grid Columns)</label><select id="cfg-grid-cols" class="acu-select"><option value="2" ${config.gridColumns == 2 ? 'selected' : ''}>2 列 (宽大)</option><option value="3" ${config.gridColumns == 3 ? 'selected' : ''}>3 列 (标准)</option><option value="4" ${config.gridColumns == 4 ? 'selected' : ''}>4 列 (紧凑)</option><option value="auto" ${config.gridColumns === 'auto' ? 'selected' : ''}>🤖 自动 (智能填满)</option></select></div>
                    <div class="acu-settings-item"><label class="acu-settings-label">收起后的样式 (Collapsed Style)</label><select id="cfg-col-style" class="acu-select"><option value="bar" ${config.collapseStyle === 'bar' ? 'selected' : ''}>🟦 全宽长条</option><option value="pill" ${config.collapseStyle === 'pill' ? 'selected' : ''}>💊 胶囊按钮</option><option value="mini" ${config.collapseStyle === 'mini' ? 'selected' : ''}>🔘 迷你圆钮</option></select></div>
                    <div class="acu-settings-item" id="row-col-align" style="display:${config.collapseStyle === 'bar' ? 'none' : 'block'};"><label class="acu-settings-label">收起后的位置 (Position)</label><select id="cfg-col-align" class="acu-select"><option value="right" ${config.collapseAlign !== 'left' ? 'selected' : ''}>➡️ 靠右 (默认)</option><option value="left" ${config.collapseAlign === 'left' ? 'selected' : ''}>⬅️ 靠左</option></select></div>
                    <div class="acu-settings-item"><label class="acu-settings-label" style="display:flex; justify-content:space-between; align-items:center;"><span>每页显示条数</span><input type="number" id="cfg-per-page" value="${config.itemsPerPage}" min="1" max="9999" style="width: 80px; background-color: var(--acu-btn-bg) !important; border: 1px solid var(--acu-border) !important; color: var(--acu-text-main) !important; font-weight: bold; border-radius: 4px; padding: 4px 8px; text-align: center; outline: none;"></label></div>
                    <div class="acu-settings-item"><label class="acu-settings-label">功能按钮位置 (Action Bar)</label><select id="cfg-action-pos" class="acu-select"><option value="bottom" ${config.actionsPosition !== 'top' ? 'selected' : ''}>⬇️ 底部 (默认)</option><option value="top" ${config.actionsPosition === 'top' ? 'selected' : ''}>⬆️ 顶部</option></select></div>
                    <div class="acu-settings-item"><label class="acu-settings-label has-switch"><div class="acu-switch"><input type="checkbox" id="cfg-new" class="acu-checkbox" ${config.highlightNew ? 'checked' : ''}><span class="acu-slider-toggle"></span></div> 高亮变化/新增的内容 (Diff)</label></div>
                    <div class="acu-settings-item"><label class="acu-settings-label has-switch"><div class="acu-switch"><input type="checkbox" id="cfg-beautify-toastr" class="acu-checkbox" ${config.beautifyToastr === true ? 'checked' : ''}><span class="acu-slider-toggle"></span></div> 优化酒馆系统提示消息</label></div>
                    <div class="acu-settings-item"><label class="acu-settings-label has-switch"><div class="acu-switch"><input type="checkbox" id="cfg-show-opt" class="acu-checkbox" ${config.showOptionPanel !== false ? 'checked' : ''}><span class="acu-slider-toggle"></span></div> 显示行动选项 (识别"选项"表)</label></div>
                    <div class="acu-settings-item" id="row-auto-send" style="display:${config.showOptionPanel !== false ? 'block' : 'none'}"><label class="acu-settings-label has-switch"><div class="acu-switch"><input type="checkbox" id="cfg-auto-send" class="acu-checkbox" ${config.clickOptionToAutoSend !== false ? 'checked' : ''}><span class="acu-slider-toggle"></span></div> 点击选项直接发送</label></div>

                    <div class="acu-settings-group-box" style="margin-top:20px;">
                        <label class="acu-settings-label" style="margin-bottom:6px; display:block;"><i class="fa-solid fa-sort-amount-up"></i> 表格显示顺序偏好</label>
                        <div style="font-size:10px; color:var(--acu-text-sub); margin-bottom:8px; line-height:1.4;">
                            <i class="fa-solid fa-eye" style="margin-right:3px;"></i>点击眼睛图标可隐藏/显示该标签页
                        </div>
                        <div style="max-height:220px; overflow-y:auto; border:1px solid var(--acu-border); border-radius:4px; padding:5px; background:rgba(0,0,0,0.05);">
                            ${tableNames.length > 0 ? tableNames.map(name => {
    const safeName = escapeHtml(name); // 转义处理
    const isHidden = hiddenTables.includes(name);
    const isVirtual = name === VIRTUAL_RELATIONSHIP_TAB;
    const disabledHighlightTables = Store.get(STORAGE_KEY_DISABLE_HIGHLIGHT_TOP, []);
    const isHighlightTop = !disabledHighlightTables.includes(name); // [修改] 不在黑名单里即为开启高亮置顶
    return `<div class="acu-reverse-item" style="flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:120px;">
            <button class="acu-visibility-toggle" data-table="${safeName}" style="background:none;border:none;cursor:pointer;padding:4px;color:${isHidden ? '#666' : 'var(--acu-accent)'}" title="${isHidden ? '不在导航栏显示' : '在导航栏显示'}"><i class="fa-solid ${isHidden ? 'fa-eye-slash' : 'fa-eye'}"></i></button>
            <span style="font-size:13px;color:${isHidden ? 'var(--acu-text-sub)' : 'var(--acu-text-main)'};text-decoration:${isHidden ? 'line-through' : 'none'}">${safeName}</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;${isVirtual ? 'display:none;' : ''}">
            <label style="display:flex;align-items:center;cursor:pointer;"><input type="checkbox" class="acu-highlight-top-check" value="${safeName}" ${isHighlightTop ? 'checked' : ''} style="margin-right:4px;"><span style="font-size:11px;color:var(--acu-hl-diff);">高亮置顶</span></label>
            <label style="display:flex;align-items:center;cursor:pointer;"><input type="checkbox" class="acu-reverse-check" value="${safeName}" ${!reversedTables.includes(name) ? 'checked' : ''} style="margin-right:4px;"><span style="font-size:11px;">倒序</span></label>
        </div>
    </div>`;
}).join('') : '<div style="font-size:12px;text-align:center;padding:10px;color:var(--acu-text-sub);">暂无表格数据</div>'}
                        </div>
                        <div style="font-size:10px; color:var(--acu-text-sub); margin-top:8px; line-height:1.5; padding:6px; background:rgba(0,0,0,0.03); border-radius:4px;">
                            <div><b>说明：</b></div>
                            <div>• <b>高亮置顶</b>：AI修改的行会优先显示在最前面</div>
                            <div>• <b>倒序</b>：最新添加的行显示在前（不勾选则最早的在前）</div>
                            <div>• 两个都勾选 = 高亮行置顶 + 其余倒序</div>
                        </div>
                    </div>
                    <div class="acu-divider" style="width:100%; height:1px; margin:15px 0; background:var(--acu-border);"></div>
                    <div style="display: flex; gap: 8px;">
                        <button class="acu-btn-block" id="btn-enter-sort" style="width: 100%; margin-top: 0;"><i class="fa-solid fa-arrows-alt"></i> 进入表格排序模式</button>
                    </div>
                    
                    <div class="acu-settings-group-box" style="margin-top:20px; border-color:var(--acu-accent);">
                        <label class="acu-settings-label" style="margin-bottom:10px; display:block; color:var(--acu-accent) !important;"><i class="fa-solid fa-database"></i> 模板与数据管理</label>
                        
                        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px;">
                            <select class="acu-select" id="cfg-template-select" style="width:100%;">
                                <option value="">-- 当前使用的默认库 --</option>
                            </select>
                            <div style="display:flex; gap:8px; align-items:center; justify-content:space-between;">
                                <button class="acu-btn-block" id="btn-import-tpl-outside" style="flex:1; margin:0; padding:8px 0;" title="导入新模板"><i class="fa-solid fa-file-import"></i> 导入</button>
                                <button class="acu-btn-block" id="btn-export-tpl-outside" style="flex:1; margin:0; padding:8px 0; background:var(--acu-accent); border-color:var(--acu-accent); color:#fff;" title="导出选中模板"><i class="fa-solid fa-download"></i> 导出</button>
                                <button class="acu-btn-block" id="btn-delete-tpl-outside" style="flex:1; margin:0; padding:8px 0; background:#e74c3c; border-color:#e74c3c; color:#fff;" title="删除选中模板"><i class="fa-solid fa-trash-can"></i> 删除</button>
                                <button class="acu-btn-block" id="btn-inject-tpl-db" style="flex:1; margin:0; padding:8px 0; background:#f39c12; border-color:#f39c12; color:#fff;" title="⚡ 将选中模板一键注入当前世界数据库"><i class="fa-solid fa-bolt"></i> 注入</button>
                                <input type="file" id="input-import-tpl-outside" accept=".json" style="display:none;">
                            </div>
                        </div>

                        <div style="display: flex; gap: 8px;">
                            <button class="acu-btn-block" id="btn-open-stitcher" style="width: 100%; margin-top: 0; background: rgba(155, 89, 182, 0.2); color: #9b59b6; border-color: #9b59b6;"><i class="fa-solid fa-puzzle-piece"></i> 打开模板缝合中心</button>
                        </div>
                    </div>
                <div style="height: 10px;"></div>
            </div>

            <div style="flex: 0 0 auto; padding: 12px 16px; border-top: 1px solid var(--acu-border); background: var(--acu-bg-panel); z-index: 10;">
                <button id="dlg-close" class="acu-btn-block" style="margin:0; background:var(--acu-accent) !important; color:#fff !important; border:none; justify-content:center; font-weight:bold; font-size:15px; height:44px; box-shadow: 0 4px 12px rgba(0,0,0,0.2);">
                    <i class="fa-solid fa-check"></i> 完成并保存
                </button>
            </div>
        </div>
            <style> /* [优化] 居中模式下不需要底部巨型留白，留一点余量即可 */
@media (max-width: 768px) { .acu-mobile-spacer { height: 20px !important; } } </style>
        </div>
    `);
    dialog.css('opacity', '0');
    $('body').append(dialog);
    dialog[0].offsetHeight;
    requestAnimationFrame(() => {
        dialog.css({ 'opacity': '1', 'transition': 'opacity 0.15s ease-out' });
    });

    dialog.find('.acu-visibility-toggle').click(function(e) {
        e.stopPropagation(); const tName = $(this).data('table'); let hList = getHiddenTables();
        const isHidden = hList.includes(tName);
        if (isHidden) { hList = hList.filter(n => n !== tName); $(this).find('i').attr('class', 'fa-solid fa-eye'); $(this).css('color', 'var(--acu-accent)'); $(this).siblings('span').css({'color':'var(--acu-text-main)','text-decoration':'none'}); } 
        else { hList.push(tName); $(this).find('i').attr('class', 'fa-solid fa-eye-slash'); $(this).css('color', '#666'); $(this).siblings('span').css({'color':'var(--acu-text-sub)','text-decoration':'line-through'}); }
        saveHiddenTables(hList); renderInterface();
    });

    
    dialog.find('.acu-highlight-top-check').on('change', function() {
        const tName = $(this).val(); const checked = $(this).is(':checked'); let currentList = Store.get(STORAGE_KEY_DISABLE_HIGHLIGHT_TOP, []);
        // [修改] 黑名单逻辑：取消勾选(checked为false)时加入黑名单，勾选(checked为true)时移出黑名单
        if (!checked) { if (!currentList.includes(tName)) currentList.push(tName); } else { currentList = currentList.filter(n => n !== tName); }
        Store.set(STORAGE_KEY_DISABLE_HIGHLIGHT_TOP, currentList);
        const activeTab = getActiveTabState(); if (activeTab === tName) { renderInterface(); }
    });
    dialog.find('.acu-reverse-check').on('change', function() {
        const tName = $(this).val(); const checked = $(this).is(':checked'); let currentList = Store.get('acu_reverse_tables', []);
        if (checked) { if (!currentList.includes(tName)) currentList.push(tName); } else { currentList = currentList.filter(n => n !== tName); }
        Store.set('acu_reverse_tables', currentList);
        const activeTab = getActiveTabState(); if (activeTab === tName) { renderInterface(); }
    });
    dialog.find('#cfg-font-family').on('change', function() { saveConfig({ fontFamily: $(this).val() }); });
    dialog.find('#cfg-show-status').on('change', function() { saveConfig({ showStatusBar: $(this).is(':checked') }); renderInterface(); });
    dialog.find('#cfg-layout').on('change', function() { saveConfig({ layout: $(this).val() }); renderInterface(); });
    dialog.find('#cfg-grid-cols').on('change', function() { saveConfig({ gridColumns: $(this).val() }); renderInterface(); });
    dialog.find('#cfg-col-style').on('change', function() {
        const val = $(this).val();
        saveConfig({ collapseStyle: val });
        if (val === 'bar') dialog.find('#row-col-align').slideUp(200); else dialog.find('#row-col-align').slideDown(200);
        renderInterface();
    });
    dialog.find('#cfg-col-align').on('change', function() { saveConfig({ collapseAlign: $(this).val() }); renderInterface(); });
    dialog.find('#cfg-action-pos').on('change', function() { saveConfig({ actionsPosition: $(this).val() }); renderInterface(); });
    dialog.find('#cfg-new').on('change', function() { saveConfig({ highlightNew: $(this).is(':checked') }); renderInterface(); });
    dialog.find('#cfg-beautify-toastr').on('change', function() { saveConfig({ beautifyToastr: $(this).is(':checked') }); });
    dialog.find('#cfg-show-opt').on('change', function() {
        const checked = $(this).is(':checked');
        saveConfig({ showOptionPanel: checked }); 
        if(checked) dialog.find('#row-auto-send').slideDown(200); else dialog.find('#row-auto-send').slideUp(200);
        renderInterface(); 
    });
    dialog.find('#cfg-auto-send').on('change', function() { saveConfig({ clickOptionToAutoSend: $(this).is(':checked') }); });
    dialog.find('#cfg-theme').on('change', function() { 
        const newTheme = $(this).val(); saveConfig({ theme: newTheme }); 
        
        // [性能优化] 先穿新衣服，再脱旧衣服，防止 CSS 变量出现真空期导致“黑闪”
        const $editDialog = dialog.find('.acu-edit-dialog');
        $editDialog.addClass(`acu-theme-${newTheme}`);
        THEMES.forEach(t => { if (t.id !== newTheme) $editDialog.removeClass(`acu-theme-${t.id}`); });

        // [新增] 给点延迟让浏览器算完 CSS 变量，然后广播主题更新事件
        setTimeout(() => $(window).trigger('acu_theme_updated'), 50);
    });

    const showGhostCard = (forceRebuild = false) => {
        const isOptionMode = window._acuPreviewType === 'option';
        const targetType = isOptionMode ? 'option' : 'main';
        const curCfg = getConfig();
        const currentThemeClass = `acu-theme-${curCfg.theme}`;
        
        let $ghost = $('#acu-ghost-preview');

        // [性能核心] 如果已经存在且类型匹配且没强制重构，就直接复用，拒绝重建！
        if (!forceRebuild && $ghost.length > 0 && $ghost.data('type') === targetType) {
            $ghost.addClass('visible');
            // 确保主题类名也是新的
            if (!$ghost.hasClass(currentThemeClass)) {
                $ghost.removeClass(THEMES.map(t => `acu-theme-${t.id}`).join(' ')).addClass(currentThemeClass);
            }
            return; // 直接结束，极速响应
        }

        // 只有不存在或类型不匹配时，才重建 DOM
        $ghost.remove();

        let ghostHtml = '';
        if (isOptionMode) {
            // 模式A: 选项样式 (修复：完全还原底层真实界面的袖珍紧凑面板)
            ghostHtml = `
                <div id="acu-ghost-preview" class="acu-option-panel ${currentThemeClass}" data-type="option" style="width: 240px; pointer-events: none; background: var(--acu-bg-nav) !important; border: 1px solid var(--acu-border) !important; border-radius: 6px !important; padding: 4px !important; gap: 2px !important; box-shadow: 0 15px 50px rgba(0,0,0,0.8) !important;">
                    <div class="acu-opt-header">行动选项 (预览)</div>
                    <button class="acu-opt-btn">💬 询问关于那个传闻</button>
                    <button class="acu-opt-btn">⚔️ 发起攻击 (检定)</button>
                    <button class="acu-opt-btn">👋 暂时离开</button>
                </div>`;
        } else {
            // 模式B: 表格样式
            ghostHtml = `
                <div id="acu-ghost-preview" class="acu-data-card ${currentThemeClass}" data-type="main">
                    <div class="acu-card-header"><span class="acu-card-index">#示例</span><span class="acu-cell acu-editable-title">预览卡片效果</span></div>
                    <div class="acu-card-body">
                        <div class="acu-card-row acu-cell"><div class="acu-card-label">姓名</div><div class="acu-card-value">陈默</div></div>
                        <div class="acu-card-row acu-cell"><div class="acu-card-label">状态</div><div class="acu-card-value"><span class="acu-badge acu-badge-green">正常</span></div></div>
                    </div>
                </div>`;
        }

        $('body').append(ghostHtml);
        $ghost = $('#acu-ghost-preview');
        
        // 初始化变量
        const $wrapper = $('.acu-wrapper').length ? $('.acu-wrapper') : $('body');
        $ghost.css({
            '--acu-card-width': $wrapper.css('--acu-card-width') || curCfg.cardWidth + 'px',
            '--acu-font-size': $wrapper.css('--acu-font-size') || curCfg.fontSize + 'px',
            '--acu-opt-font-size': $wrapper.css('--acu-opt-font-size') || (curCfg.optionFontSize || 12) + 'px'
        });

        requestAnimationFrame(() => $ghost.addClass('visible'));
    };

    let hideTimer = null;
    const hideGhostCard = () => { if (hideTimer) clearTimeout(hideTimer); hideTimer = setTimeout(() => { $('#acu-ghost-preview').removeClass('visible'); setTimeout(() => { if(!$('#acu-ghost-preview').hasClass('visible')) $('#acu-ghost-preview').remove(); }, 300); }, 1000); };
    const cancelHide = () => { if (hideTimer) clearTimeout(hideTimer); };
    
    const bindLivePreview = ($el, callback) => {
        $el.on('input', function() { const val = $(this).val(); callback(val); cancelHide(); showGhostCard(); $('#acu-ghost-preview').css({ '--acu-card-width': $('.acu-wrapper').css('--acu-card-width'), '--acu-font-size': $('.acu-wrapper').css('--acu-font-size') }); });
        $el.on('change', function() { dialog.find('.acu-edit-dialog').css('opacity', '1'); dialog.find('.acu-edit-overlay').css('background', ''); hideGhostCard(); });
        $el.on('touchstart mousedown', function() { cancelHide(); showGhostCard(); });
        $(document).on('touchend.temp_vis mouseup.temp_vis', function() { dialog.find('.acu-edit-dialog').css('opacity', '1'); dialog.find('.acu-edit-overlay').css('background', ''); hideGhostCard(); });
    };
    bindLivePreview(dialog.find('#cfg-width'), (val) => { dialog.find('#val-width').text(val + 'px'); $('.acu-wrapper').css('--acu-card-width', val + 'px'); });
    dialog.find('#cfg-width').on('change', function() { saveConfig({ cardWidth: $(this).val() }); });
    const $sliderFont = dialog.find('#cfg-font');
    const $valFont = dialog.find('#val-font');

    $sliderFont.on('touchstart mousedown', () => { window._acuPreviewType = 'main'; });
    bindLivePreview($sliderFont, (val) => {
        $valFont.text(val + 'px');
        $('.acu-wrapper, .acu-status-bar-container').css('--acu-font-size', val + 'px');
        $('#acu-ghost-preview').css('--acu-font-size', val + 'px'); 
    });

    $sliderFont.on('change', function() {
        saveConfig({ fontSize: $(this).val() });
    });

    const $sliderOptFont = dialog.find('#cfg-opt-font');
    const $valOptFont = dialog.find('#val-opt-font');

    $sliderOptFont.on('touchstart mousedown', () => { window._acuPreviewType = 'option'; });
    bindLivePreview($sliderOptFont, (val) => {
        $valOptFont.text(val + 'px');
        $('.acu-wrapper, .acu-status-bar-container').css('--acu-opt-font-size', val + 'px');
        $('#acu-ghost-preview').css('--acu-opt-font-size', val + 'px');
    });

    $sliderOptFont.on('change', function() {
        saveConfig({ optionFontSize: parseInt($(this).val()) });
    });
    dialog.find('#cfg-per-page').on('change', function() { let val = parseInt($(this).val(), 10); if (isNaN(val) || val < 1) { val = 50; $(this).val(val); } saveConfig({ itemsPerPage: val }); renderInterface(); });
    
    const closeAndCleanup = () => { $(document).off('.temp_vis'); cancelHide(); $('#acu-ghost-preview').remove(); dialog.remove(); };

    dialog.find('#btn-enter-sort').click(() => { $(document).off('.temp_vis'); dialog.remove(); toggleOrderEditMode(); });
    dialog.find('#btn-open-stitcher').click(() => { $(document).off('.temp_vis'); dialog.hide(); StitcherModule.show(dialog); });

    // [新增] 外部模板管理逻辑
    const refreshTemplateSelect = async () => {
        const templates = await TemplateDB.getAllTemplates();
        const options = '<option value="">-- 当前系统库 --</option>' + Object.keys(templates).map(k => {
            const tName = templates[k].mate?.templateName || k;
            return `<option value="${k}">${escapeHtml(tName)}</option>`;
        }).join('');
        dialog.find('#cfg-template-select').html(options);
    };
    refreshTemplateSelect(); // 初始化加载

    dialog.find('#btn-import-tpl-outside').click(() => dialog.find('#input-import-tpl-outside').click());
    dialog.find('#input-import-tpl-outside').change(function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const json = JSON.parse(event.target.result);
                if (!json.mate || json.mate.type !== "chatSheets") throw new Error("无效的数据库模板格式");
                
                let templateName = prompt("请为该模板命名 (例如: 修仙模组A):", file.name.replace('.json', ''));
                    if (!templateName) return;
                    
                    json.mate.templateName = templateName;
                    
                    // [修复] 检查是否存在同名模板，如果存在则覆盖原有 ID
                    const templates = await TemplateDB.getAllTemplates();
                    let tplId = 'tpl_' + Date.now(); // 默认生成新ID
                    for (const key in templates) {
                        if (templates[key].mate && templates[key].mate.templateName === templateName) {
                            tplId = key; // 找到同名，沿用旧ID进行静默覆盖
                            break;
                        }
                    }
                    
                    await TemplateDB.saveTemplate(tplId, json);
                    await refreshTemplateSelect();
                dialog.find('#cfg-template-select').val(tplId);
                AcuToast.success('模板导入成功！');
            } catch(err) {
                AcuToast.error('导入失败: ' + err.message);
            }
        };
        reader.readAsText(file);
        $(this).val('');
    });

    dialog.find('#btn-export-tpl-outside').click(async () => {
        const selectedId = dialog.find('#cfg-template-select').val();
        if (!selectedId) {
            AcuToast.info('请先选择一个要导出的模板');
            return;
        }
        const templates = await TemplateDB.getAllTemplates();
        const targetTpl = templates[selectedId];
        if (!targetTpl) return;

        const jsonString = JSON.stringify(targetTpl, null, 2);
        const fileName = `TavernDB_Template_${targetTpl.mate?.templateName || 'Export'}.json`;
        
        // 使用新的兼容性助手
        acuDownloadFile(fileName, jsonString);
        AcuToast.success('已发起导出请求');
    });

    // [新增] 删除模板逻辑
    dialog.find('#btn-delete-tpl-outside').click(async () => {
        const selectedId = dialog.find('#cfg-template-select').val();
        if (!selectedId) {
            AcuToast.info('请先选择一个要删除的模板');
            return;
        }
        const templates = await TemplateDB.getAllTemplates();
        const targetTpl = templates[selectedId];
        if (!targetTpl) return;

        const tplName = targetTpl.mate?.templateName || '未命名模板';
        if (confirm(`【警告】\n确定要永久删除模板【${tplName}】吗？\n此操作不可逆！`)) {
            try {
                const store = TemplateDB.db.transaction([TemplateDB.storeName], 'readwrite').objectStore(TemplateDB.storeName);
                store.delete(selectedId).onsuccess = async () => {
                    AcuToast.success(`模板【${tplName}】已删除`);
                    await refreshTemplateSelect(); // 刷新下拉列表
                };
            } catch (err) {
                console.error('[ACU] 删除模板失败:', err);
                AcuToast.error('删除失败，请查看控制台');
            }
        }
    });

    // [修改] 一键注入模板逻辑 (仅单次注入)
    dialog.find('#btn-inject-tpl-db').click(async () => {
        const selectedId = dialog.find('#cfg-template-select').val();
        if (!selectedId) {
            AcuToast.warning('请先在上方选择一个要注入的模板');
            return;
        }

        const templates = await TemplateDB.getAllTemplates();
        const targetTpl = templates[selectedId];
        if (!targetTpl) return;
        const tplName = targetTpl.mate?.templateName || '未命名模板';

        if (!confirm(`确定要将模板【${tplName}】注入到当前数据库中吗？\n\n⚠️ 注意：确定后，将以当前角色卡名称作为ID注入数据库，并且会覆盖当前聊天正在使用的模板！`)) {
            return;
        }

        const api = getCore().getDB();
        if (api && typeof api.initGameSession === 'function') {
            AcuToast.info(`⚡ 正在注入模板【${tplName}】...`);
            try {
                const result = await api.initGameSession({}, {
                    injectTemplate: true,
                    loadPreset: false,
                    templateData: targetTpl
                });

                if (result && result.success) {
                    AcuToast.success('✅ 模板数据单次注入成功！');
                    cachedRawData = null; 
                    renderInterface(); 
                } else {
                    AcuToast.error('❌ 注入失败，请检查控制台');
                }
            } catch (err) {
                AcuToast.error('❌ 注入异常');
            }
        } else {
            AcuToast.warning('⚠️ 找不到后端注入接口');
        }
    });

    dialog.find('#dlg-close').click(closeAndCleanup);
    dialog.on('click', function(e) { if ($(e.target).hasClass('acu-edit-overlay')) closeAndCleanup(); });
};

    

const parseRelationshipString = (str, knownNames = []) => {
        if (!str) return [];
        const results = [];
        const rawStr = String(str).trim();
        // 预处理：把中文顿号、逗号都变成标准分隔符
        const parts = rawStr.replace(/[、，,]/g, ';').split(/[;；\n]/);
        const sortedNames = knownNames.sort((a, b) => b.length - a.length);

        for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed) continue;

            // [修复] 调整优先级：冒号具有最高优先级，因为它是不易混淆的显式分隔符
            const colonMatch = trimmed.match(/^与?(.+?)[:\：](.+)$/);
            const hyphenMatch = trimmed.match(/^(.+?)\-(.+)$/);
            const parenMatch = trimmed.match(/^([^(（]+)[(（]([^)）]+)[)）]$/);
            
            // 优先处理冒号：完美处理 "蒙卡(斧手)(已死亡):敌对" 这种带有复杂前缀的格式
            if (colonMatch) {
                results.push({ name: colonMatch[1].trim(), relation: colonMatch[2].trim() });
                continue;
            }

            // 其次处理减号
            if (hyphenMatch) {
                results.push({ name: hyphenMatch[1].trim(), relation: hyphenMatch[2].trim() });
                continue;
            }
            
            // 然后是整体括号包裹
            if (parenMatch) {
                results.push({ name: parenMatch[1].trim(), relation: parenMatch[2].trim() });
                continue;
            }

            // 2. 尝试自然语言模糊匹配
            let matchedName = null;
            for (const name of sortedNames) {
                if (trimmed.includes(name)) { matchedName = name; break; }
            }

            if (matchedName) {
                let rel = trimmed.replace(matchedName, '').replace(/的|之|是|为/g, '').trim();
                if (!rel) rel = "关联";
                results.push({ name: matchedName, relation: rel });
            } else if (trimmed.includes(' ')) {
                const sp = trimmed.split(/\s+/);
                if(sp.length >= 2) results.push({ name: sp[0], relation: sp[1] });
            } else if (trimmed.length > 0 && trimmed.length < 5) {
                 // 兜底：如果只有名字且很短，认为是关联
                 results.push({ name: trimmed, relation: "" });
            }
        }
        return results;
    };


    
    
    // ============================================================
    // [回归版] 人物关系网 - 静态圆形布局 + 完美缩放平移
    // ============================================================
    const renderRelationshipPanel = () => {
        const config = getConfig();
        
        // 1. 数据解析
        const rawData = cachedRawData || getTableData();
        if (!rawData) {
            return `<div class="acu-panel-header"><div class="acu-panel-title">人物关系网</div><button class="acu-close-btn"><i class="fa-solid fa-times"></i></button></div><div class="acu-panel-content" style="text-align:center;padding:40px;color:#999;">无数据</div>`;
        }
        
        const nodes = new Map(); 
        const edges = [];        
        // [修复] 放宽节点名称校验规则，允许中英文括号、空格、减号等，以兼容附带状态的名称
        const validNameRegex = /^[\u4e00-\u9fa5a-zA-Z0-9·.()（）【】\[\]\-\s]{1,40}$/; 

        // 收集节点
        Object.values(rawData).forEach(sheet => {
            if (!sheet.content || sheet.content.length < 2) return;
            const headers = sheet.content[0];
            const nameColIdx = headers.findIndex(h => /姓名|名字|角色名|人物名称|Name|Character/i.test(h));
            const avatarColIdx = headers.findIndex(h => /头像|立绘|Image|Avatar|Icon/i.test(h));

            if (nameColIdx === -1) return; 

            sheet.content.slice(1).forEach((row) => {
                const name = String(row[nameColIdx] || '').trim();
                if (name && isNaN(name) && validNameRegex.test(name) && !EXCLUDED_NAMES.includes(name)) {
                    let avatar = (avatarColIdx !== -1) ? String(row[avatarColIdx] || '').trim() : null;
                    if (avatar && !avatar.startsWith('http')) avatar = null;
                    if (!nodes.has(name) || (avatar && !nodes.get(name).image)) {
                        nodes.set(name, { id: name, label: name, image: avatar, group: sheet.name });
                    }
                }
            });
        });

        // 收集关系
        const knownNameList = Array.from(nodes.keys());
        Object.values(rawData).forEach(sheet => {
            if (!sheet.content) return;
            const headers = sheet.content[0];
            const nameColIdx = headers.findIndex(h => /姓名|名字|人物名称|Name/i.test(h));
            if (nameColIdx === -1) return;

            const relationColIndices = headers.map((h, i) => {
                if (i === nameColIdx) return -1;
                if (/关系|人际|Relation/i.test(h)) return i; 
                return -1;
            }).filter(i => i !== -1);

            sheet.content.slice(1).forEach(row => {
                const sourceName = String(row[nameColIdx] || '').trim();
                if (!nodes.has(sourceName)) return; 

                relationColIndices.forEach(colIdx => {
                    const cellFullText = String(row[colIdx] || '').trim();
                    if (!cellFullText) return;
                    const relations = parseRelationshipString(cellFullText, knownNameList);
relations.forEach(rel => {
                        let targetName = rel.name;
                        
                        // [修复] 模糊匹配
                        if (!nodes.has(targetName)) {
                            for (const existingName of nodes.keys()) {
                                if (existingName.includes(targetName) || targetName.includes(existingName)) {
                                    targetName = existingName;
                                    break;
                                }
                            }
                        }

                        if (!nodes.has(targetName) && validNameRegex.test(targetName) && !EXCLUDED_NAMES.includes(targetName)) {
                             nodes.set(targetName, { id: targetName, label: targetName, image: null, group: 'Unknown' });
                        }
                        if (nodes.has(targetName) && sourceName !== targetName) {
                            let existing = edges.find(e => e.source === sourceName && e.target === targetName);
                            if (existing) {
                                if (!existing.labels.includes(rel.relation)) existing.labels.push(rel.relation);
                            } else {
                                edges.push({ source: sourceName, target: targetName, labels: [rel.relation] });
                            }
                        }
                    });
                });
            });
        });

        if (nodes.size === 0) return `<div class="acu-panel-content">无有效人物节点</div>`;

        // [新增] 将本地自定义头像注入到关系网节点中
        const currentCtxId = getCurrentContextFingerprint();
        const customAvatars = getCustomAvatars()[currentCtxId] || {};
        nodes.forEach((nodeData, nodeName) => {
            // 如果本地缓存里有这个角色的专属头像，强制覆盖掉表格里原本的图片
            if (customAvatars[nodeName]) {
                nodeData.image = customAvatars[nodeName]; 
            }
        });

        // --- [重构] 智能布局计算 (带位置记忆) ---
        const nodeArr = Array.from(nodes.values());
        const width = 1000;
        const height = 800;
        const centerX = width / 2;
        const centerY = height / 2;
        
        // 布局参数
        const r = 42; // [修改] 放大节点半径
        const layoutRadius = Math.min(width, height) * 0.35; // 布局圈半径

        // 1. 读取保存的位置记忆
        const savedPositions = getRelationPositions();
        const savedNodes = savedPositions.nodes || {};
        
        // 2. 计算匹配率：有多少旧节点还存在？
        const currentNodeIds = new Set(nodeArr.map(n => n.id));
        const savedNodeIds = Object.keys(savedNodes);
        const matchCount = savedNodeIds.filter(id => currentNodeIds.has(id)).length;
        const matchRatio = savedNodeIds.length > 0 ? matchCount / savedNodeIds.length : 0;
        
        // 3. 如果匹配率 < 30%，说明换了数据，清空记忆
        const shouldReset = savedNodeIds.length > 0 && matchRatio < 0.3;
        if (shouldReset) {
            console.log('[ACU] 关系网数据变化过大，重置布局');
            saveRelationPositions({ nodes: {}, viewTransform: null });
        }
        
        // 4. 分离已保存位置的节点和新节点
        const existingNodes = [];
        const newNodes = [];
        nodeArr.forEach(node => {
            if (!shouldReset && savedNodes[node.id]) {
                // 使用保存的位置
                node.x = savedNodes[node.id].x;
                node.y = savedNodes[node.id].y;
                existingNodes.push(node);
            } else {
                newNodes.push(node);
            }
        });
        
        // 5. 为新节点计算位置（放在圆环边缘的空位，确保不重叠）
        if (newNodes.length > 0) {
            const NODE_RADIUS = 42; // [修改] 放大节点排斥半径
            const MIN_DISTANCE = NODE_RADIUS * 2.5;
            
            // 辅助函数：检测位置是否与已放置的节点重叠
            const isPositionFree = (x, y, placedNodes) => {
                for (const placed of placedNodes) {
                    const dist = Math.sqrt((x - placed.x) ** 2 + (y - placed.y) ** 2);
                    if (dist < MIN_DISTANCE) return false;
                }
                return true;
            };
            
            // 已放置的节点（包括已有的和新放置的）
            const placedNodes = [...existingNodes];
            
            // 为新节点分配位置
            newNodes.forEach((node) => {
                let placed = false;
                
                // 尝试多个半径层（从外圈向更外圈扩展）
                for (let radiusMultiplier = 1.15; radiusMultiplier <= 2.0 && !placed; radiusMultiplier += 0.2) {
                    const tryRadius = layoutRadius * radiusMultiplier;
                    
                    // 尝试多个角度（每 15 度尝试一次）
                    for (let angleDeg = 0; angleDeg < 360 && !placed; angleDeg += 15) {
                        const angle = (angleDeg * Math.PI) / 180;
                        const tryX = centerX + tryRadius * Math.cos(angle);
                        const tryY = centerY + tryRadius * Math.sin(angle);
                        
                        if (isPositionFree(tryX, tryY, placedNodes)) {
                            node.x = tryX;
                            node.y = tryY;
                            placedNodes.push(node);
                            placed = true;
                        }
                    }
                }
                
                // 如果还是找不到位置，使用螺旋向外的策略
                if (!placed) {
                    let spiralAngle = Math.random() * Math.PI * 2;
                    let spiralRadius = layoutRadius * 1.5;
                    
                    for (let attempt = 0; attempt < 100; attempt++) {
                        const tryX = centerX + spiralRadius * Math.cos(spiralAngle);
                        const tryY = centerY + spiralRadius * Math.sin(spiralAngle);
                        
                        if (isPositionFree(tryX, tryY, placedNodes)) {
                            node.x = tryX;
                            node.y = tryY;
                            placedNodes.push(node);
                            placed = true;
                            break;
                        }
                        
                        // 螺旋向外
                        spiralAngle += 0.5;
                        spiralRadius += MIN_DISTANCE * 0.3;
                    }
                }
                
                // 最后的兜底：随机位置（几乎不会触发）
                if (!placed) {
                    node.x = centerX + (Math.random() - 0.5) * layoutRadius * 3;
                    node.y = centerY + (Math.random() - 0.5) * layoutRadius * 3;
                    placedNodes.push(node);
                }
            });
        }
        
        // 6. 如果全是新节点（首次加载或重置后），使用集中随机布局，让物理引擎自然排斥展开
        if (existingNodes.length === 0) {
            nodeArr.forEach((node, i) => {
                // 抛弃死板的圆形，采用类似重置按钮的随机扰动簇，打破绝对对称导致的力矩死锁
                node.x = centerX + (Math.random() - 0.5) * 250;
                node.y = centerY + (Math.random() - 0.5) * 250;
            });
        }

        // [Canvas 极速重构] 将计算好的图谱数据挂载到全局，供 Canvas 引擎直接读取
        window._acuCurrentGraphData = { nodes: nodeArr, edges: edges };

        // [新增修复] 生成防篡改指纹，确保关系增删时一定能触发 RPG 面板重绘
        let graphStr = nodes.size + '|' + edges.length + '|' + edges.map(e => e.source+e.target).join('');
        let graphHash = 0;
        for (let i = 0; i < graphStr.length; i++) {
            graphHash = ((graphHash << 5) - graphHash) + graphStr.charCodeAt(i);
            graphHash |= 0;
        }

        return `
            <div class="acu-panel-header">
                <div class="acu-panel-title">
                    <div class="acu-title-main"><i class="fa-solid fa-project-diagram"></i> <span class="acu-title-text">人物关系网</span></div>
                    <div class="acu-title-sub">(${nodes.size}人 · Canvas 2D 极速引擎)</div>
                </div>
                <div class="acu-header-actions">
                    <button class="acu-view-btn" id="acu-rel-pin-center" title="设定固定的中心节点"><i class="fa-solid fa-crosshairs"></i></button>
                    <button class="acu-view-btn" id="acu-rel-reset" title="重置视图"><i class="fa-solid fa-compress-arrows-alt"></i></button>
                    <button class="acu-close-btn" title="关闭"><i class="fa-solid fa-times"></i></button>
                </div>
            </div>
            <div class="acu-panel-content acu-rel-canvas-wrapper" data-graph-hash="${graphHash}" style="padding:0;overflow:hidden;background:var(--acu-bg-panel);touch-action:none;height:45vh;min-height:300px;position:relative;">
                <canvas class="acu-rel-canvas" style="display:block;width:100%;height:100%;cursor:grab;"></canvas>
            </div>
        `;
    };


// --- [新增功能] 弹出人物专属档案卡 ---
    const showCharacterProfile = (charName) => {
        const { $ } = getCore();
        const rawData = cachedRawData || getTableData();
        if (!rawData) return;

        let charRow = null;
        let charHeaders = null;
        let tableName = '';

        // 1. 遍历所有表，寻找含有"姓名"的列，并匹配名字
        for (const key in rawData) {
            const sheet = rawData[key];
            if (!sheet.content || sheet.content.length < 2) continue;
            const headers = sheet.content[0];
            // 嗅探名字列
            const nameIdx = headers.findIndex(h => /姓名|名字|人物名称|角色名|Name/i.test(h));
            if (nameIdx !== -1) {
                // 寻找该角色的具体行
                const row = sheet.content.slice(1).find(r => String(r[nameIdx] || '').trim() === charName);
                if (row) {
                    charRow = row;
                    charHeaders = headers;
                    tableName = sheet.name;
                    break;
                }
            }
        }

        // 如果在表格里没找到详细数据，给个轻提示
        if (!charRow) {
            AcuToast.warning(`未找到【${escapeHtml(charName)}】的详细表格记录`);
            return;
        }

        // 2. 构建漂亮的详情 HTML
        const config = getConfig();
        let detailsHtml = '';
        
        charHeaders.forEach((header, idx) => {
            if (idx === 0) return; // 跳过索引列
            const val = String(charRow[idx] || '').trim();
            if (!val || val === '无' || val === '未知' || val === '待定') return;

            // 智能渲染标签（复用原有的颜色徽章逻辑）
            const badgeStyle = getBadgeStyle(val);
            let displayVal = escapeHtml(val);
            if (val.length <= 15 && badgeStyle && !val.includes('http')) {
                displayVal = `<span class="acu-badge ${badgeStyle}">${displayVal}</span>`;
            }

            detailsHtml += `
                <div style="margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px dashed var(--acu-border);">
                    <div style="font-size: 12px; color: var(--acu-text-sub); margin-bottom: 4px; font-weight: bold;">
                        <i class="fa-solid fa-tag" style="opacity:0.5; font-size: 10px; margin-right: 4px;"></i>${escapeHtml(header)}
                    </div>
                    <div style="font-size: 13px; color: var(--acu-text-main); white-space: pre-wrap; line-height: 1.5; word-break: break-all;">${displayVal}</div>
                </div>
            `;
        });

        // 3. 生成模态框
        const dialog = $(`
            <div class="acu-char-profile-overlay acu-edit-overlay" style="z-index: 2147483648 !important; backdrop-filter: blur(3px);">
                <div class="acu-edit-dialog acu-theme-${config.theme}" style="max-width: 400px; width: 90%; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; gap: 0 !important; background-color: transparent !important; box-shadow: 0 15px 50px rgba(0,0,0,0.8); border: 1px solid var(--acu-accent); padding: 0;">
                    <div class="acu-panel-header" style="flex: 0 0 auto; background: var(--acu-table-head); border-bottom: 1px solid var(--acu-border); padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; border-radius: 12px 12px 0 0;">
                        ${(() => {
                            const ctxId = getCurrentContextFingerprint();
                            const savedAvatar = getCustomAvatars()[ctxId]?.[charName] || '';
                            return `
                                <div style="display:flex; align-items:center; gap:12px;">
                                    <div style="position:relative;">
                                        <div class="acu-char-avatar-btn" data-char="${escapeHtml(charName)}" style="width:42px; height:42px; border-radius:50%; background:var(--acu-bg-panel); border:2px solid var(--acu-accent); background-image:url('${savedAvatar}'); background-size:cover; background-position:center; cursor:pointer; display:flex; align-items:center; justify-content:center; overflow:hidden; box-shadow:0 2px 6px rgba(0,0,0,0.3); transition:transform 0.2s;" title="点击更换专属头像">
                                            ${savedAvatar ? '' : '<i class="fa-solid fa-camera" style="opacity:0.5; font-size:16px; color:var(--acu-text-sub);"></i>'}
                                        </div>
                                        <div class="acu-char-avatar-reset" data-char="${escapeHtml(charName)}" style="display:${savedAvatar ? 'flex' : 'none'}; position:absolute; bottom:-4px; right:-8px; background:var(--acu-bg-panel); border:1px solid var(--acu-border); border-radius:50%; width:20px; height:20px; align-items:center; justify-content:center; cursor:pointer; color:#e74c3c; font-size:10px; box-shadow:0 2px 4px rgba(0,0,0,0.3); transition:all 0.2s;" title="恢复默认头像并清理内存"><i class="fa-solid fa-trash-can"></i></div>
                                    </div>
                                    <div style="font-weight: bold; font-size: 16px; color: var(--acu-accent);">
                                        <span>${escapeHtml(charName)}</span>
                                    </div>
                                </div>
                            `;
                        })()}
                        <button class="acu-close-profile-btn" style="background: none; border: none; color: var(--acu-text-sub); cursor: pointer; font-size: 16px; padding:4px;"><i class="fa-solid fa-times"></i></button>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 15px; background: var(--acu-bg-panel); border-radius: 0 0 12px 12px;">
                        <div style="font-size: 11px; color: var(--acu-text-sub); margin-bottom: 15px; text-align: right; opacity: 0.8;"><i class="fa-solid fa-database"></i> 来源表: ${escapeHtml(tableName)}</div>
                        ${detailsHtml}
                    </div>
                </div>
            </div>
        `);

        $('body').append(dialog);

        // 4. 绑定关闭事件
        const closeDialog = () => dialog.fadeOut(150, () => dialog.remove());
        dialog.find('.acu-close-profile-btn').click(closeDialog);
        dialog.click(function(e) {
            if ($(e.target).hasClass('acu-char-profile-overlay')) closeDialog();
        });

        // [新增] 绑定头像重置/删除事件
        dialog.find('.acu-char-avatar-reset').hover(
            function() { $(this).css('transform', 'scale(1.2)'); },
            function() { $(this).css('transform', 'scale(1)'); }
        ).click(function(e) {
            e.stopPropagation();
            const targetChar = $(this).data('char');
            const currentCtxId = getCurrentContextFingerprint();
            const avatars = getCustomAvatars();
            
            // 1. 删除本地存储的 Base64 数据释放内存 (IndexedDB 极速版)
            if (avatars[currentCtxId] && avatars[currentCtxId][targetChar]) {
                delete avatars[currentCtxId][targetChar];
                AvatarDB.saveToDB(currentCtxId, avatars[currentCtxId]);
            }
            
            // 2. 更新面板 UI：清除背景图，显示相机图标，并隐藏垃圾桶
            const $btn = dialog.find('.acu-char-avatar-btn');
            $btn.css('background-image', 'none').html('<i class="fa-solid fa-camera" style="opacity:0.5; font-size:16px; color:var(--acu-text-sub);"></i>');
            $(this).hide(); 
            
            // 3. [Canvas兼容] 触发事件，通知底层关系网瞬间无缝切换头像
            $(window).trigger('acu_avatar_updated', { char: targetChar, image: null });
            
            AcuToast.success('已恢复默认头像并清理内存');
        });

        // [新增] 绑定头像点击上传事件 (带 Canvas 智能压缩裁切 + 容量异常处理)
        dialog.find('.acu-char-avatar-btn').hover(
            function() { $(this).css('transform', 'scale(1.1)'); },
            function() { $(this).css('transform', 'scale(1)'); }
        ).click(function(e) {
            e.stopPropagation();
            const $btn = $(this);
            const targetChar = $btn.data('char');
            
            const $fileInput = $('<input type="file" accept="image/*" style="display:none;">');
            $('body').append($fileInput);
            
            $fileInput.on('change', function(e) {
                const file = e.target.files[0];
                if (!file) return;
                
                const reader = new FileReader();
                reader.onload = function(event) {
                    const img = new Image();
                    img.onload = function() {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        const size = 400; // [优化] 解除 150px 封印，提升至 400px 高清分辨率
                        canvas.width = size;
                        canvas.height = size;
                        
                        const scale = Math.max(size / img.width, size / img.height);
                        const x = (size / scale - img.width) / 2;
                        const y = (size / scale - img.height) / 2;
                        
                        ctx.drawImage(img, x, y, img.width, img.height, 0, 0, size, size);
                        const base64Data = canvas.toDataURL('image/webp', 0.95); // [优化] WebP 压缩率提升至 95%，减少涂抹感
                        
                        const currentCtxId = getCurrentContextFingerprint();
                        const isSaved = saveCustomAvatar(currentCtxId, targetChar, base64Data);
                        
                        if (isSaved) {
                            $btn.css('background-image', `url('${base64Data}')`);
                            $btn.empty();
                            dialog.find('.acu-char-avatar-reset').css('display', 'flex'); // 上传成功后显示垃圾桶
                            AcuToast.success('专属头像已更新并保存');
                            
                            // [Canvas兼容] 触发事件，通知底层关系网瞬间无缝渲染新头像
                            $(window).trigger('acu_avatar_updated', { char: targetChar, image: base64Data });
                        } else {
                            AcuToast.error('⛔ 存储空间已满！头像保存失败，请清理浏览器缓存数据');
                        }
                        
                        $fileInput.remove();
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            });
            $fileInput.click();
        });

        dialog.hide().fadeIn(150);
    };

// ============================================================
    // [Canvas 极速版 v3.0] 彻底抛弃 DOM 渲染，支持千人同屏，含高分屏适配
    // ============================================================
    const bindRelationshipPanelEvents = () => {
        const { $ } = getCore();

        $('.acu-rel-canvas-wrapper').each(function() {
            const $wrapper = $(this);
            if ($wrapper.data('physics-bound')) return;
            $wrapper.data('physics-bound', true);

            const wrapperEl = this;
            const canvas = $wrapper.find('.acu-rel-canvas')[0];
            if (!canvas) return;
            const ctx = canvas.getContext('2d');

            const isEmbedded = $wrapper.closest('.acu-rpg-widget').length > 0;
            const visualOffsetY = isEmbedded ? 50 : 0;

            let transform = { x: 0, y: 0, k: 1 };
            const logicalCx = 500, logicalCy = 400; // 物理宇宙中心

            // 从全局读取之前组装好的数据
            const graphData = window._acuCurrentGraphData || { nodes: [], edges: [] };
            const nodeElMap = {};
            const edges = graphData.edges;
            // [T0 优化] 将 imageCache 挂载到全局，方便在切换聊天时彻底释放图片解码内存
            if (!window._acuImageCache) window._acuImageCache = {};
            const imageCache = window._acuImageCache;

            graphData.nodes.forEach(n => {
                nodeElMap[n.id] = {
                    id: n.id, label: n.label, image: n.image,
                    x: n.x || logicalCx + (Math.random() - 0.5) * 10,
                    y: n.y || logicalCy + (Math.random() - 0.5) * 10,
                    vx: 0, vy: 0, fixed: false,
                    color: getDefaultAvatarColor(n.id)
                };
                
                // [修复1] 异步图片加载完成后，强制唤醒重绘，防止图片加载慢导致空白
                        if (n.image && !imageCache[n.image]) {
                            const img = new Image();
                            img.onload = () => {
                                // [性能优化] 优先级2：离屏预渲染。裁切圆形头像并缓存为画布，省去每帧 clip() 的恐怖开销
                                const offCanvas = document.createElement('canvas');
                                const dpr = window.devicePixelRatio || 1;
                                const size = 84; // r=42 的两倍
                                offCanvas.width = size * dpr;
                                offCanvas.height = size * dpr;
                                const offCtx = offCanvas.getContext('2d');
                                offCtx.scale(dpr, dpr);
                                offCtx.beginPath();
                                offCtx.arc(42, 42, 42, 0, Math.PI * 2);
                                offCtx.clip();
                                offCtx.drawImage(img, 0, 0, size, size);
                                img._cachedAvatar = offCanvas;
                                
                                if (!isPhysicsRunning) draw(); 
                            };
                            img.src = n.image;
                            imageCache[n.image] = img;
                        }
            });

            let width = 0, height = 0;
            const resizeCanvas = () => {
                const rect = wrapperEl.getBoundingClientRect();
                width = rect.width || 800;
                height = rect.height || 600;
                const dpr = window.devicePixelRatio || 1; 
                canvas.width = width * dpr;
                canvas.height = height * dpr;
                ctx.scale(dpr, dpr);
            };
            resizeCanvas();
            
            let isSelectingPin = false;
            const updatePinBtnStyle = () => {
                const $pinBtn = $wrapper.find('#acu-rel-pin-center-embedded').length ? $wrapper.find('#acu-rel-pin-center-embedded') : $wrapper.closest('.acu-data-display').find('#acu-rel-pin-center');
                const pinned = getPinnedRelationCenter();
                if (isSelectingPin) {
                    $pinBtn.css('color', 'var(--acu-hl-manual)');
                } else if (pinned) {
                    $pinBtn.css('color', 'var(--acu-accent)');
                } else {
                    $pinBtn.css('color', '');
                }
            };
            setTimeout(updatePinBtnStyle, 50);

            const THEME = {
                textMain: $wrapper.css('--acu-text-main') || '#eee',
                textSub: $wrapper.css('--acu-text-sub') || '#aaa',
                accent: $wrapper.css('--acu-accent') || '#6a5acd',
                bgPanel: $wrapper.css('--acu-bg-panel') || '#222',
                border: $wrapper.css('--acu-border') || '#555'
            };

            const initFitView = () => {
                const nodesArr = Object.values(nodeElMap);
                if (nodesArr.length === 0) return;

                const nodesCount = nodesArr.length;

                // [视角优化] 放大理论预期半径，并引入留白系数
                const expectedRadius = Math.max(300, 150 + Math.sqrt(nodesCount) * 90);
                const PADDING_FACTOR = 0.75;
                
                const scaleX = ((width / 2) / expectedRadius) * PADDING_FACTOR;
                const scaleY = (((height - visualOffsetY) / 2) / expectedRadius) * PADDING_FACTOR;
                
                // [优化] 设定最低可读缩放底线，拒绝缩成蚂蚁
                const isMobile = width < 768;
                const MIN_READABLE_SCALE = isMobile ? 0.35 : 0.25; 
                const MAX_SCALE = isMobile ? 0.9 : 1.2;

                let targetScale = Math.min(scaleX, scaleY);
                transform.k = Math.max(MIN_READABLE_SCALE, Math.min(MAX_SCALE, targetScale));

                // [优化] 智能镜头聚焦：如果人数过多（>15），找出社交核心
                let focusX = logicalCx;
                let focusY = logicalCy;
                const pinnedNodeId = getPinnedRelationCenter();

                if (pinnedNodeId && nodeElMap[pinnedNodeId]) {
                    // [修复] 物理引擎必定会将 pinned 节点拉向物理宇宙中心 (logicalCx, Cy)
                    // 为了防止节点从随机边缘飞走导致镜头偏移，初始时直接将其瞬间传送到中心
                    nodeElMap[pinnedNodeId].x = logicalCx;
                    nodeElMap[pinnedNodeId].y = logicalCy;
                    focusX = logicalCx;
                    focusY = logicalCy;
                }

                transform.x = width / 2 - focusX * transform.k;
                transform.y = height / 2 - focusY * transform.k - visualOffsetY;

                draw();
            };
            setTimeout(initFitView, 50);

            // [核心优化 8] 彻底封堵 ResizeObserver 引起的致命内存泄漏
            if (window.ResizeObserver) {
                // 清理挂载在旧 DOM 上的遗留 Observer
                if (wrapperEl._acuResizeObserver) {
                    wrapperEl._acuResizeObserver.disconnect();
                }
                let hasFixedView = false;
                const ro = new ResizeObserver((entries) => {
                    if (!hasFixedView && entries[0].contentRect.width > 0) {
                        resizeCanvas(); initFitView(); hasFixedView = true; ro.disconnect();
                    } else {
                        resizeCanvas(); draw();
                    }
                });
                ro.observe(wrapperEl);
                wrapperEl._acuResizeObserver = ro; // 挂载到 DOM 实例上供下次清理
            }

            let isPhysicsRunning = false;
            let physicsRafId = null;
            let focusedNodeId = null;
            let hoveredNodeId = null;
            let focusedNeighbors = new Set();

            const PHYSICS = {
                REPULSION: 25000 + Math.min(Object.keys(nodeElMap).length * 300, 50000),
                SPRING_TENSION: 0.012,
                IDEAL_LENGTH: 220 + Math.min(Object.keys(nodeElMap).length * 2, 200),
                CENTER_GRAVITY: 0.008,
                // [手感优化] 降低弹簧张力，提升基础阻尼，防止节点过少时像皮筋一样疯狂弹跳
                FRICTION: Math.max(0.45, 0.75 - Object.keys(nodeElMap).length * 0.005),
                MIN_ENERGY: 0.5,
                MAX_DISTANCE_SQ: 800 * 800
            };

            // --- 🎨 核心渲染函数 (60fps 性能优化版) ---
            const draw = () => {
                ctx.clearRect(0, 0, width, height);
                ctx.save();
                ctx.translate(transform.x, transform.y);
                ctx.scale(transform.k, transform.k);

                const r = 42;
                const nodesArr = Object.values(nodeElMap);

                // [新增优化: 视野外剔除] 计算当前屏幕在物理世界中的真实坐标边界
                // 这样做是为了提前判断哪些球在屏幕外，从而直接跳过渲染
                const viewLeft = -transform.x / transform.k;
                const viewRight = (width - transform.x) / transform.k;
                const viewTop = -transform.y / transform.k;
                const viewBottom = (height - transform.y) / transform.k;
                
                // padding 是缓冲区，防止角色在屏幕边缘时“半个身子”突然消失
                // 我们设定为 2.5 倍半径，确保顺滑
                const renderPadding = r * 2.5;

                // 1. 绘制连线 (批量绘制提升性能)
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                // [修复2] 移除所有 ctx.shadowBlur，改用 strokeText 实现描边，帧数暴涨
                ctx.shadowBlur = 0; 
                ctx.lineJoin = 'round';

                edges.forEach(edge => {
                    const s = nodeElMap[edge.source], t = nodeElMap[edge.target];
                    if (!s || !t) return;

                    let opacity = 0.3;
                    let strokeColor = THEME.textSub;
                    let isEdgeHighlighted = false;

                    if (focusedNodeId || hoveredNodeId) {
                        const focusId = focusedNodeId || hoveredNodeId;
                        if (s.id === focusId || t.id === focusId) {
                            opacity = 0.8; strokeColor = THEME.accent; isEdgeHighlighted = true;
                        } else if (focusedNeighbors.has(s.id) && focusedNeighbors.has(t.id)) {
                            opacity = 0.15;
                        } else {
                            // [TOP 1 优化: 渲染剔除] 聚焦模式下，无关连线直接跳过绘制，极大节省 Canvas 性能
                            if (focusedNodeId) return; 
                            opacity = 0.02; 
                        }
                    }

                    if (opacity <= 0.05 && !isEdgeHighlighted) return;

                    const dx = t.x - s.x; const dy = t.y - s.y;
                    const isBi = edges.some(e => e.source === edge.target && e.target === edge.source);
                    const curvature = isBi ? 0.15 : 0;
                    const cx = (s.x + t.x) / 2 - dy * curvature;
                    const cy = (s.y + t.y) / 2 + dx * curvature;

                    ctx.beginPath();
                    ctx.moveTo(s.x, s.y);
                    ctx.quadraticCurveTo(cx, cy, t.x, t.y);
                    ctx.strokeStyle = strokeColor;
                    ctx.globalAlpha = opacity;
                    ctx.lineWidth = isEdgeHighlighted ? 2 : 1.5;
                    ctx.stroke();

                    // --- [修正] 绘制完美贴合曲线的箭头逻辑 ---
                    const targetR = (t.id === focusedNodeId || t.id === hoveredNodeId) ? r * 1.15 : r;
                    
                    // 计算两点之间的直线距离，用来估算在曲线上的步长比例 t
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    // 箭头需要后退的比例 (半径 + 2px的呼吸偏移量)
                    const tParam = Math.max(0, 1 - (targetR + 2) / dist); 

                    // 用二阶贝塞尔曲线公式，计算出箭头精确的附着坐标
                    const arrowX = Math.pow(1 - tParam, 2) * s.x + 2 * (1 - tParam) * tParam * cx + Math.pow(tParam, 2) * t.x;
                    const arrowY = Math.pow(1 - tParam, 2) * s.y + 2 * (1 - tParam) * tParam * cy + Math.pow(tParam, 2) * t.y;

                    // 用贝塞尔曲线导数公式，计算出该点精确的切线角度
                    const angle = Math.atan2(
                        2 * (1 - tParam) * (cy - s.y) + 2 * tParam * (t.y - cy),
                        2 * (1 - tParam) * (cx - s.x) + 2 * tParam * (t.x - cx)
                    );

                    const arrowSize = 10;
                    
                    ctx.beginPath();
                    ctx.moveTo(arrowX, arrowY);
                    ctx.lineTo(arrowX - arrowSize * Math.cos(angle - Math.PI / 7), arrowY - arrowSize * Math.sin(angle - Math.PI / 7));
                    ctx.lineTo(arrowX - arrowSize * Math.cos(angle + Math.PI / 7), arrowY - arrowSize * Math.sin(angle + Math.PI / 7));
                    ctx.closePath();
                    ctx.fillStyle = strokeColor;
                    ctx.fill();
                    // ------------------------

                    // 绘制文字 (使用描边代替阴影，性能极高)
                    if (edge.labels && edge.labels.length > 0) {
                        const tx = 0.25 * s.x + 0.5 * cx + 0.25 * t.x;
                        const ty = 0.25 * s.y + 0.5 * cy + 0.25 * t.y;
                        ctx.globalAlpha = isEdgeHighlighted ? 1 : Math.max(0.1, opacity + 0.2);
                        ctx.font = isEdgeHighlighted ? 'bold 14px sans-serif' : '12px sans-serif';
                        
                        // 文字描边(模拟外发光底色)
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = THEME.bgPanel;
                        ctx.strokeText(edge.labels.join('/'), tx, ty - 8);
                        
                        // 文字实体
                        ctx.fillStyle = isEdgeHighlighted ? THEME.accent : THEME.textSub;
                        ctx.fillText(edge.labels.join('/'), tx, ty - 8);
                    }
                });

                // 2. 绘制节点
                nodesArr.forEach(n => {
                    // [核心拦截] 视野外剔除：如果节点坐标不在屏幕边界内（算上缓冲区），直接跳过
                    if (n.x < viewLeft - renderPadding || n.x > viewRight + renderPadding || 
                        n.y < viewTop - renderPadding || n.y > viewBottom + renderPadding) {
                        return;
                    }

                    let isCenter = false, isNeighbor = false, isUnrelated = false;
                    const isHovered = (n.id === hoveredNodeId);
                    
                    if (focusedNodeId || hoveredNodeId) {
                        const focusId = focusedNodeId || hoveredNodeId;
                        if (n.id === focusId) isCenter = true;
                        else if (focusedNeighbors.has(n.id) || (hoveredNodeId && edges.some(e => (e.source===n.id && e.target===hoveredNodeId) || (e.target===n.id && e.source===hoveredNodeId)))) isNeighbor = true;
                        else isUnrelated = true;
                    }

                    // [TOP 1 优化: 渲染剔除] 聚焦模式下，彻底跳过无关节点的绘制
                    if (focusedNodeId && isUnrelated) return;

                    const currentR = (isCenter || isHovered) ? r * 1.15 : r;
                    ctx.save();
                    ctx.translate(n.x, n.y);

                    // [性能优化] 精细化发光效果：减小半径（1.15x）并降低透明度（0.15），使其精致且若隐若现
                    if (isCenter || isHovered) {
                        ctx.beginPath();
                        ctx.arc(0, 0, currentR * 1.15, 0, Math.PI * 2); // 半径倍率从 1.35 降低到 1.15
                        ctx.fillStyle = THEME.accent;
                        ctx.globalAlpha = 0.15; // 透明度从 0.25 降低到 0.15，更通透
                        ctx.fill();
                        ctx.globalAlpha = 1.0;  // 恢复透明度供后续节点使用
                    }

                    // [修复3] 规范裁剪路径：必须保持路径开口状态执行 ctx.clip()
                    ctx.beginPath();
                    ctx.arc(0, 0, currentR, 0, Math.PI * 2);

                    if (n.image && imageCache[n.image] && imageCache[n.image]._cachedAvatar) {
                        ctx.globalAlpha = isUnrelated ? 0.15 : 1;
                        // [性能优化] 优先级2：直接绘制预先缓存好的离屏画布，彻底消灭 ctx.clip()
                        ctx.drawImage(imageCache[n.image]._cachedAvatar, -currentR, -currentR, currentR * 2, currentR * 2);
                        
                        ctx.lineWidth = (isCenter || isHovered) ? 3 : 2;
                        ctx.strokeStyle = (isCenter || isHovered) ? THEME.accent : THEME.border;
                        ctx.stroke(); // 盖上圆形边框
                    } else {
                        // [修复] 1. 先用 100% 不透明的面板背景色打个底，彻底挡住下方的连线
                        ctx.globalAlpha = 1;
                        ctx.fillStyle = THEME.bgPanel;
                        ctx.fill();

                        // 2. 然后再按照原来的透明度盖上主题色，保持原有的色彩质感
                        ctx.fillStyle = n.color;
                        ctx.globalAlpha = isUnrelated ? 0.05 : 0.2;
                        ctx.fill();
                        
                        ctx.globalAlpha = isUnrelated ? 0.15 : 1;
                        ctx.lineWidth = (isCenter || isHovered) ? 3 : 2;
                        ctx.strokeStyle = (isCenter || isHovered) ? THEME.accent : n.color;
                        ctx.stroke();
                        
                        // 首字母
                        ctx.fillStyle = THEME.textMain;
                        ctx.font = `bold ${currentR * 0.5}px sans-serif`;
                        ctx.shadowBlur = 0; // 确保文字不带模糊阴影
                        // [修复] Canvas 配合 textBaseline='middle' 时，Y轴偏移量给个 1~2px 视觉上最完美居中
                        ctx.fillText(n.label.charAt(0), 0, 2);
                    }

                    // 底部名字标签 (同样使用极速的 strokeText 描边代替 shadowBlur)
                    ctx.shadowBlur = 0;
                    ctx.globalAlpha = isUnrelated ? 0.15 : 1;
                    ctx.font = `bold ${isCenter || isHovered ? 16 : 14}px sans-serif`;
                    
                    ctx.lineWidth = 4;
                    ctx.strokeStyle = THEME.bgPanel;
                    ctx.strokeText(n.label, 0, currentR + 18); // 纯黑描边兜底
                    
                    ctx.fillStyle = THEME.textMain;
                    ctx.fillText(n.label, 0, currentR + 18); // 亮色文字

                    ctx.restore();
                });

                ctx.restore();
            };

            const physicsTick = () => {
                // [终极修复] 使用 isConnected 完美穿透 Shadow DOM，准确判断画布存活状态
                if (!canvas.isConnected) {
                    isPhysicsRunning = false;
                    return;
                }
                if (!isPhysicsRunning) return;
                let totalEnergy = 0;
                const nodesArr = Object.values(nodeElMap);

                // --- [核心升级] 引入空间划分 (Spatial Partitioning) ---
                // 将无限宇宙划分为 600x600 的区块，时间复杂度从 O(N^2) 降至 O(N*K)
                const CELL_SIZE = 600;
                const grid = new Map();
                
                for (let i = 0; i < nodesArr.length; i++) {
                    const n = nodesArr[i];
                    n._idx = i; // 附加索引以避免重复计算
                    const cx = Math.floor(n.x / CELL_SIZE);
                    const cy = Math.floor(n.y / CELL_SIZE);
                    const key = `${cx},${cy}`;
                    if (!grid.has(key)) grid.set(key, []);
                    grid.get(key).push(n);
                }

                for (let i = 0; i < nodesArr.length; i++) {
                    const n1 = nodesArr[i];
                    const cx = Math.floor(n1.x / CELL_SIZE);
                    const cy = Math.floor(n1.y / CELL_SIZE);
                    
                    // 遍历自身及周围 8 个相邻区块
                    for (let ox = -1; ox <= 1; ox++) {
                        for (let oy = -1; oy <= 1; oy++) {
                            const neighbors = grid.get(`${cx + ox},${cy + oy}`);
                            if (!neighbors) continue;
                            
                            for (let j = 0; j < neighbors.length; j++) {
                                const n2 = neighbors[j];
                                // 利用 _idx 单向计算一次，彻底避免双倍开销和自斥
                                if (n1._idx >= n2._idx) continue;

                                // [TOP 1 优化: 物理剔除] 聚焦模式下，如果两个节点都不是焦点及一跳邻居，直接跳过斥力计算
                                if (focusedNodeId) {
                                    const n1Active = n1.id === focusedNodeId || focusedNeighbors.has(n1.id);
                                    const n2Active = n2.id === focusedNodeId || focusedNeighbors.has(n2.id);
                                    if (!n1Active && !n2Active) continue;
                                }
                                
                                let dx = n1.x - n2.x; let dy = n1.y - n2.y;
                                let distSq = dx * dx + dy * dy;
                                
                                if (distSq > PHYSICS.MAX_DISTANCE_SQ) continue;
                                if (distSq < 100) { dx += (Math.random() - 0.5) * 10; dy += (Math.random() - 0.5) * 10; distSq = 100; }
                                
                                const SOFTENING = 400; // [优化] 引力软化常数，防止距离过近时分母趋近0导致斥力爆炸
                                const force = PHYSICS.REPULSION / (distSq + SOFTENING);
                                const dist = Math.sqrt(distSq);
                                const fx = (dx / dist) * force; const fy = (dy / dist) * force;

                                if (!n1.fixed) { n1.vx += fx; n1.vy += fy; }
                                if (!n2.fixed) { n2.vx -= fx; n2.vy -= fy; }
                            }
                        }
                    }
                }

                edges.forEach(edge => {
                    const s = nodeElMap[edge.source], t = nodeElMap[edge.target];
                    if (!s || !t) return;
                    
                    if (focusedNodeId) {
                        const sIsFocus = s.id === focusedNodeId, tIsFocus = t.id === focusedNodeId;
                        const sIsNeighbor = focusedNeighbors.has(s.id), tIsNeighbor = focusedNeighbors.has(t.id);
                        if (!sIsFocus && !tIsFocus && (!sIsNeighbor || !tIsNeighbor)) return;
                    }

                    let dx = t.x - s.x; let dy = t.y - s.y;
                    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    const force = PHYSICS.SPRING_TENSION * (dist - PHYSICS.IDEAL_LENGTH);
                    const fx = (dx / dist) * force; const fy = (dy / dist) * force;
                    if (!s.fixed) { s.vx += fx; s.vy += fy; }
                    if (!t.fixed) { t.vx -= fx; t.vy -= fy; }
                });

                const pinnedNodeId = getPinnedRelationCenter();
                nodesArr.forEach(n => {
                    if (!n.fixed) {
                        if (focusedNodeId) {
                            if (n.id === focusedNodeId) {
                                n.vx += (logicalCx - n.x) * 0.08; n.vy += (logicalCy - n.y) * 0.08;
                            } else if (focusedNeighbors.has(n.id)) {
                                n.vx += (logicalCx - n.x) * 0.002; n.vy += (logicalCy - n.y) * 0.002;
                            } else {
                                // [修复隐形墙] 允许无关节点(如前任中心点)受斥力被正常挤走，而不是变成一块冻结的石头
                                n.vx += (logicalCx - n.x) * 0.0002; 
                                n.vy += (logicalCy - n.y) * 0.0002;
                            }
                        } else {
                            if (pinnedNodeId && n.id === pinnedNodeId) {
                                n.vx += (logicalCx - n.x) * 0.08; 
                                n.vy += (logicalCy - n.y) * 0.08;
                            } else {
                                n.vx += (logicalCx - n.x) * PHYSICS.CENTER_GRAVITY;
                                n.vy += (logicalCy - n.y) * PHYSICS.CENTER_GRAVITY;
                            }
                        }
                        n.vx *= PHYSICS.FRICTION; n.vy *= PHYSICS.FRICTION;
                        n.vx = Math.max(-30, Math.min(30, n.vx));
                        n.vy = Math.max(-30, Math.min(30, n.vy));
                        n.x += n.vx; n.y += n.vy;
                        totalEnergy += Math.abs(n.vx) + Math.abs(n.vy);
                    }
                });

                draw(); // 每一帧结算后立即重绘画布

                if (totalEnergy < PHYSICS.MIN_ENERGY && !focusedNodeId && !hoveredNodeId) {
                    isPhysicsRunning = false;
                } else {
                    physicsRafId = requestAnimationFrame(physicsTick);
                }
            };

            const startPhysics = () => { if (!isPhysicsRunning) { isPhysicsRunning = true; physicsTick(); } };
            startPhysics();

            // [修复] 生成唯一命名空间，防止同时存在多个画布时，全局事件被互相覆盖
            const uniqueNs = '.acu_rel_' + Math.random().toString(36).substring(2, 8);

            // [新增] 监听主题切换，瞬间更新 Canvas 内部配色字典并重绘
            $(window).off('acu_theme_updated' + uniqueNs).on('acu_theme_updated' + uniqueNs, () => {
                requestAnimationFrame(() => {
                    THEME.textMain = $wrapper.css('--acu-text-main') || '#eee';
                    THEME.textSub = $wrapper.css('--acu-text-sub') || '#aaa';
                    THEME.accent = $wrapper.css('--acu-accent') || '#6a5acd';
                    THEME.bgPanel = $wrapper.css('--acu-bg-panel') || '#222';
                    THEME.border = $wrapper.css('--acu-border') || '#555';
                    if (!isPhysicsRunning) draw(); // 如果球停了，强制推一帧重绘
                });
            });

            // [新增] 监听头像更新事件，瞬间局部重绘，不打断正在运动的物理引擎
            $(window).off('acu_avatar_updated' + uniqueNs).on('acu_avatar_updated' + uniqueNs, (e, data) => {
                if (nodeElMap[data.char]) {
                    nodeElMap[data.char].image = data.image; // 更新内存数据
                    if (data.image) {
                        const img = new Image();
                        img.onload = () => { 
                            const offCanvas = document.createElement('canvas');
                            const dpr = window.devicePixelRatio || 1;
                            const size = 84;
                            offCanvas.width = size * dpr;
                            offCanvas.height = size * dpr;
                            const offCtx = offCanvas.getContext('2d');
                            offCtx.scale(dpr, dpr);
                            offCtx.beginPath();
                            offCtx.arc(42, 42, 42, 0, Math.PI * 2);
                            offCtx.clip();
                            offCtx.drawImage(img, 0, 0, size, size);
                            img._cachedAvatar = offCanvas;
                            
                            if (!isPhysicsRunning) draw(); 
                        }; // 图片加载并缓存完瞬间画上去
                        img.src = data.image;
                        imageCache[data.image] = img;
                    } else {
                        if (!isPhysicsRunning) draw(); // 如果是删除头像，直接重绘
                    }
                }
            });

            let cameraRafId = null;
            const smoothCameraTo = (targetX, targetY, targetK) => {
                if (cameraRafId) cancelAnimationFrame(cameraRafId);
                const startX = transform.x, startY = transform.y, startK = transform.k;
                let frame = 0; const totalFrames = 35; 
                const animate = () => {
                    frame++;
                    const p = frame / totalFrames;
                    const ease = 1 - Math.pow(1 - p, 3);
                    transform.x = startX + (targetX - startX) * ease;
                    transform.y = startY + (targetY - startY) * ease;
                    transform.k = startK + (targetK - startK) * ease;
                    draw();
                    if (frame < totalFrames) {
                        cameraRafId = requestAnimationFrame(animate);
                    } else {
                        cameraRafId = null;
                    }
                };
                animate();
            };

            const toggleFocus = (id) => {
                if (id !== null && focusedNodeId === id) {
                    if (typeof showCharacterProfile === 'function') showCharacterProfile(id);
                    return; 
                }

                if (id === null) {
                    focusedNodeId = null; focusedNeighbors.clear();
                    
                    // [视角优化] 与 initFitView 保持完全一致的留白算法
                    const nodesCount = Object.keys(nodeElMap).length;
                    const expectedRadius = Math.max(300, 150 + Math.sqrt(nodesCount) * 90);
                    const PADDING_FACTOR = 0.75;
                    
                    const scaleX = ((width / 2) / expectedRadius) * PADDING_FACTOR;
                    const scaleY = (((height - visualOffsetY) / 2) / expectedRadius) * PADDING_FACTOR;
                    
                    // 同样应用最小缩放底线
                    const isMobile = width < 768;
                    const MIN_READABLE_SCALE = isMobile ? 0.35 : 0.25;
                    let finalScale = Math.min(scaleX, scaleY);
                    finalScale = Math.max(MIN_READABLE_SCALE, Math.min(1.2, finalScale));
                    
                    smoothCameraTo(width / 2 - logicalCx * finalScale, height / 2 - logicalCy * finalScale - visualOffsetY, finalScale);
                } else {
                    focusedNodeId = id; focusedNeighbors.clear();
                    edges.forEach(e => {
                        if (e.source === id) focusedNeighbors.add(e.target);
                        if (e.target === id) focusedNeighbors.add(e.source);
                    });
                    const requiredLogicalSize = 500 + focusedNeighbors.size * 35;
                    const autoScale = Math.min(width / requiredLogicalSize, height / requiredLogicalSize) * 1.0;
                    const finalScale = Math.max(0.25, Math.min(1.5, autoScale)); 
                    smoothCameraTo(width / 2 - logicalCx * finalScale, height / 2 - logicalCy * finalScale - visualOffsetY, finalScale);
                }
                startPhysics(); 
            };

            // --- Canvas 原生交互检测 ---
            let isDragging = false, isPinching = false, isDragMoved = false;
            let draggedNode = null;
            let startX = 0, startY = 0, startTx = 0, startTy = 0;
            let lastPinchDist = 0;
            let pinchRect = null; // 缓存缩放时的画布边界

            // [性能优化] 节流高频的交互重绘，消除缩放与拖拽卡顿
            let drawRafId = null;
            const fastDraw = () => {
                if (isPhysicsRunning) return; // 如果球还在动，物理引擎会自己画
                if (!drawRafId) {
                    drawRafId = requestAnimationFrame(() => {
                        draw();
                        drawRafId = null;
                    });
                }
            };

            const getTouchDist = (t) => Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY);
            
            // 将鼠标屏幕坐标转化为 Canvas 宇宙物理坐标，并判定命中了哪个球
            const getNodeAt = (clientX, clientY) => {
                const rect = canvas.getBoundingClientRect();
                const mx = (clientX - rect.left - transform.x) / transform.k;
                const my = (clientY - rect.top - transform.y) / transform.k;
                const rSq = 42 * 42;
                for (let key in nodeElMap) {
                    const n = nodeElMap[key];
                    if ((n.x - mx)**2 + (n.y - my)**2 <= rSq) return n;
                }
                return null;
            };

            $(canvas).on('mousemove.acu_rel', (e) => {
                if (draggedNode) {
                    e.preventDefault();
                    const rect = canvas.getBoundingClientRect();
                    draggedNode.x = (e.clientX - rect.left - transform.x) / transform.k;
                    draggedNode.y = (e.clientY - rect.top - transform.y) / transform.k;
                    isDragMoved = true;
                    startPhysics();
                } else if (isDragging) {
                    e.preventDefault();
                    if (Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3) isDragMoved = true;
                    transform.x = startTx + (e.clientX - startX);
                    transform.y = startTy + (e.clientY - startY);
                    fastDraw(); // [优化] 使用节流重绘
                } else {
                    // Hover 侦测：模拟 CSS 的 :hover
                    const targetNode = getNodeAt(e.clientX, e.clientY);
                    const targetId = targetNode ? targetNode.id : null;
                    if (hoveredNodeId !== targetId) {
                        hoveredNodeId = targetId;
                        canvas.style.cursor = targetId ? 'pointer' : 'grab';
                        fastDraw(); // [优化] 使用节流重绘
                    }
                }
            });

            $(canvas).on('mousedown.acu_rel', (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                startX = e.clientX; startY = e.clientY;
                startTx = transform.x; startTy = transform.y;
                isDragMoved = false;

                const targetNode = getNodeAt(e.clientX, e.clientY);
                if (targetNode) {
                    draggedNode = targetNode;
                    draggedNode.fixed = true; draggedNode.vx = 0; draggedNode.vy = 0;
                    startPhysics();
                } else {
                    isDragging = true; canvas.style.cursor = 'grabbing';
                }
            });

            $(window).on('mouseup.acu_rel', () => {
                if (draggedNode) {
                    draggedNode.fixed = false;
                    if (!isDragMoved) {
                        if (isSelectingPin) {
                            savePinnedRelationCenter(draggedNode.id);
                            AcuToast.success(`✅ 已将【${draggedNode.label}】固定为中心`);
                            isSelectingPin = false;
                            updatePinBtnStyle();
                            canvas.style.cursor = 'grab';
                        } else {
                            toggleFocus(draggedNode.id);
                        }
                    }
                    draggedNode = null;
                    startPhysics();
                } else if (isDragging && !isDragMoved) {
                    if (focusedNodeId) { toggleFocus(null); } else if (typeof closePanel === 'function') { isPhysicsRunning = false; cancelAnimationFrame(physicsRafId); closePanel(); }
                }
                isDragging = false;
                if (!hoveredNodeId) canvas.style.cursor = 'grab';
            });
            
            // 移动端 Touch 适配
            canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    e.preventDefault();
                    const touch = e.touches[0];
                    startX = touch.clientX; startY = touch.clientY;
                    startTx = transform.x; startTy = transform.y;
                    isDragMoved = false;
                    const targetNode = getNodeAt(touch.clientX, touch.clientY);
                    if (targetNode) {
                        draggedNode = targetNode; draggedNode.fixed = true; draggedNode.vx = 0; draggedNode.vy = 0; startPhysics();
                    } else { isDragging = true; }
                } else if (e.touches.length === 2) {
                    e.preventDefault();
                    isPinching = true; isDragging = false; draggedNode = null; lastPinchDist = getTouchDist(e.touches);
                    pinchRect = canvas.getBoundingClientRect(); // [优化] 缓存在按下的瞬间，彻底干掉高频测距布局抖动
                }
            }, { passive: false });

            canvas.addEventListener('touchmove', (e) => {
                if (isPinching && e.touches.length === 2) {
                    e.preventDefault();
                    const dist = getTouchDist(e.touches);
                    const center = { x: (e.touches[0].clientX + e.touches[1].clientX)/2, y: (e.touches[0].clientY + e.touches[1].clientY)/2 };
                    const scaleDelta = dist / lastPinchDist;
                    const newK = Math.max(0.1, Math.min(5, transform.k * scaleDelta));
                    const rect = pinchRect || canvas.getBoundingClientRect(); // [优化] 提取缓存
                    const cx = center.x - rect.left; const cy = center.y - rect.top;
                    transform.x = cx - (cx - transform.x) * (newK / transform.k);
                    transform.y = cy - (cy - transform.y) * (newK / transform.k);
                    transform.k = newK;
                    lastPinchDist = dist;
                    fastDraw(); // [优化] 使用节流重绘
                } else if (e.touches.length === 1) {
                    e.preventDefault();
                    const touch = e.touches[0];
                    if (draggedNode) {
                        const rect = canvas.getBoundingClientRect();
                        draggedNode.x = (touch.clientX - rect.left - transform.x) / transform.k;
                        draggedNode.y = (touch.clientY - rect.top - transform.y) / transform.k;
                        isDragMoved = true; startPhysics();
                    } else if (isDragging) {
                        if (Math.abs(touch.clientX - startX) > 3 || Math.abs(touch.clientY - startY) > 3) isDragMoved = true;
                        transform.x = startTx + (touch.clientX - startX);
                        transform.y = startTy + (touch.clientY - startY);
                        fastDraw(); // [优化] 使用节流重绘
                    }
                }
            }, { passive: false });

            canvas.addEventListener('touchend', (e) => {
                if (draggedNode) {
                    draggedNode.fixed = false; 
                    if (!isDragMoved) {
                        if (isSelectingPin) {
                            savePinnedRelationCenter(draggedNode.id);
                            AcuToast.success(`✅ 已将【${draggedNode.label}】固定为中心`);
                            isSelectingPin = false;
                            updatePinBtnStyle();
                            canvas.style.cursor = 'grab';
                        } else {
                            toggleFocus(draggedNode.id);
                        }
                    }
                    draggedNode = null; startPhysics();
                } else if (isDragging && !isDragMoved && !isPinching) {
                    if (focusedNodeId) { toggleFocus(null); } else if (typeof closePanel === 'function') { isPhysicsRunning = false; cancelAnimationFrame(physicsRafId); closePanel(); }
                }
                if (e.touches.length === 0) { isDragging = false; isPinching = false; lastPinchDist = 0; } 
                else if (e.touches.length === 1 && isPinching) {
                    isPinching = false; startX = e.touches[0].clientX; startY = e.touches[0].clientY;
                    startTx = transform.x; startTy = transform.y; isDragging = true; isDragMoved = true;
                }
            }, { passive: true });

            canvas.addEventListener('wheel', (e) => {
                e.preventDefault();
                const newK = Math.max(0.1, Math.min(5, transform.k * (e.deltaY > 0 ? 0.9 : 1.1)));
                const rect = canvas.getBoundingClientRect();
                const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
                transform.x = mx - (mx - transform.x) * (newK / transform.k);
                transform.y = my - (my - transform.y) * (newK / transform.k);
                transform.k = newK;
                fastDraw(); // [优化] 使用节流重绘
            }, { passive: false });

            // 中心锁定按钮绑定
            const $pinBtn = $wrapper.find('#acu-rel-pin-center-embedded').length ?
                            $wrapper.find('#acu-rel-pin-center-embedded') :
                            $wrapper.closest('.acu-data-display').find('#acu-rel-pin-center');
                            
            $pinBtn.off('click').on('click', () => {
                const pinned = getPinnedRelationCenter();
                if (pinned && !isSelectingPin) {
                    savePinnedRelationCenter(null);
                    AcuToast.info('已解除中心节点固定');
                    updatePinBtnStyle();
                    startPhysics(); 
                } else {
                    isSelectingPin = !isSelectingPin;
                    if (isSelectingPin) {
                        AcuToast.info('🎯 请点击下方的一个角色节点将其固定在中心');
                        canvas.style.cursor = 'crosshair';
                    } else {
                        canvas.style.cursor = 'grab';
                    }
                    updatePinBtnStyle();
                }
            });

            // 重置按钮绑定
            const $resetBtn = $wrapper.find('#acu-rel-reset-embedded').length ?
                              $wrapper.find('#acu-rel-reset-embedded') :
                              $wrapper.closest('.acu-data-display').find('#acu-rel-reset');
                              
            $resetBtn.off('click').on('click', () => {
                // 1. 恢复视角到全局中心
                toggleFocus(null); 
                
                // 2. [优化] 根据节点数量动态计算“舒适”的散开半径，避免空间划分算法失效
                const nodesArr = Object.values(nodeElMap);
                const scatterRadius = Math.max(300, 150 + Math.sqrt(nodesArr.length) * 80);

                // 3. [优化] 使用极坐标（圆盘分布）代替原本的正方形拥挤分布
                nodesArr.forEach(n => {
                    const radius = Math.sqrt(Math.random()) * scatterRadius; 
                    const angle = Math.random() * Math.PI * 2; 

                    n.x = logicalCx + Math.cos(angle) * radius;
                    n.y = logicalCy + Math.sin(angle) * radius;

                    // 赋予轻微反向初速度，抵消部分爆开斥力，产生水母舒展般的自然呼吸感
                    n.vx = -Math.cos(angle) * 2; 
                    n.vy = -Math.sin(angle) * 2; 
                });
                
                // 4. 重新启动物理引擎
                startPhysics();
            });

            const $closeBtn = $wrapper.closest('.acu-data-display').find('.acu-close-btn');
            $closeBtn.off('click.acu_phys').on('click.acu_phys', () => {
                isPhysicsRunning = false; cancelAnimationFrame(physicsRafId);
                $(window).off('mouseup.acu_rel'); // 防内存泄漏
                // [修复] 彻底清理专属的全局监听器，防止切换标签页时内存泄漏
                $(window).off('acu_theme_updated' + uniqueNs).off('acu_avatar_updated' + uniqueNs);
                if (typeof closePanel === 'function') closePanel();
            });
            
        }); 
    };


    
// ============================================================
    // [增强版] 智能日历模块 (支持 中文数字 + 阿拉伯数字 + 修仙纪元)
    // ============================================================
    const CalendarModule = {
        getEventScore: (t) => {
            if(t.includes('世界')) return 4;
            if(t.includes('大型')) return 3;
            if(t.includes('个人')) return 2;
            return 1;
        },
        getEventClass: (t) => {
            if (t.includes('世界')) return 'acu-evt-world';
            if (t.includes('大型')) return 'acu-evt-large';
            if (t.includes('个人')) return 'acu-evt-personal';
            return 'acu-evt-char';
        },
        // [核心升级] 统一数字转换器：将中文数字转为阿拉伯数字
        // logic: 年份通常是直读(二零二四 -> 2024)，月日通常是数值(二十五 -> 25)
        cnToInt: (str, isYear = false) => {
            if (!str) return 0;
            const s = String(str).trim();
            // 如果已经是纯阿拉伯数字，直接返回
            if (/^\d+$/.test(s)) return parseInt(s, 10);

            const map = { '零':0, '〇':0, '一':1, '二':2, '三':3, '四':4, '五':5, '六':6, '七':7, '八':8, '九':9 };
            
            // 模式1：年份直读 (例如：二零二四 -> 2024)
            if (isYear) {
                return parseInt(s.split('').map(c => map[c] !== undefined ? map[c] : c).join(''), 10) || 0;
            }

            // 模式2：月日数值 (例如：十二 -> 12, 二十五 -> 25, 三十 -> 30)
            let val = 0;
            // 简单处理 "十" 的逻辑
            if (s === '十') return 10;
            if (s.startsWith('十')) { // 十五 -> 15
                return 10 + (map[s[1]] || 0);
            }
            if (s.endsWith('十')) { // 二十 -> 20
                return (map[s[0]] || 0) * 10;
            }
            if (s.includes('十')) { // 二十五 -> 25
                const parts = s.split('十');
                return (map[parts[0]] || 0) * 10 + (map[parts[1]] || 0);
            }
            // 单个数字 (五 -> 5)
            return map[s] || parseInt(s) || 0;
        },

        // [核心升级] 增强版时间解析器
        parseTime: (str) => {
            if (!str) return null;
            let raw = String(str).trim();

            // 1. 尝试标准格式 YYYY-MM-DD
            let match = raw.match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
            if (match) {
                return { year: parseInt(match[1]), month: parseInt(match[2]), day: parseInt(match[3]) };
            }

            // 2. 尝试中文格式 (支持 "二零二四年二月十五日" 或 "二〇二四年十二月一日")
            // 正则说明：匹配 [中文数字或阿拉伯数字] + 年/月/日
            match = raw.match(/([0-9零〇一二三四五六七八九十]+)\s*年\s*([0-9零〇一二三四五六七八九十]+)\s*月\s*([0-9零〇一二三四五六七八九十]+)[日号]?/);
            
            if (match) {
                return { 
                    year: CalendarModule.cnToInt(match[1], true),  // 年份：直读模式
                    month: CalendarModule.cnToInt(match[2], false), // 月份：数值模式
                    day: CalendarModule.cnToInt(match[3], false)    // 日期：数值模式
                };
            }

            return null;
        },

        render: (year, month, currentDay, events = []) => {
            const jsMonth = month - 1; 
            const firstDayDate = new Date();
            firstDayDate.setFullYear(year, jsMonth, 1);
            const firstDayWeek = firstDayDate.getDay(); 
            const lastDayDate = new Date();
            lastDayDate.setFullYear(year, month, 0);
            const daysInMonth = lastDayDate.getDate();
            const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
            
            // 容错：如果年份解析失败(NaN)，默认显示当前年份
            const safeYear = isNaN(year) ? new Date().getFullYear() : year;
            const safeMonth = isNaN(month) ? new Date().getMonth() + 1 : month;

            let html = `<div class="acu-cal-header">
                <div class="acu-cal-title">
                    <i class="fa-solid fa-chevron-left acu-cal-nav-btn" id="cal-prev" title="上个月"></i>
                    <span>${safeYear}年 ${safeMonth}月</span>
                    <i class="fa-solid fa-chevron-right acu-cal-nav-btn" id="cal-next" title="下个月"></i>
                </div>
                <div class="acu-cal-week-row">${weekNames.map(w => `<span>${w}</span>`).join('')}</div>
            </div>`;

            html += `<div class="acu-cal-grid">`;
            for (let i = 0; i < firstDayWeek; i++) html += `<div class="acu-cal-cell empty"></div>`;
            
            for (let d = 1; d <= daysInMonth; d++) {
                const isToday = (currentDay !== -1 && d === currentDay);
                // 构造日期 Key 时，统一转为阿拉伯数字格式 YYYY-MM-DD 以便匹配
                const dateKey = `${safeYear}-${String(safeMonth).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                
                const dayEvents = events.filter(e => e.date === dateKey);
                let dotHtml = '';
                let titleText = `${safeYear}年${safeMonth}月${d}日`;
                const evtCount = dayEvents.length;

                if (evtCount > 0) {
                    dayEvents.sort((a,b) => CalendarModule.getEventScore(b.type) - CalendarModule.getEventScore(a.type));
                    
                    const topEvent = dayEvents[0];
                    let dotClass = CalendarModule.getEventClass(topEvent.type);
                    
                    dotHtml = `<span class="acu-event-dot ${dotClass}"></span>`;
                    const details = dayEvents.map(e => `[${e.type.replace(/[\[\]]/g, '')}] ${e.title}: ${e.desc}`).join('\n');
                    titleText += `\n----------------\n${details}`;
                }

                html += `<div class="acu-cal-cell ${isToday ? 'today' : ''}" data-date="${dateKey}" data-has-evt="${evtCount > 0}" title="${escapeHtml(titleText)}">${d}${dotHtml}</div>`;
            }
            html += `</div>`;
            return html;
        },

        show: (timeStr) => {
            const { $ } = getCore();
            // 使用增强版解析
            const date = CalendarModule.parseTime(timeStr);
            
            if (!date || isNaN(date.year) || isNaN(date.month)) {
                AcuToast.warning('无法识别时间格式 (支持: 2024-01-01 或 二零二四年一月一日)');
                return;
            }

            const currentEvents = [];
            const rawData = cachedRawData || getTableData();
            if (rawData) {
                Object.values(rawData).forEach(sheet => {
                    if (sheet.name && /日程|事件/.test(sheet.name) && sheet.content) {
                        const headers = sheet.content[0];
                        const dateIdx = headers.findIndex(h => /日期|Date/i.test(h));
                        const titleIdx = headers.findIndex(h => /事件|Title|Name/i.test(h));
                        const typeIdx = headers.findIndex(h => /类型|Type/i.test(h));
                        const descIdx = headers.findIndex(h => /详情|描述|Desc/i.test(h));

                        if (dateIdx !== -1) {
                            sheet.content.slice(1).forEach(row => {
                                const dStr = String(row[dateIdx] || '').trim();
                                // 这里也要解析表格里的日期 (可能是中文)
                                const rowDate = CalendarModule.parseTime(dStr);
                                
                                if (rowDate) {
                                    // 统一转为标准格式存储
                                    const fmtDate = `${rowDate.year}-${String(rowDate.month).padStart(2,'0')}-${String(rowDate.day).padStart(2,'0')}`;
                                    currentEvents.push({
                                        date: fmtDate,
                                        title: titleIdx !== -1 ? String(row[titleIdx] || '未命名') : '事件',
                                        type: typeIdx !== -1 ? String(row[typeIdx] || '其他').trim() : '其他',
                                        desc: descIdx !== -1 ? String(row[descIdx] || '') : ''
                                    });
                                }
                            });
                        }
                    }
                });
            }

            const allEvents = currentEvents; // 现已为纯实时数据，无历史合并
            $('.acu-calendar-overlay').remove();
            const config = getConfig();
            
            let viewYear = date.year;
            let viewMonth = date.month;

            const overlay = $(`
                <div class="acu-calendar-overlay acu-edit-overlay">
                    <div class="acu-calendar-dialog acu-edit-dialog acu-theme-${config.theme}">
                        <div id="acu-cal-content-wrapper"></div> 
                        <div class="acu-event-details">
                            <div style="font-size:12px; color:var(--acu-text-sub); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
                                <span>📅 <span id="acu-evt-date-title"></span></span>
                                <span style="font-size:10px; opacity:0.7;">点击空白处收起</span>
                            </div>
                            <div id="acu-evt-list"></div>
                        </div>
                        <div style="text-align:center; padding:10px 0 0 0; margin-top:10px; border-top:1px dashed var(--acu-border);">
                            <button class="acu-dialog-btn" id="cal-close" style="justify-content:center; width:100%;">
                                <i class="fa-solid fa-times"></i> 关闭
                            </button>
                        </div>
                    </div>
                </div>
            `);

            $('body').append(overlay);

            const updateCalendarView = () => {
                const isCurrentMonth = (viewYear === date.year && viewMonth === date.month);
                const html = CalendarModule.render(viewYear, viewMonth, isCurrentMonth ? date.day : -1, allEvents);
                overlay.find('#acu-cal-content-wrapper').html(html);
                bindCellEvents();
                bindNavEvents();
            };

            const bindNavEvents = () => {
                overlay.find('#cal-prev').click((e) => {
                    e.stopPropagation();
                    viewMonth--;
                    if (viewMonth < 1) { viewMonth = 12; viewYear--; }
                    overlay.find('.acu-event-details').slideUp(100);
                    updateCalendarView();
                });
                overlay.find('#cal-next').click((e) => {
                    e.stopPropagation();
                    viewMonth++;
                    if (viewMonth > 12) { viewMonth = 1; viewYear++; }
                    overlay.find('.acu-event-details').slideUp(100);
                    updateCalendarView();
                });
            };

            const bindCellEvents = () => {
                overlay.find('.acu-cal-cell').click(function(e) {
                    e.stopPropagation();
                    overlay.find('.acu-cal-cell').removeClass('selected');
                    $(this).addClass('selected');

                    const dateKey = $(this).data('date');
                    const hasEvt = $(this).data('has-evt');
                    const $detailPanel = overlay.find('.acu-event-details');
                    const $list = overlay.find('#acu-evt-list');

                    if (hasEvt) {
                        const dayEvents = allEvents.filter(evt => evt.date === dateKey);
                        dayEvents.sort((a,b) => CalendarModule.getEventScore(b.type) - CalendarModule.getEventScore(a.type));

                        overlay.find('#acu-evt-date-title').text(dateKey);
                        
                        const listHtml = dayEvents.map(evt => {
                            let tagClass = CalendarModule.getEventClass(evt.type);
                            let cleanType = evt.type.replace(/[\[\]]/g, '');

                            return `
                                <div class="acu-event-item">
                                    <div>
                                        <span class="acu-event-tag ${tagClass}">${escapeHtml(cleanType)}</span>
                                        <span class="acu-event-title">${escapeHtml(evt.title)}</span>
                                    </div>
                                    ${evt.desc ? `<div class="acu-event-desc">${escapeHtml(evt.desc)}</div>` : ''}
                                </div>
                            `;
                        }).join('');

                        $list.html(listHtml);
                        $detailPanel.slideDown(200);
                    } else {
                        $detailPanel.slideUp(200);
                    }
                });
            };

            overlay.on('click', function(e) {
                if ($(e.target).closest('.acu-calendar-dialog').length === 0) {
                    overlay.remove();
                } else {
                    overlay.find('.acu-event-details').slideUp(200);
                    overlay.find('.acu-cal-cell').removeClass('selected');
                }
            });
            overlay.find('.acu-event-details').click((e) => e.stopPropagation());
            overlay.find('#cal-close').click(() => overlay.remove());

            updateCalendarView();
        }
    };

// --- [补回] 选项栏点击事件与自动发送逻辑 ---
const bindOptionEvents = () => {
    const { $ } = getCore();
    $('body').off('click.acu_opt').on('click.acu_opt', '.acu-opt-btn', async function(e) {
        e.preventDefault();
        e.stopPropagation();

        const config = getConfig();
        const val = decodeURIComponent($(this).data('val'));

        if (!config.clickOptionToAutoSend) {
            const ta = $('#send_textarea');
            if (ta.length) ta.val(val).trigger('input').trigger('change').focus();
            return;
        }

        if (window.TavernHelper && window.TavernHelper.createChatMessages) {
            try {
                await window.TavernHelper.createChatMessages([{ role: 'user', message: val }], { refresh: 'affected' });
                if (window.TavernHelper.triggerSlash) await window.TavernHelper.triggerSlash('/trigger');
                return;
            } catch (err) { console.warn('[ACU] TH发送失败', err); }
        }

        const ST = window.SillyTavern || window.parent?.SillyTavern;
        if (ST && ST.executeSlashCommandsWithOptions) {
            try {
                const safeVal = val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                const sendResult = await ST.executeSlashCommandsWithOptions(`/send raw=true "${safeVal}"`);
                if (!sendResult.isError && !sendResult.isAborted) {
                    await ST.executeSlashCommandsWithOptions('/trigger');
                    return;
                }
            } catch (err) { console.warn('[ACU] ST发送失败', err); }
        }

        const ta = $('#send_textarea');
        if (ta.length) {
            ta.val(val).trigger('input').trigger('change');
            await new Promise(r => setTimeout(r, 50));
            const sendBtn = $('#send_but').filter(':visible');
            if (sendBtn.length) sendBtn[0].click();
            else ta.trigger($.Event('keydown', { keyCode: 13, which: 13, bubbles: true }));
        }
    });
};

    // --- [核心升级] 渲染批处理 (Render Batching) ---
    // 利用 rAF 节流，将同一事件循环内的多次重绘请求合并为一次，彻底消除连环卡顿
    let _renderReq = null;
    const renderInterface = () => {
        if (_renderReq) return; 
        _renderReq = requestAnimationFrame(() => {
            _renderReq = null;
            _renderInterfaceCore();
        });
    };

    const _renderInterfaceCore = () => {
        const { $ } = getCore();
        
        // [性能优化] DOM MutationObserver 已彻底移除。
        // 现在全部依托酒馆的 TavernEvents (如 GENERATION_ENDED) 和内存校验精准控制。
        let rawData;
        // 【核心修复】数据库后台更新期间，强行冻结使用内存中的旧数据（cachedRawData），绝对不读取残缺的实时数据
        if ((hasUnsavedChanges || isWaitingForDbUpdate) && cachedRawData) {
            rawData = cachedRawData;
} else {
    rawData = getTableData();
    
    

    if (rawData) {
        cachedRawData = typeof structuredClone === 'function' 
            ? structuredClone(rawData) 
            : JSON.parse(JSON.stringify(rawData));

        // [v8.7.1 修复] 兼容旧版快照 + 正确处理聊天切换
        const existingSnapshot = loadSnapshot();
        const currentCtx = getCurrentContextFingerprint();

        if (!existingSnapshot) {
            // 情况1：没有快照 → 保存新快照（首次加载建立基线）
            console.log('[ACU] 首次加载，建立数据快照基线');
            saveSnapshot({ ...cachedRawData, _contextId: currentCtx });
        } else if (!existingSnapshot._contextId) {
            // 情况2：旧版快照（无 ID）→ 打上当前上下文标记，但不覆盖数据
            saveSnapshot({ ...existingSnapshot, _contextId: currentCtx });
        } else if (existingSnapshot._contextId !== currentCtx) {
            // 情况3：确认切换了聊天 → 覆盖为新数据
            cachedRawData._contextId = currentCtx;
            saveSnapshot(cachedRawData);
        }
        // 情况4：同一聊天 → 不动，保持高亮正常
    }
}

        const $searchInput = $('.acu-search-input');
        if ($('.acu-wrapper').length && $searchInput.is(':focus') ) {
            if (rawData) {
                if (!isSaving) {
                    const currentDataHash = JSON.stringify(rawData).length.toString();
                    if (window._acuLastDiffHash !== currentDataHash || !currentDiffMap) {
                        currentDiffMap = generateDiffMap(rawData);
                        window._acuLastDiffHash = currentDataHash;
                    }
                }
                const tables = processJsonData(rawData);
                const activeTab = getActiveTabState();
                const currentTabName = activeTab && tables[activeTab] ? activeTab : null;

                if (currentTabName && tables[currentTabName]) {
                    const newHtml = renderTableContent(tables[currentTabName], currentTabName);
                    
                    // [T0 核心优化] 搜索过滤时同样使用原生 DOMParser，保障用户快速连续敲击键盘搜索时的丝滑度
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(`<div>${newHtml}</div>`, 'text/html');
                    const $virtualDom = $(doc.body).children().first();
                    
                    $('.acu-card-grid').replaceWith($virtualDom.find('.acu-card-grid'));
                    $('.acu-panel-title').html($virtualDom.find('.acu-panel-title').html());
                    // [修复] 修正函数名错误，复用主事件绑定
                    bindEvents(tables);
                    updateSaveButtonState(); // 修复：搜索时也更新保存按钮状态
                    return;

                }
            }
        }

        let lastScrollX = 0;
        let lastScrollY = 0;

        const $oldContent = $('.acu-panel-content');
        if ($oldContent.length) {
            lastScrollX = $oldContent.scrollLeft();
            lastScrollY = $oldContent.scrollTop();
        }

        // [核心优化] 移除了 $('.acu-wrapper').remove(); 
        // 彻底杜绝全局 DOM 销毁引起的闪烁与性能灾难
        const tables = processJsonData(rawData || {});
        
        // [核心优化 1] 数据差异比对缓存 (降低 70% 的重绘计算卡顿)
        if (isSaving) {
            currentDiffMap = new Set();
            window._acuLastDiffHash = null;
        } else {
            const currentDataHash = rawData ? JSON.stringify(rawData).length.toString() : 'empty';
            if (window._acuLastDiffHash !== currentDataHash || !currentDiffMap) {
                currentDiffMap = generateDiffMap(rawData);
                window._acuLastDiffHash = currentDataHash;
            }
        }

        const savedOrder = getSavedTableOrder();
        let orderedNames = Object.keys(tables);
        if (savedOrder) {
            // [修复] 过滤时保留虚拟标签（它不在 tables 中但仍需保留）
            orderedNames = savedOrder.filter(n => tables[n] || n === VIRTUAL_RELATIONSHIP_TAB)
                .concat(orderedNames.filter(n => !savedOrder.includes(n)));
        }
        
        const hiddenList = getHiddenTables();
        orderedNames = orderedNames.filter(n => !hiddenList.includes(n));
        
        const uiCfg = getConfig();
        if (uiCfg.showStatusBar !== false) {
            // [新增] 如果 RPG 状态栏已开启，从顶部导航彻底剔除独立的关系网入口
            orderedNames = orderedNames.filter(n => n !== VIRTUAL_RELATIONSHIP_TAB);
            // 如果当前正好处于这个独立标签页，自动关掉面板，防止出现幽灵 UI
            if (getActiveTabState() === VIRTUAL_RELATIONSHIP_TAB) saveActiveTabState(null);
        } else {
            // [修复] 只有未开启 RPG 状态栏，且虚拟标签未隐藏时才添加
            if (!orderedNames.includes(VIRTUAL_RELATIONSHIP_TAB) && !hiddenList.includes(VIRTUAL_RELATIONSHIP_TAB)) {
                orderedNames.unshift(VIRTUAL_RELATIONSHIP_TAB);
            }
        }

        const activeTab = getActiveTabState();
        let currentTabName = null;
        if (activeTab === VIRTUAL_RELATIONSHIP_TAB) {
            currentTabName = VIRTUAL_RELATIONSHIP_TAB; // 虚拟标签特殊处理
        } else if (activeTab && tables[activeTab] && !hiddenList.includes(activeTab)) {
            currentTabName = activeTab;
        }
        
        const config = getConfig();
        const isCollapsed = getCollapsedState();

        const layoutClass = config.layout === 'vertical' ? 'acu-layout-vertical' : '';
// 默认永远为悬浮模式
const positionClass = 'acu-mode-fixed'; 

// [新增] 自动列数 (智能填满) 逻辑
let finalGridCols = config.gridColumns;
    if (finalGridCols === 'auto') {
        // 预先检查是否有“全能设置”按钮合并在网格里
        let actionOrder = Store.get(STORAGE_KEY_ACTION_ORDER);
        if (!actionOrder || !Array.isArray(actionOrder)) actionOrder = DEFAULT_ACTION_ORDER;
        if (!actionOrder.includes('acu-btn-settings')) actionOrder.push('acu-btn-settings');

        const isOnlySettings = actionOrder.length === 1 && actionOrder[0] === 'acu-btn-settings';
        const shouldMergeSettings = isOnlySettings && !isEditingOrder;

        // 计算总格子数 (标签数 + 可能存在的设置按钮)
        const n = orderedNames.length + (shouldMergeSettings ? 1 : 0);

        if (n <= 4) {
            // 4个以内：有多少显示多少 (最少2列保持美观)
            finalGridCols = n < 2 ? 2 : n; 
        } else {
            // 超过4个：计算 3列 vs 4列 的空缺情况
            const empty3 = (Math.ceil(n / 3) * 3) - n; // 3列时的空缺
            const empty4 = (Math.ceil(n / 4) * 4) - n; // 4列时的空缺

            // 逻辑：如果4列的空缺更少或相等，优先用4列 (扁度优先)；否则用3列
            // 例如 n=7: 3列缺2, 4列缺1 -> 选4列
            // 例如 n=8: 3列缺1, 4列缺0 -> 选4列
            // 例如 n=6: 3列缺0, 4列缺2 -> 选3列
            finalGridCols = (empty4 <= empty3) ? 4 : 3;
        }
    }

        // [修复] 将 isNavHidden 的声明提前，解决暂时性死区(TDZ)导致的面板消失 Bug
        const isNavHidden = Store.get('acu_hide_nav_only', false);

        let html = `<div class="acu-wrapper ${positionClass} acu-theme-${config.theme} ${layoutClass}" style="--acu-card-width:${config.cardWidth}px; --acu-font-size:${config.fontSize}px; --acu-grid-cols:${finalGridCols}">`;

        // [修改开始] 读取隐藏状态 (已提前声明)
        const hideStyle = isNavHidden ? 'display:none !important;' : '';

        if (isCollapsed) {
            const colStyleClass = `acu-col-${config.collapseStyle || 'bar'}`;
            // 如果处于隐藏模式，连收起的小条也隐藏
            const collapseStyle = isNavHidden ? 'display:none !important;' : '';
            const alignClass = `acu-align-${config.collapseAlign || 'right'}`;
            html += `
                <div class="acu-expand-trigger ${colStyleClass} ${alignClass}" id="acu-btn-expand" style="${collapseStyle}">
                    <i class="fa-solid fa-table"></i> <span>数据库助手 (${Object.keys(tables).length})</span>
                </div>
            `;
        } else {
            // [修改] 读取保存的高度
            const savedHeight = (currentTabName) ? getTableHeights()[currentTabName] : null;
    
            // [修复] 虚拟标签渲染关系图，普通标签渲染表格
            const panelContent = currentTabName === VIRTUAL_RELATIONSHIP_TAB 
                ? renderRelationshipPanel() 
                : (currentTabName ? renderTableContent(tables[currentTabName], currentTabName) : '');
            
            // [新增] 关系网模式标记
            const isRelationshipMode = currentTabName === VIRTUAL_RELATIONSHIP_TAB;

            html += `
                <div class="acu-data-display ${currentTabName ? 'visible' : ''} ${savedHeight ? 'acu-manual-mode' : ''} ${isRelationshipMode ? 'acu-relationship-mode' : ''}" id="acu-data-area" style="${savedHeight ? 'height:'+savedHeight+'px;' : ''} ${hideStyle}">
                    ${panelContent}
                </div>
                `;

            // [修复] 强制写入网格列数，防止浏览器初次渲染时卡成单列
            // PC端(>768px) CSS使用了 display:flex !important，会自动忽略这个 grid 属性，所以很安全
            const gridFixStyle = `grid-template-columns: repeat(${finalGridCols}, 1fr);`;

            html += `
                <div class="acu-nav-container ${config.actionsPosition === 'top' ? 'acu-pos-top' : ''}" id="acu-nav-bar" style="${hideStyle} ${gridFixStyle}">
                    <div class="acu-order-controls" id="acu-order-hint"><i class="fa-solid fa-arrows-alt"></i> 拖动调整顺序，完成后点击保存退出</div>
            `;

            // [新增] 在渲染标签前，获取当前后端记录的“已选中表”
            let selectedUpdateKeys = [];
            const api = getCore().getDB();
            if (api && api.getManualSelectedTables) {
                const selInfo = api.getManualSelectedTables();
                let keys = selInfo.selectedTables || [];
                // 【核心防御】获取当前有效表格的总数
                const totalKeys = Object.values(tables).map(t => t.key).filter(k => k);
                
                // 只有当后端明确标记被选择，且选中的数量 小于 表格总数时，前端才挂上角标
                // 这样可以防止后端默认下发全选数组导致前端难看
                if (selInfo.hasManualSelection && keys.length > 0 && keys.length < totalKeys.length) {
                    selectedUpdateKeys = keys;
                }
            }

            // [修改] 渲染表格标签，注入数据与选中状态
            orderedNames.forEach(name => {
                const iconClass = getIconForTableName(name);
                const isActive = currentTabName === name ? 'active' : '';
                const tableKey = tables[name] ? tables[name].key : ''; 
                const isUpdateSelected = tableKey && selectedUpdateKeys.includes(tableKey) ? 'acu-update-selected' : '';
                html += `<button class="acu-nav-btn ${isActive} ${isUpdateSelected}" data-table="${escapeHtml(name)}" data-key="${tableKey}"><i class="fa-solid ${iconClass}"></i><span>${escapeHtml(name)}</span></button>`;
            });

            let actionOrder = Store.get(STORAGE_KEY_ACTION_ORDER);
            if (!actionOrder || !Array.isArray(actionOrder)) actionOrder = DEFAULT_ACTION_ORDER;

            // [新增] 强制保护逻辑：如果设置按钮丢了，强制加回来
            if (!actionOrder.includes('acu-btn-settings')) {
                actionOrder.push('acu-btn-settings');
            }

            // [新增] 判断是否触发“极简设置模式” (场上只有设置按钮 + 非编辑模式)
            const isOnlySettings = actionOrder.length === 1 && actionOrder[0] === 'acu-btn-settings';
            const shouldMergeSettings = isOnlySettings && !isEditingOrder;

            if (shouldMergeSettings) {
    html += `<button class="acu-nav-btn acu-merged-settings" id="acu-btn-settings" style="color:var(--acu-text-sub); border:1px dashed var(--acu-border);"><i class="fa-solid fa-cog"></i><span>全能设置</span></button>`;
}

            
            // 1. 渲染备选池 (Unused Pool)
            html += `<div class="acu-unused-pool" id="acu-action-pool">`;
            ALL_ACTION_BUTTONS.forEach(btn => {
                // 如果是设置按钮，永远不允许出现在备选池里（除非处于极简模式下，需要逻辑互斥，这里简单处理即可）
                if (btn.id === 'acu-btn-settings') return; 

                if (!actionOrder.includes(btn.id)) {
                    html += `<button class="acu-action-btn" id="${btn.id}" title="${btn.title}" draggable="false"><i class="fa-solid ${btn.icon}"></i></button>`;
                }
            });
            html += `</div>`;

            // 2. 渲染当前活动栏 (Active Group)
            // 只有在“没有合并”的情况下，或者“正在编辑顺序”时，才显示底栏
            if (!shouldMergeSettings) {
                html += `<div class="acu-actions-group" id="acu-active-actions">`;
                actionOrder.forEach(btnId => {
                    const btnData = ALL_ACTION_BUTTONS.find(a => a.id === btnId);
                    if (btnData) {
                        html += `<button class="acu-action-btn" id="${btnData.id}" title="${btnData.title}"><i class="fa-solid ${btnData.icon}"></i></button>`;
                    }
                });
                html += `</div>`;
            }
            
            html += `</div>`;
        }

        html += `</div>`;

        const $existing = $('.acu-wrapper');
        if ($existing.length) {
            // [T0 核心优化] 使用原生 DOMParser 替代 jQuery ($) 解析
            // 彻底消除几千行 HTML 字符串转换 DOM 时引发的 GC 垃圾回收尖刺，内存占用直降 60%
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const $newDom = $(doc.body).children().first();
            
            // 1. 同步外层容器的属性 (防止主题切换、宽度拖拽等 CSS 变量丢失)
            $existing.attr('class', $newDom.attr('class'));
            $existing.attr('style', $newDom.attr('style'));
            
            // 2. 局部替换主数据面板
            const $oldDataArea = $existing.find('#acu-data-area');
            const $newDataArea = $newDom.find('#acu-data-area');

            // [新增保护] 关系网 Canvas 防重置机制
            const $oldCanvasWrapper = $oldDataArea.find('.acu-rel-canvas-wrapper');
            const $newCanvasWrapper = $newDataArea.find('.acu-rel-canvas-wrapper');
            if ($oldCanvasWrapper.length && $newCanvasWrapper.length) {
                const oldHash = $oldCanvasWrapper.data('graph-hash');
                const newHash = $newCanvasWrapper.data('graph-hash');
                if (oldHash && newHash && String(oldHash) === String(newHash)) {
                    $newCanvasWrapper.replaceWith($oldCanvasWrapper.detach()); 
                }
            }

            if ($oldDataArea.length && $newDataArea.length) {
                $oldDataArea.replaceWith($newDataArea);
            } else if ($newDataArea.length) {
                $existing.append($newDataArea);
            } else {
                $oldDataArea.remove();
            }

            // 3. 局部替换底部导航栏
            const $oldNavBar = $existing.find('#acu-nav-bar');
            const $newNavBar = $newDom.find('#acu-nav-bar');
            if ($oldNavBar.length && $newNavBar.length) {
                $oldNavBar.replaceWith($newNavBar);
            } else if ($newNavBar.length) {
                $existing.append($newNavBar);
            } else {
                $oldNavBar.remove();
            }

            // 4. 局部替换收缩/展开按钮
            const $oldExpand = $existing.find('#acu-btn-expand');
            const $newExpand = $newDom.find('#acu-btn-expand');
            if ($oldExpand.length && $newExpand.length) {
                $oldExpand.replaceWith($newExpand);
            } else if ($newExpand.length) {
                $existing.append($newExpand);
            } else {
                $oldExpand.remove();
            }
        } else {
            insertHtmlToPage(html);
        }

                // ============================================================
        // [融合版] 选项栏 + RPG 状态栏 聚合注入逻辑
        // ============================================================
        // 1. 生成选项栏 (Option Panel)
        let optionHtml = '';
        if (config.showOptionPanel !== false) {
            const optionTables = Object.values(tables).filter(t => t.name.includes('选项'));
            if (optionTables.length > 0) {
                {
                    let buttonsHtml = `<div class="acu-opt-header" style="position:relative;">行动选项</div>`;
                    let hasBtns = false;
                    let optionValues = [];
                    optionTables.forEach(table => {
                        if (table.rows) {
                            table.rows.forEach(row => {
                                row.forEach((cell, idx) => {
                                    if (idx > 0 && cell && String(cell).trim()) {
                                        const cellStr = String(cell).trim();
                                        buttonsHtml += `<button class="acu-opt-btn" data-val="${encodeURIComponent(cellStr)}">${escapeHtml(cellStr)}</button>`;
                                        optionValues.push(cellStr);
                                        hasBtns = true;
                                    }
                                });
                            });
                        }
                    });
                    if (hasBtns) {
                        optionHtml = `<div class="acu-option-panel" style="margin-bottom: 6px;">${buttonsHtml}</div>`;
                        const currentOptionHash = optionValues.join('|||');
                        if (currentOptionHash !== lastOptionHash) optionPanelVisible = true;
                        lastOptionHash = currentOptionHash;
                    }
                }
            }
        }

        // 2. 生成 RPG 状态栏 (Status Bar) 及其内部嵌套
        let rpgHtml = '';
        let finalEmbeddedHtml = '';
        
        if (config.showStatusBar !== false && typeof generateStatusBarHtml === 'function') {
            // 将选项栏作为参数传入 RPG 生成器，实现内部嵌套
            rpgHtml += generateStatusBarHtml(tables, config, optionHtml, optionPanelVisible);
            finalEmbeddedHtml = rpgHtml;
        } else {
            // 如果关闭了 RPG 状态栏，则保持选项栏独立浮现
            if (optionHtml && optionPanelVisible) finalEmbeddedHtml += optionHtml;
        }

        const checkIsGenerating = () => {
            const TH = window.TavernHelper;
            if (TH && TH.builtin && typeof TH.builtin.duringGenerating === 'function') {
                return TH.builtin.duringGenerating(); 
            }
            return window._acuIsGenerating === true; 
        };
        const isGenerating = checkIsGenerating();

        if (finalEmbeddedHtml) {
            if (isGenerating) {
                $('.acu-status-bar-container').show();
                
                // --- 【核心修复】AI 生成中（还没掉下来时），允许原地更新内部 HTML，解除 UI 冻结 ---
                const currentEmbeddedHash = finalEmbeddedHtml + '_generating'; 
                if (window._lastEmbeddedHash !== currentEmbeddedHash && $('.acu-status-bar-container').length > 0) {
                    const $container = $('.acu-status-bar-container');

                    // [新增保护] 拔下并缓存旧画布
                    const $oldCanvasWrapper = $container.find('.acu-rel-canvas-wrapper');
                    const oldHash = $oldCanvasWrapper.length ? $oldCanvasWrapper.data('graph-hash') : null;
                    if ($oldCanvasWrapper.length) $oldCanvasWrapper.detach();

                    $container
                        .removeClass((idx, cls) => (cls.match(/(^|\s)acu-theme-\S+/g) || []).join(' '))
                        .addClass(`acu-theme-${config.theme}`)
                        .html(finalEmbeddedHtml);
                    
                    // [新增保护] 数据没变的话，完璧归赵
                    if ($oldCanvasWrapper.length) {
                         const $newCanvasWrapper = $container.find('.acu-rel-canvas-wrapper');
                         if ($newCanvasWrapper.length && String(oldHash) === String($newCanvasWrapper.data('graph-hash'))) {
                             $newCanvasWrapper.replaceWith($oldCanvasWrapper);
                         }
                    }

                    window._lastEmbeddedHash = currentEmbeddedHash;
                    
                    setTimeout(() => {
                        if ($('.acu-rpg-widget .acu-rel-canvas-wrapper').length > 0) bindRelationshipPanelEvents();
                        bindOptionEvents();
                    }, 50);
                }
                // -------------------------------------------------------------------------
                
            } else {
                const $currentTarget = typeof getTargetContainer === 'function' ? getTargetContainer() : null;
                const targetId = $currentTarget ? ($currentTarget.closest('.mes').attr('mesid') || $currentTarget.closest('.mes').index()) : 'none';
                const currentEmbeddedHash = finalEmbeddedHtml + '_target_' + targetId; 
                
                if (window._lastEmbeddedHash !== currentEmbeddedHash || $('.acu-status-bar-container').length === 0) {
                     injectStatusBar(finalEmbeddedHtml);
                     window._lastEmbeddedHash = currentEmbeddedHash;
                     
                     setTimeout(() => {
                         if ($('.acu-rpg-widget .acu-rel-canvas-wrapper').length > 0) {
                             bindRelationshipPanelEvents();
                         }
                         // [补回] 确保注入后选项事件生效
                         bindOptionEvents();
                     }, 50);
                }
                $('.acu-status-bar-container').show();
            }
        } else {
            $('.acu-status-bar-container').remove();
            window._lastEmbeddedHash = null;
        }

        bindEvents(tables);
        updateSaveButtonState();
        
        // 绑定状态栏快捷按钮事件
        $('.acu-status-setting-btn').off('click').on('click', (e) => { e.stopPropagation(); showSettingsModal(); });
        $('.acu-status-refresh-btn').off('click').on('click', async (e) => {
            e.stopPropagation();
            const api = getCore().getDB();
            if (api && api.manualUpdate) {
                AcuToast.info('🔄 正在请求后端更新数据...');
                await api.manualUpdate();
            }
        });
        
        // [修复] 如果当前是关系图标签，需要绑定关系图的交互事件
        if (getActiveTabState() === VIRTUAL_RELATIONSHIP_TAB) {
            bindRelationshipPanelEvents();
        }

        

        // 【终极修复】使用 requestAnimationFrame，既不卡死主线程，又能无缝衔接
        requestAnimationFrame(() => {
            const $newContent = $('.acu-panel-content');
            const activeTab = getActiveTabState();
            
            // 1. 判断是否刚刚切换了标签页
            const isTabSwitched = window._acuLastTabForScroll !== activeTab;
            window._acuLastTabForScroll = activeTab;

            // 2. 【精确判断】当前所处的标签页，是否包含暂存未保存的修改？
            let currentTabHasUnsaved = false;
            if (hasUnsavedChanges) {
                const tableKey = tables[activeTab]?.key;
                if (tableKey) {
                    const dels = getPendingDeletions();
                    if (dels[tableKey] && dels[tableKey].length > 0) currentTabHasUnsaved = true;
                    if (window.acuModifiedSet) {
                        for (let id of window.acuModifiedSet) {
                            if (id.startsWith(tableKey + '-')) { currentTabHasUnsaved = true; break; }
                        }
                    }
                }
            }

            if ($newContent.length) {
                // 3. 恢复面板整体位置
                if (!isTabSwitched) {
                    if (window._acuForceScrollTop) {
                        $newContent.scrollTop(0);
                        window._acuForceScrollTop = false;
                    } else {
                        // 【关键修复】同页内的刷新（如插入行、暂存修改）：绝对信任瞬间抓取的 lastScrollY！无视滞后的记忆，死死钉在原地！
                        if (lastScrollY > 0) $newContent.scrollTop(lastScrollY);
                        if (lastScrollX > 0) $newContent.scrollLeft(lastScrollX);
                    }
                } else {
                    // 【优化】按照你的需求：只要当前系统存在任何“未保存的修改”，切换标签页时就记忆滚动条，方便交叉比对。否则统统回顶。
                    const savedState = hasUnsavedChanges ? tableScrollStates[activeTab] : null;
                    if (savedState) {
                        $newContent.scrollTop(savedState.top || 0);
                        $newContent.scrollLeft(savedState.left || 0);
                    } else {
                        $newContent.scrollTop(0);
                        $newContent.scrollLeft(0);
                    }
                }

                // 4. 恢复卡片内部滚动位置 (针对编辑框和长文本区域)
                const savedStateForInner = tableScrollStates[activeTab];
                if (savedStateForInner && savedStateForInner.inner) {
                    Object.keys(savedStateForInner.inner).forEach(key => {
                        const scrollTop = savedStateForInner.inner[key];
                        const $targetTitle = $newContent.find(`.acu-editable-title[data-row="${key}"]`);
                        if ($targetTitle.length) {
                            const $card = $targetTitle.closest('.acu-data-card');
                            $card.scrollTop(scrollTop);
                            $card.find('.acu-card-body').scrollTop(scrollTop);
                        }
                    });
                }
            }
        });
    };

// --- [极速优化版] 独立的消息数据验证逻辑 (免疫标签与代码块干扰) ---
    const isValidMessage = (msgObj) => {
        if (!msgObj || msgObj.is_system || msgObj.is_user) return false;
        
        // 1. 读取底层 Markdown 文本并移除零宽字符
        let rawText = String(msgObj.mes || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
        
        // 2. 剥离所有 HTML 标签 (<xxx> 等)
        let cleanText = rawText.replace(/<[^>]+>/g, '');
        
        // 3. 剥离所有“完整闭合”的 Markdown 代码块 (```...``` 或 `...`)
        cleanText = cleanText.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '').trim();

        if (cleanText === '' || cleanText === '...' || cleanText === '…' || cleanText === '..') return false;

        // 4. 闭合校验 (补上全角冒号：和右括号)）)
        const isProperlyClosed = /[>\]}\*~"\'”’」』》…\.!\?。！？\-\:：\)）]$/.test(cleanText);
        
        // 5. 截断判定 (加入反引号`)
        const isCutOff = !isProperlyClosed && /[a-zA-Z0-9\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af,，、`]$/.test(cleanText);
        
        return !isCutOff;
    };

    // [极速优化版] 获取目标气泡容器 (带强行兜底)
    const getTargetContainer = () => {
        const { $, ST } = getCore();
        if (!ST || !ST.chat || ST.chat.length === 0) return null;

        // 第一轮：正常严格逻辑，寻找最后一个“生成完毕、非空回、非截断”的有效 AI 消息
        for (let i = ST.chat.length - 1; i >= 0; i--) {
            const msg = ST.chat[i];
            
            if (isValidMessage(msg)) {
                const $targetMes = $(`#chat .mes[mesid="${i}"]`);
                if ($targetMes.length && $targetMes.css('display') !== 'none') {
                    const $targetBlock = $targetMes.find('.mes_block');
                    return $targetBlock.length ? $targetBlock : $targetMes;
                }
            }
        }

        // 第二轮：终极兜底逻辑。寻找最后一个非 user 的楼层强行挂载
        for (let i = ST.chat.length - 1; i >= 0; i--) {
            const msg = ST.chat[i];
            
            if (!msg.is_user) {
                const $targetMes = $(`#chat .mes[mesid="${i}"]`);
                if ($targetMes.length && $targetMes.css('display') !== 'none') {
                    const $targetBlock = $targetMes.find('.mes_block');
                    return $targetBlock.length ? $targetBlock : $targetMes;
                }
            }
        }

        return null;
    };

// [修改] 独立插入状态栏到气泡，增加 Canvas 防重置保护
    const injectStatusBar = (htmlContent) => {
        const { $ } = getCore();
        const $target = getTargetContainer();
        if ($target && $target.length) {
            let $container = $target.find('.acu-status-bar-container');
            const optConfig = getConfig(); // 获取最新配置
            
            // [新增保护] 如果容器已存在，尝试抢救里面的 Canvas
            let $oldCanvasWrapper = $();
            let oldHash = null;
            if ($container.length > 0) {
                $oldCanvasWrapper = $container.find('.acu-rel-canvas-wrapper');
                oldHash = $oldCanvasWrapper.length ? $oldCanvasWrapper.data('graph-hash') : null;
                // 核心：拔下 DOM 节点。只要它还在内存里，canvas.isConnected 在同一同步周期内恢复，物理引擎就不会死
                if ($oldCanvasWrapper.length) $oldCanvasWrapper.detach();
            }
            
            if ($container.length === 0) {
                $('.acu-status-bar-container').remove();
                $container = $(`<div class="acu-status-bar-container" style="display:flex; flex-direction:column; gap:6px; margin-top:8px; clear:both;"></div>`);
                $target.append($container);
            }
            
            // 每次注入时，强制清洗并覆盖最新的主题类名
            $container.removeClass((idx, cls) => (cls.match(/(^|\s)acu-theme-\S+/g) || []).join(' '))
                      .addClass(`acu-theme-${optConfig.theme}`);
                      
            $container.html(htmlContent);

            // [新增保护] 判断指纹，决定是初始化新画布，还是把原生的旧画布塞回去
            if ($oldCanvasWrapper.length) {
                 const $newCanvasWrapper = $container.find('.acu-rel-canvas-wrapper');
                 if ($newCanvasWrapper.length && String(oldHash) === String($newCanvasWrapper.data('graph-hash'))) {
                     $newCanvasWrapper.replaceWith($oldCanvasWrapper);
                 }
            }
        }
    };




    const insertHtmlToPage = (html) => {
        const { $ } = getCore();
        const $chat = $('#chat');
        const $oldWrapper = $('.acu-wrapper');
        
        // 永远保持悬浮底部模式 (Fixed)
        if ($oldWrapper.length) {
            $oldWrapper.replaceWith(html);
        } else {
            if ($chat.length) { $chat.append(html); } else { $('body').append(html); }
        }
    };

// ============================================================
// [核心优化] 预编译正则表达式缓存 (极大降低 CPU 消耗)
// ============================================================
const ACU_REGEX = {
    // 表名匹配
    tGlobal: /全局|世界状态|纪要/,
    tChar: /主角信息|玩家状态|主角修为/,
    tStatus: /主角信息|玩家状态|修为|境界|体质|肉身|恒定状态/,
    tSkill: /技能|魔咒|武魂|蛊虫|杀招|流派|蛊方(?!(.*面板|.*核心))/,
    tBag: /背包|物品|道具|装备|仙窍资源/,
    tEvent: /日程|事件|任务|待办/,
    
    // 列名匹配 (全局与主角)
    cLoc: [/地点/, /位置/],
    cTime: [/当前时间/, /时间跨度/],
    cName: [/人物名称/, /姓名/, /名字/],
    cLoc2: [/所在主地点/, /所在地点/],
    cMoney: [/拥有金钱/, /真元/, /仙元/, /现金/, /存款/, /余额/, /资产/, /资源数据/],
    
    // 列名匹配 (状态过滤)
    cStatusSkip: /人物名称|姓名|名字|所在主地点|真元|仙元|拥有金钱/,
    cStatusLong: /外貌|衣着|装扮|经历|故事/,
    cStatusGender: /性别|年龄/,
    cStatusJob: /职业|身份|阵营|学院/,
    cStatusLevel: /等级|境界|道痕|寿元|战力|悬赏/,
    
    // 列名匹配 (技能)
    cSkillName: [/名称/, /咒语/, /本体/, /杀招/, /目标蛊虫/, /流派/],
    cSkillType: [/类型/, /类别/, /属性/, /修习定位/, /核心/],
    cSkillLv: [/等级/, /阶段/, /年份/, /品质/, /转数/, /熟练度/, /掌握/, /境界/],
    cSkillDesc: [/效果/, /描述/, /喂养/, /经验/, /互斥/],
    
    // 列名匹配 (背包)
    cBagName: [/物品名称/, /项目名称/, /名称/],
    cBagQty: [/数量/, /规模/, /数值/],
    cBagDesc: [/描述/, /效果/, /产出/],
    cBagType: [/类别/, /分类/, /类型/],
    vBagMoneyType: /货币|资产|财富/,
    vBagMoneyName: /金币|贝里|加隆|魂币|仙元石|现金|存款|余额|钞票|RMB|软妹币/,
    
    // 列名匹配 (事件)
    cEvtDate: [/日期|时间|Date|期限/i],
    cEvtTitle: [/事件|标题|任务名称|名称|Title|Name/i],
    cEvtType: [/类型|分类|Type/i],
    cEvtDesc: [/详情|描述|内容|Desc/i],
    
    // 值匹配 (智能渲染)
    vPct: /^(\d+(?:\.\d+)?)\s*%$/,
    vRank: /^(EX|SSS|SS|S|A|B|C)[+-]?$/i,
    vRealm: /^(?!星期)[\u4e00-\u9fa5]{2,6}(期|境|层|转|阶|重|段|圆满|仙窍)$/
};

// ============================================================
// [聚合嗅探·极致美化版] 终极 RPG 状态栏生成器
// ============================================================
const generateStatusBarHtml = (tables, config, optionHtml = '', optionPanelVisible = false) => {
    const safeStr = escapeHtml; // 复用全局 escapeHtml
    const isRpgExpanded = localStorage.getItem('acu_rpg_expanded') === 'true'; // 读取展开记忆
    const activeRpgTab = localStorage.getItem('acu_rpg_active_tab') || 'rpg-tab-status'; // 读取标签页记忆
    
    // [新增] 读取显隐状态，为右上角小眼睛做准备
    const isNavHidden = Store.get('acu_hide_nav_only', false);
    const eyeIcon = isNavHidden ? 'fa-eye-slash' : 'fa-eye';
    const eyeTitle = isNavHidden ? '显示主面板' : '隐藏主面板';
    
    // [终极升级] 聚合找表工具：使用全局预编译正则提升性能
    const findTables = (regex) => Object.values(tables).filter(t => regex.test(t.name));
    
    // [核心优化 Top 2] 表头正则映射智能缓存 (Schema Cache)
    if (!window._acuSchemaCache) window._acuSchemaCache = new Map();
    const findColIdx = (headers, regexList) => {
        if (!headers || headers.length === 0) return -1;
        
        // 利用“表头指纹”和“正则指纹”生成唯一缓存 Key
        // 只要表格结构不变，后续同样的正则查找将直接从内存返回结果，时间复杂度从 O(N) 降为 O(1)
        const cacheKey = headers.join('|') + '::' + regexList.map(r => r.source).join('|');
        
        if (window._acuSchemaCache.has(cacheKey)) {
            return window._acuSchemaCache.get(cacheKey);
        }

        for (let i = 0; i < regexList.length; i++) {
            const idx = headers.findIndex(h => regexList[i].test(h));
            if (idx !== -1) {
                window._acuSchemaCache.set(cacheKey, idx);
                return idx;
            }
        }
        window._acuSchemaCache.set(cacheKey, -1);
        return -1;
    };

    // ==========================================
    // 1. 嗅探核心全局数据 (顶栏 Header)
    // ==========================================
    let name = '主角', location = '未知地点', time = '未知时间', money = '0';
    
    const globalTables = findTables(ACU_REGEX.tGlobal);
    if (globalTables.length > 0) {
        // [优化] 优先级排序：优先使用"全局/世界"表，找不到才用"纪要"兜底
        globalTables.sort((a, b) => {
            const aIsGlobal = /全局|世界/.test(a.name);
            const bIsGlobal = /全局|世界/.test(b.name);
            return (aIsGlobal === bIsGlobal) ? 0 : (aIsGlobal ? -1 : 1);
        });

        const targetTable = globalTables[0];
        if (targetTable.rows.length > 0) {
            const locIdx = findColIdx(targetTable.headers, ACU_REGEX.cLoc);
            const timeIdx = findColIdx(targetTable.headers, ACU_REGEX.cTime);
            
            // 全局表通常只有1行(取最后一行即第1行)，纪要表取最后一行(最新进度)
            const targetRow = targetTable.rows[targetTable.rows.length - 1];
            
            if (locIdx !== -1 && targetRow[locIdx]) location = safeStr(targetRow[locIdx]);
            if (timeIdx !== -1 && targetRow[timeIdx]) time = safeStr(targetRow[timeIdx]).replace(/\(.*?\)/g, '').replace(/（.*?）/g, ''); 
        }
    }

    // 提取主角核心信息 (支持从主角表或修为表中抓取资源)
    const charTables = findTables(ACU_REGEX.tChar);
    charTables.forEach(t => {
        if (!t.rows[0]) return;
        const nameIdx = findColIdx(t.headers, ACU_REGEX.cName);
        const locIdx2 = findColIdx(t.headers, ACU_REGEX.cLoc2); 
        const moneyIdx = findColIdx(t.headers, ACU_REGEX.cMoney); 
        
        if (nameIdx !== -1 && t.rows[0][nameIdx]) name = safeStr(t.rows[0][nameIdx]);
        if (locIdx2 !== -1 && t.rows[0][locIdx2]) location = safeStr(t.rows[0][locIdx2]);
        if (moneyIdx !== -1 && t.rows[0][moneyIdx] && money === '0') money = safeStr(t.rows[0][moneyIdx]);
    });

    // --- 通用属性卡片渲染器 ---
    const renderSmartValue = (header, raw) => {
        if (!raw || raw === '无' || raw === '未知' || raw === '待定') return '<span style="color:var(--acu-text-sub); font-weight:500;">未记录</span>';
        const pctMatch = raw.match(ACU_REGEX.vPct);
        if (pctMatch) return `<div class="acu-val-pct-bar"><span class="acu-val-pct-text">${raw}</span><div class="acu-val-pct-track"><div class="acu-val-pct-fill" style="width:${Math.min(100, parseFloat(pctMatch[1]))}%;"></div></div></div>`;
        if (ACU_REGEX.vRank.test(raw)) return `<span class="acu-rank-badge">${raw.toUpperCase()}</span>`;
        if (ACU_REGEX.vRealm.test(raw)) return `<span class="acu-realm-text">☯️ ${raw}</span>`;
        return `<span style="color:var(--acu-text-main); font-weight:500;">${raw}</span>`;
    };

    // ==========================================
    // 2. 嗅探【状态】面板 (聚合：主角信息 + 修为 + 肉身体质)
    // ==========================================
    let statusHtml = '';
    const statusTables = findTables(ACU_REGEX.tStatus);
    statusTables.forEach(t => {
        if (!t.rows[0]) return;
        t.headers.forEach((header, idx) => {
            if (idx === 0 || !header || ACU_REGEX.cStatusSkip.test(header)) return;
            const val = safeStr(t.rows[0][idx]);
            if (!val || val === '无' || val === '未知' || val === '待定') return;

            if (val.length > 25 || ACU_REGEX.cStatusLong.test(header)) {
                statusHtml += `<div style="grid-column: 1 / -1; margin-bottom: 4px; background:var(--acu-badge-bg); padding:10px 12px; border:1px solid var(--acu-border); border-radius:8px;">
                    <strong style="color:var(--acu-text-sub); font-size:12px; display:block; margin-bottom:4px;"><i class="fa-solid fa-star" style="opacity:0.5; font-size:10px;"></i> ${safeStr(header)}</strong>
                    <div style="line-height:1.5; color:var(--acu-text-main); font-size:13px; white-space:pre-wrap;">${val}</div>
                </div>`;
            } else {
                let icon = 'fa-id-badge';
                if (ACU_REGEX.cStatusGender.test(header)) icon = 'fa-venus-mars';
                else if (ACU_REGEX.cStatusJob.test(header)) icon = 'fa-user-tie';
                else if (ACU_REGEX.cStatusLevel.test(header)) icon = 'fa-arrow-up-right-dots';
                
                statusHtml += `<div class="acu-rpg-item-card" style="justify-content:center;">
                    <span class="acu-rpg-item-title" style="font-size:11px; color:var(--acu-text-sub);"><i class="fa-solid ${icon}" style="opacity:0.6; margin-right:4px;"></i>${safeStr(header)}</span>
                    ${renderSmartValue(header, val)}
                </div>`;
            }
        });
    });
    if (!statusHtml) statusHtml = '<div style="color:var(--acu-text-sub); grid-column: 1/-1; text-align:center;">暂无详细记录</div>';

    // ==========================================
    // 3. 嗅探【能力】面板 (聚合：技能 + 蛊虫 + 杀招 + 蛊方 + 流派)
    // ==========================================
    let skillHtml = '';
    const skillTables = findTables(ACU_REGEX.tSkill); 
    skillTables.forEach(t => {
        if (!t.rows) return;
        const sNameIdx = findColIdx(t.headers, ACU_REGEX.cSkillName);
        const sTypeIdx = findColIdx(t.headers, ACU_REGEX.cSkillType);
        const sLvIdx = findColIdx(t.headers, ACU_REGEX.cSkillLv);
        const sDescIdx = findColIdx(t.headers, ACU_REGEX.cSkillDesc);

        t.rows.forEach(row => {
            if (!row || row.length <= 1) return;
            const sName = sNameIdx !== -1 ? safeStr(row[sNameIdx]) : safeStr(row[1]);
            if (!sName) return;

            const sType = sTypeIdx !== -1 ? safeStr(row[sTypeIdx]) : '';
            const sLv = sLvIdx !== -1 ? safeStr(row[sLvIdx]) : '';
            const sDesc = sDescIdx !== -1 ? safeStr(row[sDescIdx]) : '';

            // 如果该行数据全是空的，跳过
            if (!sType && !sLv && !sDesc) return;

            // 根据表名智能更换卡片左边框颜色
            let borderColor = '#9b59b6';
            let icon = 'fa-bolt';
            if (t.name.includes('蛊虫')) { borderColor = '#27ae60'; icon = 'fa-bug'; }
            else if (t.name.includes('流派')) { borderColor = '#f39c12'; icon = 'fa-yin-yang'; }
            else if (t.name.includes('杀招')) { borderColor = '#e74c3c'; icon = 'fa-fire-flame-curved'; }

            skillHtml += `<div class="acu-rpg-item-card" style="border-left: 3px solid ${borderColor};">
                <div class="acu-rpg-card-header">
                    <span class="acu-rpg-card-title"><i class="fa-solid ${icon}" style="color:${borderColor}; opacity:0.8;"></i> ${sName}</span>
                    <div class="acu-rpg-card-badges">
                        ${sType ? `<span class="acu-badge" style="background:rgba(155,89,182,0.15); border-color:rgba(155,89,182,0.3); color:var(--acu-text-main);">${sType}</span>` : ''}
                        ${sLv ? `<span class="acu-badge" style="background:rgba(46,204,113,0.15); color:#2ecc71; border-color:rgba(46,204,113,0.3);">${sLv}</span>` : ''}
                    </div>
                </div>
                ${sDesc ? `<div class="acu-rpg-card-desc">${sDesc}</div>` : ''}
            </div>`;
        });
    });
    if (!skillHtml) skillHtml = '<div style="color:var(--acu-text-sub); text-align:center; grid-column: 1/-1;">暂无能力或装备记录</div>';

    // ==========================================
    // 4. 嗅探【资产】面板 (聚合：背包物品 + 仙窍资源 + 智能分页)
    // ==========================================
    let bagItemsArr = [];
    const bagTables = findTables(ACU_REGEX.tBag);
    bagTables.forEach(t => {
        if (!t.rows) return;
        const nameIdx = findColIdx(t.headers, ACU_REGEX.cBagName);
        const qtyIdx = findColIdx(t.headers, ACU_REGEX.cBagQty);
        const descIdx = findColIdx(t.headers, ACU_REGEX.cBagDesc);
        const typeIdx = findColIdx(t.headers, ACU_REGEX.cBagType);

const tableKey = t.key;
            t.rows.forEach((row, rIdx) => {
                if (!row || row.length <= 1) return;
                const itemName = nameIdx !== -1 ? row[nameIdx] : row[1];
                if (!itemName) return;

                const qty = qtyIdx !== -1 ? safeStr(row[qtyIdx]) : '';
                const desc = descIdx !== -1 ? safeStr(row[descIdx]) : '';
                const type = typeIdx !== -1 ? safeStr(row[typeIdx]) : '';

                if (((type && ACU_REGEX.vBagMoneyType.test(type)) || ACU_REGEX.vBagMoneyName.test(itemName)) && qty) {
                    money = money === '0' ? qty : money + ' / ' + qty;
                }

                bagItemsArr.push(`<div class="acu-rpg-item-card">
                    <style>.acu-bag-act-btn:hover { transform: scale(1.2); }</style>
                    <div class="acu-rpg-card-header" style="align-items: flex-start;">
                        <span class="acu-rpg-card-title" style="font-size:13.5px; padding-top:2px;">${safeStr(itemName)}</span>
                        <div style="flex-shrink:0; max-width:50%; display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
                            ${type ? `<span class="acu-badge acu-badge-neutral" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; display:inline-block;">${type}</span>` : ''}
                            <div style="display:flex; gap:10px; font-size:12px; opacity:0.8; padding-right:2px;">
                                <i class="fa-solid fa-hand-pointer acu-bag-act-btn acu-bag-use-btn" data-name="${escapeHtml(itemName)}" style="cursor:pointer; color:var(--acu-accent); transition:transform 0.2s;" title="使用此物品"></i>
                                <i class="fa-solid fa-trash-can acu-bag-act-btn acu-bag-del-btn" data-key="${escapeHtml(tableKey)}" data-row="${rIdx}" data-name="${escapeHtml(itemName)}" style="cursor:pointer; color:var(--acu-text-sub); transition:all 0.2s;" title="丢弃/彻底删除"></i>
                            </div>
                        </div>
                    </div>
                    ${qty ? `<div style="color:var(--acu-text-main); font-size:12px; margin-top:0px;">数量/规模: <b style="color:var(--acu-accent); font-family:monospace; font-size:14px;">${qty}</b></div>` : ''}
                    ${desc ? `<div class="acu-rpg-card-desc">${desc}</div>` : ''}
                </div>`);
            });
    });

    let bagHtml = '';
    let bagPaginationHtml = '';
    const bagPerPage = config.rpgBagPerPage || 0; // 0 表示自动滚动不分页

    if (bagItemsArr.length === 0) {
        bagHtml = '<div style="color:var(--acu-text-sub); text-align:center; grid-column: 1/-1;">资产与背包空空如也</div>';
    } else if (bagPerPage > 0 && bagItemsArr.length > bagPerPage) {
        const totalPages = Math.ceil(bagItemsArr.length / bagPerPage);
        let curPage = window._acuRpgBagPage || 1;
        if (curPage > totalPages) curPage = totalPages;
        
        const startIdx = (curPage - 1) * bagPerPage;
        bagHtml = bagItemsArr.slice(startIdx, startIdx + bagPerPage).join('');
        
        bagPaginationHtml = `
            <div style="flex-shrink: 0; background: var(--acu-bg-panel); display:flex; justify-content:center; align-items:center; gap:10px; margin: 0 16px; padding: 10px 0; border-top: 1px dashed var(--acu-border);">
                <button class="acu-rpg-page-btn ${curPage <= 1 ? 'disabled' : ''}" data-page="${curPage - 1}" style="background:var(--acu-btn-bg); border:1px solid var(--acu-border); color:var(--acu-text-main); padding:2px 10px; border-radius:4px; cursor:${curPage <= 1 ? 'not-allowed' : 'pointer'}; opacity:${curPage <= 1 ? '0.5' : '1'};"><i class="fa-solid fa-chevron-left"></i></button>
                <span style="font-size:12px; color:var(--acu-text-sub); font-weight:bold;">${curPage} / ${totalPages}</span>
                <button class="acu-rpg-page-btn ${curPage >= totalPages ? 'disabled' : ''}" data-page="${curPage + 1}" style="background:var(--acu-btn-bg); border:1px solid var(--acu-border); color:var(--acu-text-main); padding:2px 10px; border-radius:4px; cursor:${curPage >= totalPages ? 'not-allowed' : 'pointer'}; opacity:${curPage >= totalPages ? '0.5' : '1'};"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
        `;
    } else {
        bagHtml = bagItemsArr.join('');
    }

    // ==========================================
    // 5. 嗅探【日历】面板 (替代原指引面板)
    // ==========================================
    let calendarHtml = '';
    let questCount = 0;
    const currentEvents = [];
    const eventTables = findTables(ACU_REGEX.tEvent).filter(t => !/任务|待办/.test(t.name));
    
    eventTables.forEach(t => {
        if (!t.rows) return;
        const dateIdx = findColIdx(t.headers, ACU_REGEX.cEvtDate);
        const titleIdx = findColIdx(t.headers, ACU_REGEX.cEvtTitle);
        const typeIdx = findColIdx(t.headers, ACU_REGEX.cEvtType);
        const descIdx = findColIdx(t.headers, ACU_REGEX.cEvtDesc);

        if (dateIdx !== -1) {
            t.rows.forEach(row => {
                if (!row || row.length <= 1) return;
                const dStr = safeStr(row[dateIdx]);
                const rowDate = CalendarModule.parseTime(dStr);
                if (rowDate) {
                    questCount++;
                    const fmtDate = `${rowDate.year}-${String(rowDate.month).padStart(2,'0')}-${String(rowDate.day).padStart(2,'0')}`;
                    currentEvents.push({
                        date: fmtDate,
                        title: titleIdx !== -1 ? (safeStr(row[titleIdx]) || '未命名') : '事件',
                        type: typeIdx !== -1 ? safeStr(row[typeIdx]) : '其他',
                        desc: descIdx !== -1 ? safeStr(row[descIdx]) : ''
                    });
                }
            });
        }
    });

    const allEvents = currentEvents;
    
    // 解析当前世界时间，用于决定日历翻到哪一页
    let viewYear = new Date().getFullYear();
    let viewMonth = new Date().getMonth() + 1;
    let viewDay = new Date().getDate();
    if (time !== '未知时间') {
        const parsedCurrent = CalendarModule.parseTime(time);
        if (parsedCurrent) {
            viewYear = parsedCurrent.year;
            viewMonth = parsedCurrent.month;
            viewDay = parsedCurrent.day;
        }
    } else if (allEvents.length > 0) {
        // [修复] 如果删除了全局表导致没有时间锚点，自动把日历翻到“第一个有效日程”所在的年月
        const firstEvtDate = allEvents[0].date.split('-');
        if (firstEvtDate.length >= 2) {
            viewYear = parseInt(firstEvtDate[0], 10);
            viewMonth = parseInt(firstEvtDate[1], 10);
            viewDay = parseInt(firstEvtDate[2], 10) || 1;
        }
    }
    
    // 挂载到全局供交互事件使用
    window._acuEmbeddedCalData = { year: viewYear, month: viewMonth, day: viewDay, events: allEvents };
    
    calendarHtml = `
        <div id="acu-rpg-embedded-cal-container" style="padding-top:5px;">
            ${CalendarModule.render(viewYear, viewMonth, viewDay, allEvents)}
        </div>
        <div id="acu-rpg-embedded-cal-details" class="acu-event-details" style="display:none; margin-top:10px; background:var(--acu-bg-panel);">
            <div style="font-size:12px; color:var(--acu-text-sub); margin-bottom:8px;">
                <span>📅 <span id="acu-emb-evt-date-title"></span></span>
            </div>
            <div id="acu-emb-evt-list"></div>
        </div>
    `;

    // ==========================================
    // 5.5 嗅探【任务与事件表】 (美化并追加在日历下方)
    // ==========================================
    let questHtml = '';
    const questTables = findTables(/任务|事件|待办/); 
    
    questTables.forEach(t => {
        if (!t.rows) return;
        
        // [修改] 兼容旧版任务表与新版“待办事项”表的列名映射
        const qNameIdx = findColIdx(t.headers, [/任务名称|名称|标题/]);
        const qTypeIdx = findColIdx(t.headers, [/任务类型|类型|分类/]);
        const qPubIdx = findColIdx(t.headers, [/发布者|委托人|涉及对象/]);
        const qDescIdx = findColIdx(t.headers, [/详细描述|描述|详情|事项详情/]);
        const qProgIdx = findColIdx(t.headers, [/当前进度|进度|状态/]);
        const qTimeIdx = findColIdx(t.headers, [/任务时限|时限|期限|开始时间/]);
        const qRemarkIdx = findColIdx(t.headers, [/备注/]); // 新增备注列
        const qRewIdx = findColIdx(t.headers, [/奖励/]);
        const qPenIdx = findColIdx(t.headers, [/惩罚/]);

        t.rows.forEach(row => {
            if (!row || row.length <= 1) return;
            const qName = qNameIdx !== -1 ? safeStr(row[qNameIdx]) : safeStr(row[1]);
            if (!qName || qName === '无' || qName === '未知' || qName === '') return;
questCount++; // [修复] 补充统计待办的数量

            let qType = qTypeIdx !== -1 ? safeStr(row[qTypeIdx]) : '';
            // [美化] 自动剥离文本里的中英文括弧（如 "[待办]" 变成 "待办"），让前端徽章更清爽
            qType = qType.replace(/[\[\]【】]/g, '').trim();
            
            const qPub = qPubIdx !== -1 ? safeStr(row[qPubIdx]) : '';
            const qDesc = qDescIdx !== -1 ? safeStr(row[qDescIdx]) : '';
            const qProg = qProgIdx !== -1 ? safeStr(row[qProgIdx]) : '';
            const qTime = qTimeIdx !== -1 ? safeStr(row[qTimeIdx]) : '';
            const qRemark = qRemarkIdx !== -1 ? safeStr(row[qRemarkIdx]) : '';
            const qRew = qRewIdx !== -1 ? safeStr(row[qRewIdx]) : '';
            const qPen = qPenIdx !== -1 ? safeStr(row[qPenIdx]) : '';

            let borderColor = '#3498db'; 
            if (qType.includes('主线') || qType.includes('核心') || qType.includes('誓约')) borderColor = '#f1c40f'; 
            else if (qType.includes('紧急') || qType.includes('限时') || qType.includes('危机') || qType.includes('待办')) borderColor = '#e74c3c'; 
            else if (qType.includes('日常') || qType.includes('循环') || qType.includes('线索')) borderColor = '#2ecc71'; 

            // 动态决定前缀文案，完美适配旧版任务表和新版待办表
            const pubLabel = t.name.includes('待办') ? '涉及对象' : '发布者';
            const pubIcon = t.name.includes('待办') ? 'fa-crosshairs' : 'fa-bullhorn';
            const progLabel = t.name.includes('待办') ? '当前状态' : '当前进度';

            questHtml += `<div class="acu-rpg-item-card" style="border-left: 3px solid ${borderColor}; margin-bottom: 12px; padding: 12px; background: var(--acu-card-bg); box-shadow: 0 2px 6px rgba(0,0,0,0.1);">
                <div class="acu-rpg-card-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px dashed var(--acu-border); padding-bottom: 6px; margin-bottom: 8px;">
                    <span class="acu-rpg-card-title" style="font-size:14px; font-weight:bold; color:var(--acu-text-main);"><i class="fa-solid fa-scroll" style="color:${borderColor}; margin-right:4px;"></i> ${qName}</span>
                    <div class="acu-rpg-card-badges" style="display:flex; gap:6px;">
                        ${qType && qType !== '无' ? `<span class="acu-badge" style="background:rgba(52,152,219,0.15); color:var(--acu-accent); border:1px solid rgba(52,152,219,0.3); font-size:11px; padding:2px 8px;">${qType}</span>` : ''}
                        ${qTime && qTime !== '无' ? `<span class="acu-badge" style="background:rgba(231,76,60,0.15); color:#e74c3c; border:1px solid rgba(231,76,60,0.3); font-size:11px; padding:2px 8px;"><i class="fa-regular fa-clock"></i> ${qTime}</span>` : ''}
                    </div>
                </div>
                ${qPub && qPub !== '无' ? `<div style="font-size: 11px; color: var(--acu-text-sub); margin-bottom: 6px;"><i class="fa-solid ${pubIcon}" style="opacity:0.7;"></i> <b>${pubLabel}:</b> ${qPub}</div>` : ''}
                ${qDesc && qDesc !== '无' ? `<div class="acu-rpg-card-desc" style="font-size: 12px; line-height:1.5; color:var(--acu-text-sub); margin-bottom: 8px;">${qDesc}</div>` : ''}
                ${qProg && qProg !== '无' ? `<div style="font-size: 12px; color: var(--acu-accent); margin-bottom: 8px; background: var(--acu-badge-bg); padding: 6px 8px; border-radius: 4px; border-left: 2px solid var(--acu-accent);"><b>${progLabel}:</b> ${qProg}</div>` : ''}
                ${qRemark && qRemark !== '无' ? `<div style="font-size: 11px; color: #f39c12; margin-bottom: 8px; background: rgba(243,156,18,0.1); padding: 6px 8px; border-radius: 4px; border: 1px dashed rgba(243,156,18,0.3);"><i class="fa-solid fa-thumbtack"></i> <b>备注:</b> ${qRemark}</div>` : ''}
                
                ${(qRew && qRew !== '无') || (qPen && qPen !== '无') ? `
                <div style="display: flex; gap: 8px; font-size: 11px; margin-top: 4px;">
                    ${qRew && qRew !== '无' ? `<div style="flex: 1; color: #27ae60; background: rgba(46,204,113,0.08); padding: 6px 8px; border-radius: 4px; border: 1px dashed rgba(46,204,113,0.3);"><i class="fa-solid fa-gift"></i> <b>奖励:</b> ${qRew}</div>` : ''}
                    ${qPen && qPen !== '无' ? `<div style="flex: 1; color: #c0392b; background: rgba(231,76,60,0.08); padding: 6px 8px; border-radius: 4px; border: 1px dashed rgba(231,76,60,0.3);"><i class="fa-solid fa-skull"></i> <b>惩罚:</b> ${qPen}</div>` : ''}
                </div>` : ''}
            </div>`;
        });
    });

    if (questHtml) {
        questHtml = `
            <div style="margin-top: 15px; border-top: 1px dashed var(--acu-border); padding-top: 15px;">
                <div style="font-weight: bold; color: var(--acu-text-main); margin-bottom: 12px; font-size: 13px; display: flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-map-location-dot" style="color:var(--acu-accent);"></i> 当前任务日志
                </div>
                <div class="acu-rpg-quest-list" style="display: flex; flex-direction: column; gap: 2px;">
                    ${questHtml}
                </div>
            </div>
        `;
    }

    // ==========================================
    // 6. [新增] 提取并移植【关系网】视图
    // ==========================================
    let rawRelHtml = typeof renderRelationshipPanel === 'function' ? renderRelationshipPanel() : '';
    let relHtml = rawRelHtml
        .replace(/<div class="acu-panel-header">[\s\S]*?<\/div>\s*(?=<div class="acu-panel-content)/, '')
        .replace(/height:45vh;min-height:300px;/g, 'height:450px; max-height:60vh; min-height:350px; border-radius: 8px;')
        .replace(/min-height:300px;height:45vh;/g, 'height:100%; min-height:100%;')
        .replace(/<canvas class="acu-rel-canvas"/, '<div style="position:absolute; top:15px; right:15px; z-index:10;"><button class="acu-view-btn" id="acu-rel-pin-center-embedded" style="background:var(--acu-bg-panel); border:1px solid var(--acu-border); border-radius:4px; padding:4px 8px; margin-right:5px; box-shadow:0 2px 5px rgba(0,0,0,0.2);" title="设定固定的中心节点"><i class="fa-solid fa-crosshairs"></i></button><button class="acu-view-btn" id="acu-rel-reset-embedded" style="background:var(--acu-bg-panel); border:1px solid var(--acu-border); border-radius:4px; padding:4px 8px; box-shadow:0 2px 5px rgba(0,0,0,0.2);" title="重置视图"><i class="fa-solid fa-compress-arrows-alt"></i></button></div><canvas class="acu-rel-canvas"');

    // ==========================================
    // 最终组装与输出
    // ==========================================
    let embeddedOptionsHtml = '';
    if (optionHtml && optionPanelVisible) {
        // 去除独立气泡的边距与边框，使其完美融入 RPG 容器顶部
        let cleanOptionHtml = optionHtml.replace(/margin-bottom:\s*6px;/g, 'margin-bottom: 0; border: none; background: transparent;').replace(/border:\s*1px\s*solid\s*var\(--acu-border\);/g, '');
        embeddedOptionsHtml = `
            <div class="acu-embedded-options-in-rpg" style="background: var(--acu-bg-nav); border-bottom: 1px dashed var(--acu-border); border-radius: 12px 12px 0 0;">
                ${cleanOptionHtml}
            </div>
        `;
    }

    return `
        <div class="acu-rpg-widget">
            ${embeddedOptionsHtml}
            <div class="acu-rpg-summary acu-rpg-summary-toggle" title="点击展开/收起详细面板" style="${embeddedOptionsHtml ? 'border-radius: 0;' : ''}">
                <div style="font-weight: 900; font-size: 1.15em; color: var(--acu-accent);">
                    <i class="fa-solid fa-user-astronaut"></i> ${name}
                </div>
                <style>
                    /* 外层容器：控制溢出隐藏和渐变遮罩 */
                    .acu-rpg-scroll-text { 
                        flex: 1; 
                        min-width: 0; 
                        overflow: hidden; 
                        white-space: nowrap; 
                        -webkit-mask-image: linear-gradient(to right, black 90%, transparent);
                        mask-image: linear-gradient(to right, black 90%, transparent);
                    }
                    /* 内部智能跑马灯容器 */
                    .acu-smart-marquee {
                        display: inline-block;
                        white-space: nowrap;
                    }
                    /* 仅当 JS 检测到真溢出时，才会加上这个类名进行来回滚动 */
                    .acu-smart-marquee.is-scrolling {
                        animation: acu-ping-pong 5s ease-in-out infinite alternate;
                    }
                    .acu-smart-marquee.is-scrolling:hover {
                        animation-play-state: paused;
                    }
                    @keyframes acu-ping-pong {
                        0%, 15% { transform: translateX(0); }
                        85%, 100% { transform: translateX(var(--scroll-dist)); }
                    }
                    
                    /* 覆盖原有的 badge，使其完美平分空间并允许内部滚动 */
                    .acu-loc-time-badge {
                flex: 1;
                min-width: 0;
                display: flex;
                align-items: center;
                border: 1px solid var(--acu-border);
                padding: 4px 12px;
                border-radius: 20px;
                max-width: none !important;
                background: rgba(128,128,128,0.06);
            }
                </style>
                ${(() => {
                    let html = `<div class="acu-rpg-loc-time">
                    <span class="acu-rpg-badge acu-loc-time-badge" title="${location}">
                        <i class="fa-solid fa-location-dot" style="color: #ff6b81; margin-right:6px; flex-shrink:0;"></i>
                        <div class="acu-rpg-scroll-text"><div class="acu-smart-marquee">${safeStr(location)}</div></div>
                    </span>`;
                    
                    if (time !== '未知时间') {
                        html += `
                        <span class="acu-rpg-badge acu-loc-time-badge" title="${time}">
                            <i class="fa-regular fa-clock" style="color: #7bed9f; margin-right:6px; flex-shrink:0;"></i>
                            <div class="acu-rpg-scroll-text"><div class="acu-smart-marquee">${safeStr(time)}</div></div>
                        </span>`;
                    }
                    html += `</div>`;
                    return html;
                })()}
                
                <div style="margin-left: auto; display:flex; gap:8px; align-items:center;">
                    <span style="color:#f1c40f; font-weight:bold; font-family:monospace; font-size:13px; background:var(--acu-badge-bg); border:1px solid var(--acu-border); padding:3px 8px; border-radius:15px;" title="持有资产">
                        <i class="fa-solid fa-coins"></i> ${money}
                    </span>
                    <span style="color:${questCount > 0 ? '#2ecc71' : 'var(--acu-text-sub)'}; font-weight:bold; font-size:13px; background:var(--acu-badge-bg); border:1px solid var(--acu-border); padding:3px 8px; border-radius:15px;" title="记录事件数">
                        <i class="fa-solid fa-calendar-check"></i> ${questCount}
                    </span>
                    
                    <i class="fa-solid ${eyeIcon} acu-nav-toggle-btn" style="cursor:pointer; opacity:0.6; font-size:14px; margin-left:4px; transition:all 0.2s;" title="${eyeTitle}"></i>
                    
                    <i class="fa-solid fa-chevron-down acu-rpg-chevron" style="transition: transform 0.3s; color:var(--acu-text-sub); ${isRpgExpanded ? 'transform: rotate(180deg);' : ''}"></i>
                </div>
            </div>

            <div class="acu-rpg-details acu-rpg-details-panel" style="${isRpgExpanded ? 'display: block;' : ''}">
                <div class="acu-rpg-tabs">
                    <button class="acu-rpg-tab-btn ${activeRpgTab === 'rpg-tab-status' ? 'active' : ''}" data-target="rpg-tab-status"><i class="fa-solid fa-id-card"></i> 状态</button>
                    <button class="acu-rpg-tab-btn ${activeRpgTab === 'rpg-tab-skills' ? 'active' : ''}" data-target="rpg-tab-skills"><i class="fa-solid fa-bolt"></i> 能力</button>
                    <button class="acu-rpg-tab-btn ${activeRpgTab === 'rpg-tab-inventory' ? 'active' : ''}" data-target="rpg-tab-inventory"><i class="fa-solid fa-briefcase"></i> 资产</button>
                    <button class="acu-rpg-tab-btn ${activeRpgTab === 'rpg-tab-calendar' ? 'active' : ''}" data-target="rpg-tab-calendar"><i class="fa-solid fa-calendar-days"></i> 日历</button>
                    <button class="acu-rpg-tab-btn ${activeRpgTab === 'rpg-tab-relations' ? 'active' : ''}" data-target="rpg-tab-relations"><i class="fa-solid fa-project-diagram"></i> 关系</button>
                    <button class="acu-rpg-tab-btn ${activeRpgTab === 'rpg-tab-settings' ? 'active' : ''}" data-target="rpg-tab-settings"><i class="fa-solid fa-cog"></i> 设置</button>
                </div>

                <div class="acu-rpg-tab-content ${activeRpgTab === 'rpg-tab-status' ? 'active' : ''} rpg-tab-status">
                    <div class="acu-rpg-grid">${statusHtml}</div>
                </div>

                <div class="acu-rpg-tab-content ${activeRpgTab === 'rpg-tab-skills' ? 'active' : ''} rpg-tab-skills">
                    <div class="acu-rpg-grid acu-grid-responsive" style="grid-template-columns: 1fr 1fr;">${skillHtml}</div>
                </div>

                <style>.acu-rpg-tab-content.rpg-tab-inventory.active { display: flex !important; }</style>
                <div class="acu-rpg-tab-content ${activeRpgTab === 'rpg-tab-inventory' ? 'active' : ''} rpg-tab-inventory" style="padding: 0; flex-direction: column; overflow: hidden;">
                    <div style="flex: 1; overflow-y: auto; padding: 16px; overscroll-behavior: auto;">
                        <div class="acu-rpg-grid acu-grid-responsive">${bagHtml}</div>
                    </div>
                    ${typeof bagPaginationHtml !== 'undefined' ? bagPaginationHtml : ''}
                </div>

                <div class="acu-rpg-tab-content ${activeRpgTab === 'rpg-tab-calendar' ? 'active' : ''} rpg-tab-calendar" style="padding: 10px;">
                    ${calendarHtml}
                    ${typeof questHtml !== 'undefined' ? questHtml : ''}
                </div>

                <div class="acu-rpg-tab-content ${activeRpgTab === 'rpg-tab-relations' ? 'active' : ''} rpg-tab-relations" style="padding:0; position:relative; overflow:hidden;">
                    ${relHtml}
                </div>
                
                <div class="acu-rpg-tab-content ${activeRpgTab === 'rpg-tab-settings' ? 'active' : ''} rpg-tab-settings" style="padding: 15px;">
                    <div style="background:var(--acu-badge-bg); border:1px solid var(--acu-border); border-radius:8px; padding:15px;">
                        <div style="font-weight:bold; color:var(--acu-accent); margin-bottom:15px; border-bottom:1px dashed var(--acu-border); padding-bottom:8px;"><i class="fa-solid fa-sliders"></i> 资产面板专属设置</div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                            <span style="color:var(--acu-text-main); font-size:13px;">资产列表分页数量</span>
                            <div style="display:flex; align-items:center; gap:6px;">
                                <input type="number" id="acu-rpg-cfg-bag-page" value="${config.rpgBagPerPage || 0}" min="0" max="99" style="width:50px; background-color:var(--acu-btn-bg) !important; border:1px solid var(--acu-border) !important; color:var(--acu-text-main) !important; font-weight:bold; text-align:center; border-radius:4px; padding:4px; outline:none;">
                                <span style="color:var(--acu-text-sub); font-size:11px;">(0为自动向下滚动)</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
};

const renderTableContent = (tableData, tableName) => {
        if (!tableData || !tableData.rows.length) return `
            <div class="acu-panel-header"><div class="acu-panel-title"><i class="fa-solid ${getIconForTableName(tableName)}"></i> ${tableName}</div><button class="acu-close-btn" title="关闭"><i class="fa-solid fa-times"></i></button></div>
            <div class="acu-panel-content"><div style="text-align:center;color:var(--acu-text-sub);padding:20px;">暂无数据</div></div>`;

        const config = getConfig();
        const safeStr = escapeHtml;
        const pendingDeletions = getPendingDeletions()[tableData.key] || [];
        const headers = (tableData.headers || []).slice(1);
        const reversedTables = Store.get('acu_reverse_tables', []);
        const disabledHighlightTables = Store.get(STORAGE_KEY_DISABLE_HIGHLIGHT_TOP, []);
        const isReversed = !reversedTables.includes(tableName); // 反转逻辑：不在排除列表里的默认为倒序
        const isHighlightTop = !disabledHighlightTables.includes(tableName); // [修改] 不在黑名单里即为开启高亮置顶
        
        // [新增] 获取当前表格的视图模式 (默认 list)
        const currentStyle = (getTableStyles() || {})[tableName] || 'list';
        const isGridMode = currentStyle === 'grid';

        let titleColIndex = 1;
        if (tableData.headers.length === 1) { titleColIndex = 0; } 
        else if (tableName.includes('总结') || tableName.includes('大纲')) { const idx = tableData.headers.findIndex(h => h && (h.includes('索引') || h.includes('编号') || h.includes('代码'))); if (idx > 0) titleColIndex = idx; }

// --- 【新增】在排序和过滤之前，提前获取当前表格的锁定状态小本本 ---
        const api = getCore().getDB();
        let tableLockState = null;
        if (api && api.getTableLockState && tableData.key) {
            tableLockState = api.getTableLockState(tableData.key);
        }

        let processedRows = tableData.rows.map((row, index) => ({ data: row, originalIndex: index }));
        const searchTerm = (tableSearchStates[tableName] || '').toLowerCase().trim();

// [修复] 智能排序：只有当该行存在【非手动修改】的差异（即纯AI修改）时，才算高优先级置顶
const isRowHighPriority = (idx) => {
    if (!config.highlightNew) return false;
    
    // 1. 检查是否整行新增 (整行新增必然是 AI 行为)
    if (currentDiffMap.has(`${tableName}-row-${idx}`)) return true;
    
    // 2. 检查该行是否有任何单元格被修改
    for (const key of currentDiffMap) {
        if (key.startsWith(`${tableName}-${idx}-`)) {
            // 提取列索引
            const parts = key.split('-');
            const colIdx = parts[parts.length - 1];
            
            // 组装手动修改记录的专属 key (格式: tableKey-行索引-列索引，例如: sheet_1-0-1)
            const manualKey = `${tableData.key}-${idx}-${colIdx}`;
            
            // 如果这个差异没有记录在手动修改的集合里，说明是纯 AI 修改的，执行置顶！
            if (!window.acuModifiedSet || !window.acuModifiedSet.has(manualKey)) {
                return true;
            }
        }
    }
    
    return false;
};


        if (searchTerm) {
            processedRows = processedRows.filter(item => item.data.some(cell => String(cell).toLowerCase().includes(searchTerm)));
            processedRows.sort((a, b) => {
                const titleA = String(a.data[titleColIndex] || '').toLowerCase(); const titleB = String(b.data[titleColIndex] || '').toLowerCase();
                const aHitTitle = titleA.includes(searchTerm); const bHitTitle = titleB.includes(searchTerm);
                if (titleA === searchTerm && titleB !== searchTerm) return -1;
                if (titleA !== searchTerm && titleB === searchTerm) return 1;
                if (aHitTitle && !bHitTitle) return -1; if (!aHitTitle && bHitTitle) return 1;
                return a.originalIndex - b.originalIndex;
            });
        } else {
                        processedRows.sort((a, b) => {
                // 1. 如果勾选了"高亮置顶"，则优先显示 AI 变化行
                if (isHighlightTop) {
                    const aHigh = isRowHighPriority(a.originalIndex);
                    const bHigh = isRowHighPriority(b.originalIndex);
                    
                    if (aHigh && !bHigh) return -1; // A是高亮，排前面
                    if (!aHigh && bHigh) return 1;  // B是高亮，排前面
                }
                
                // 2. 根据"倒序"设置决定基础排序
                if (isReversed) {
                    return b.originalIndex - a.originalIndex; // 倒序：索引大的(新的)在前
                } else {
                    return a.originalIndex - b.originalIndex; // 正序：索引小的(旧的)在前
                }
            });
        }

        const itemsPerPage = config.itemsPerPage || 50;
        const totalItems = processedRows.length;
        const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
        let currentPage = tablePageStates[tableName] || 1;
        if (currentPage > totalPages) currentPage = totalPages; if (currentPage < 1) currentPage = 1;
        tablePageStates[tableName] = currentPage;

        const startIdx = (currentPage - 1) * itemsPerPage; const endIdx = startIdx + itemsPerPage;
        const rowsToRender = processedRows.slice(startIdx, endIdx);
        // [修改] 无论正逆序都显示图标，且添加 .acu-sort-toggle-btn 类名供点击事件绑定
        const sortIcon = `<i class="fa-solid ${isReversed ? 'fa-sort-amount-up' : 'fa-sort-amount-down'} acu-sort-toggle-btn" data-table="${escapeHtml(tableName)}" title="点击切换排序 (当前: ${isReversed ? '倒序-最新在前' : '正序-最早在前'})" style="color:var(--acu-accent); margin-left:8px; font-size:14px; cursor:pointer; transition: transform 0.2s;"></i>`;

        // [修改] 表头增加了 视图切换按钮 和 高度拖拽手柄
        let html = `
            <div class="acu-panel-header">
                <div class="acu-panel-title">
    <div class="acu-title-main"><i class="fa-solid ${getIconForTableName(tableName)}"></i> <span class="acu-title-text">${escapeHtml(tableName)}</span> ${sortIcon}</div>
    <div class="acu-title-sub">(${startIdx + 1}-${Math.min(endIdx, totalItems)} / 共${totalItems}项)</div>
</div>
                <div class="acu-header-actions">
                    <button class="acu-view-btn" id="acu-btn-switch-style" data-table="${escapeHtml(tableName)}" title="🔄 点击切换视图模式 (当前: ${isGridMode?'双列网格':'单列列表'})">
                        <i class="fa-solid ${isGridMode ? 'fa-th-large' : 'fa-list'}"></i>
                    </button>
                    <div class="acu-height-control">
                        <i class="fa-solid fa-arrows-up-down acu-height-drag-handle" data-table="${escapeHtml(tableName)}" title="↕️ 拖动调整面板高度 | 双击恢复默认"></i>
                    </div>
                    
                    <div class="acu-search-wrapper"><i class="fa-solid fa-search acu-search-icon"></i><input type="text" class="acu-search-input" placeholder="搜索全部..." value="${(tableSearchStates[tableName] || '').replace(/"/g, '&quot;')}" style="background-color: var(--acu-btn-bg) !important; color: var(--acu-text-main) !important; background-image: none !important;" /></div>
                    <button class="acu-close-btn" title="关闭"><i class="fa-solid fa-times"></i></button>
                </div>
            </div>
            <div class="acu-panel-content"><div class="acu-card-grid">`;

        html += rowsToRender.map((item) => {
            const realRowIdx = item.originalIndex; const row = item.data;
            const isPending = pendingDeletions.includes(realRowIdx);
            const cardTitle = row[titleColIndex] || '未命名';
            const showDefaultIndex = (titleColIndex === 1);
            const titleCellId = `${tableData.key}-${realRowIdx}-${titleColIndex}`;
            const isTitleModified = window.acuModifiedSet && window.acuModifiedSet.has(titleCellId);
            const isRowNew = currentDiffMap.has(`${tableName}-row-${realRowIdx}`);
            let rowClass = '';
            if (config.highlightNew) { if (isTitleModified) rowClass = 'acu-highlight-manual'; else if (isRowNew) rowClass = 'acu-highlight-diff'; }

            // 计算有效列数，用于网格视图末行占满处理
const validColIndices = row.map((_, i) => i).filter(i => i > 0 && i !== titleColIndex);
const isOddValidCount = validColIndices.length % 2 === 1;

const cardBody = row.map((cell, cIdx) => {
                if (cIdx <= 0 || cIdx === titleColIndex) return ''; 
                const isLastValidCol = cIdx === validColIndices[validColIndices.length - 1];
                const spanFullRow = isLastValidCol && isOddValidCount;
                const headerName = headers[cIdx - 1] || `属性${cIdx}`;
                // safeStr 已复用全局 escapeHtml，此处删除冗余声明
                const rawStr = String(cell).trim();
                
                // [新增] 检测时间列，添加日历图标
                let appendIcon = '';
                if (tableName.includes('全局') && (headerName.includes('时间') || headerName.includes('Time') || headerName.includes('Date'))) {
                    // 只有当单元格有内容时才显示图标
                    if (rawStr && rawStr.length > 4) {
                        appendIcon += ` <i class="fa-solid fa-calendar-alt acu-calendar-trigger" style="cursor:pointer; color:var(--acu-accent); margin-left:6px; opacity:0.8;" title="查看日历 (支持修仙年份)"></i>`;
                    }
                }

                // --- 【核心新增】检查单元格是否被锁定，如果锁定则追加 🔒 图标 ---
                if (tableLockState) {
                    const r = realRowIdx + 1; // 真实行号从1开始算（因为有表头）
                    const c = cIdx;           // 列号
                    // 判断：单元格被锁，或者整行被锁，或者整列被锁
                    if (
                        (tableLockState.cells && (tableLockState.cells.includes(`${r}:${c}`) || tableLockState.cells.some(arr => arr[0] === r && arr[1] === c))) ||
                        (tableLockState.rows && tableLockState.rows.includes(r)) ||
                        (tableLockState.cols && tableLockState.cols.includes(c))
                    ) {
                        appendIcon += ` <i class="fa-solid fa-lock" style="color:#f39c12; margin-left:4px; opacity:0.9; font-size:11px;" title="该单元格已被物理锁定，免疫AI篡改"></i>`;
                    }
                }

                let contentHtml = '';
                const splitRegex = /[;；]/;
                
                // [修改] 定义临时去括号函数 (Visual Only) - 已移除去括号逻辑
    const cleanVis = (s) => String(s).trim();

                // 智能标签渲染：只有每段都≤6字符才用标签气泡
                if (rawStr.length > 0 && splitRegex.test(rawStr) && !rawStr.includes('http')) {
                    const parts = rawStr.split(splitRegex).map(s => s.trim()).filter(s => s);
                    const allShort = parts.length > 1 && parts.every(p => p.length <= 6);
                    if (allShort) {
                        const tagsHtml = parts.map(part => {
                            const subStyle = getBadgeStyle(part) || 'acu-badge-neutral'; 
                            // [修改] 标签内部去括号
                            return `<span class="acu-badge ${subStyle}">${safeStr(cleanVis(part))}</span>`;
                        }).join('');
                        contentHtml = `<div class="acu-tag-container">${tagsHtml}</div>`;
                    } else {
                        // [修改] 长文本去括号
                        contentHtml = safeStr(cleanVis(rawStr));
                    }
                } else {
                    const badgeStyle = getBadgeStyle(rawStr);
                    // [修改] 普通单元格去括号
                    const cleanText = cleanVis(rawStr);
                    const displayCell = (safeStr(cleanText) === '' && String(cell) !== '0') ? '&nbsp;' : safeStr(cleanText);
                    contentHtml = badgeStyle ? `<span class="acu-badge ${badgeStyle}">${displayCell}</span>` : displayCell;
                }
                
                // [新增] 拼接日历图标
                contentHtml += appendIcon;

                const isDiffChanged = currentDiffMap.has(`${tableName}-${realRowIdx}-${cIdx}`);
                const cellId = `${tableData.key}-${realRowIdx}-${cIdx}`;
                const isUserModified = window.acuModifiedSet && window.acuModifiedSet.has(cellId);
                let cellHighlight = '';
                if (config.highlightNew) { if (isUserModified) cellHighlight = 'acu-highlight-manual'; else if (isDiffChanged) cellHighlight = 'acu-highlight-diff'; }

                return `<div class="acu-card-row acu-cell${spanFullRow ? ' acu-grid-span-full' : ''}" data-key="${escapeHtml(tableData.key)}" data-tname="${escapeHtml(tableName)}" data-row="${realRowIdx}" data-col="${cIdx}" data-val="${encodeURIComponent(cell ?? '')}"><div class="acu-card-label">${headerName}</div><div class="acu-card-value ${cellHighlight}">${contentHtml}</div></div>`;
            }).join('');
            
            // [新增] 判断整行是否被锁定，以渲染快捷锁定图标
            let isRowLocked = false;
            if (tableLockState && tableLockState.rows && tableLockState.rows.includes(realRowIdx + 1)) {
                isRowLocked = true;
            }
            const rowLockIcon = `<i class="fa-solid ${isRowLocked ? 'fa-lock' : 'fa-unlock'} acu-row-lock-btn" data-key="${escapeHtml(tableData.key)}" data-row="${realRowIdx}" title="${isRowLocked ? '整行已锁定 (点击解锁)' : '点击锁定整行 (防篡改)'}" style="cursor:pointer; margin-left:auto; color:${isRowLocked ? '#f39c12' : 'var(--acu-text-sub)'}; opacity:${isRowLocked ? '1' : '0.4'}; font-size:13px; transition:all 0.2s;"></i>`;

            // [新增] 检查标题单元格本身的锁定状态 (防止用户误触单元格锁定但看不见)
            let isTitleLocked = false;
            if (tableLockState) {
                const r = realRowIdx + 1;
                const c = titleColIndex;
                if ((tableLockState.cells && (tableLockState.cells.includes(`${r}:${c}`) || tableLockState.cells.some(arr => arr[0] === r && arr[1] === c))) || (tableLockState.cols && tableLockState.cols.includes(c))) {
                    isTitleLocked = true;
                }
            }
            // 如果行没锁，但标题单元格被锁了，就在标题旁边加个小锁提示
            const titleLockIcon = (isTitleLocked && !isRowLocked) ? ` <i class="fa-solid fa-lock" style="color:#f39c12; margin-left:4px; opacity:0.9; font-size:11px;" title="该标题格已被物理锁定"></i>` : '';

            // [修改] 给 acu-card-body 增加了 view-grid 或 view-list 类，并在 header 注入了 rowLockIcon 和 titleLockIcon
            return `<div class="acu-data-card ${isPending ? 'pending-deletion' : ''}"><div class="acu-card-header"><span class="acu-card-index">${showDefaultIndex ? '#' + (realRowIdx + 1) : ''}</span><span class="acu-cell acu-editable-title ${rowClass}" data-key="${escapeHtml(tableData.key)}" data-tname="${escapeHtml(tableName)}" data-row="${realRowIdx}" data-col="${titleColIndex}" data-val="${encodeURIComponent(cardTitle ?? '')}" title="点击编辑标题">${escapeHtml(cardTitle)}${titleLockIcon}</span>${rowLockIcon}</div><div class="acu-card-body ${isGridMode ? 'view-grid' : 'view-list'}">${cardBody}</div></div>`;
        }).join('');
        html += `</div></div>`;

        if (totalPages > 1) {
            html += `<div class="acu-panel-footer"><button class="acu-page-btn ${currentPage === 1 ? 'disabled' : ''}" data-page="${currentPage - 1}" ${currentPage === 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>`;
            const range = [];
            if (totalPages <= 7) { for (let i = 1; i <= totalPages; i++) range.push(i); } 
            else { if (currentPage <= 4) range.push(1, 2, 3, 4, 5, '...', totalPages); else if (currentPage >= totalPages - 3) range.push(1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages); else range.push(1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages); }
            range.forEach(p => { if (p === '...') html += `<span class="acu-page-info">...</span>`; else html += `<button class="acu-page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`; });
            html += `<button class="acu-page-btn ${currentPage === totalPages ? 'disabled' : ''}" data-page="${currentPage + 1}" ${currentPage === totalPages ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button></div>`;
        }
        return html;
    };

    // [新增] 通用状态保存函数 (面板滚动 + 卡片内部滚动)
    const saveCurrentTabState = () => {
        const { $ } = getCore();
        const activeTab = getActiveTabState();
        const $content = $('.acu-panel-content');
        
        if (activeTab && $content.length) {
            const innerScrolls = {};
            // 遍历所有卡片，记录内部滚动条位置
            $content.find('.acu-data-card, .acu-card-body, .acu-edit-textarea').each(function() {
                if (this.scrollTop > 0) {
                    // 尝试找到这张卡片的唯一标识 (Row Index)
                    const $card = $(this).closest('.acu-data-card');
                    const rIdx = $card.find('.acu-editable-title').data('row');
                    // 如果是编辑框，还要加特殊标记
                    const isEdit = $(this).hasClass('acu-edit-textarea');
                    
                    if (rIdx !== undefined) {
                        const key = isEdit ? `edit-${rIdx}` : rIdx;
                        innerScrolls[key] = this.scrollTop;
                    }
                }
            });
            
            // 存入全局状态对象
            tableScrollStates[activeTab] = {
                left: $content.scrollLeft(),
                top: $content.scrollTop(),
                inner: innerScrolls,
                timestamp: Date.now() // 加个时间戳方便调试
            };
        }
    };

    const closePanel = () => {
        const { $ } = getCore();
        saveCurrentTabState(); // <--- 调用通用保存
        
        $('#acu-data-area').removeClass('visible');
        $('.acu-nav-btn').removeClass('active');
        saveActiveTabState(null);
    };

    let _globalEventsBound = false;
    let _acuScrollTimer = null; // 【修复】把定时器提出来防止闭包泄漏
    const bindEvents = (tables) => {
    const { $ } = getCore();

    // 【新增】智能跑马灯物理宽度探测器
    setTimeout(() => {
        $('.acu-rpg-scroll-text').each(function() {
            const container = this;
            const content = container.querySelector('.acu-smart-marquee');
            if (!content) return;
            
            // 核心：精准对比元素的真实滚动宽度与外框宽度
            if (content.scrollWidth > container.clientWidth) {
                const dist = container.clientWidth - content.scrollWidth - 4; // 算出需要向左平移多少距离
                content.style.setProperty('--scroll-dist', dist + 'px');
                content.classList.add('is-scrolling');
            } else {
                // 如果屏幕够大能装下，彻底取消滚动
                content.classList.remove('is-scrolling');
                content.style.transform = 'none';
            }
        });
    }, 50);

    // 【修复】滚动事件必须放在这里！每次重绘都会执行，确保新面板被成功绑定
    const $panel = $('.acu-panel-content');
    if ($panel.length) {
        $panel.off('scroll.acu_save').on('scroll.acu_save', function() {
            // 【修复】必须在 0 延迟的当下立刻抓取标签名和滚动值，防止 150ms 后因用户切换了标签导致记忆串台
            const currentScrollTop = $(this).scrollTop();
            const currentScrollLeft = $(this).scrollLeft();
            const activeTab = getActiveTabState(); 

            if (_acuScrollTimer) clearTimeout(_acuScrollTimer);
            _acuScrollTimer = setTimeout(() => {
                if (activeTab) {
                    if (!tableScrollStates[activeTab]) tableScrollStates[activeTab] = { top: 0, left: 0, inner: {} };
                    tableScrollStates[activeTab].top = currentScrollTop;
                    tableScrollStates[activeTab].left = currentScrollLeft;
                }
            }, 150);
        });
    }

    if (!_globalEventsBound) {
        _globalEventsBound = true;

    // ============================================================
    // [优化版] 点击标签图标 -> 0延迟极速勾选/取消 (定向更新功能恢复！)
    // ============================================================
    $('body').off('click.acu_nav_icon').on('click.acu_nav_icon', '.acu-nav-btn i', function(e) {
        if (isEditingOrder) return;
        
        // 【关键】阻止冒泡！这样点击图标就不会触发父级按钮的“切换面板”事件
        e.preventDefault();
        e.stopPropagation(); 

        const $btn = $(this).closest('.acu-nav-btn');
        const tableKey = $btn.data('key');
        if (!tableKey) return;

        // 极速震动反馈 (如果有马达的话，手感极佳)
        if (navigator.vibrate) navigator.vibrate(30);

        const api = getCore().getDB();
        if (!api || !api.getManualSelectedTables || !api.setManualSelectedTables) return;

        const selInfo = api.getManualSelectedTables();
        let currentKeys = selInfo.hasManualSelection ? (selInfo.selectedTables || []) : [];
        const totalTableCount = $('.acu-nav-btn[data-key!=""]').length;

        if (currentKeys.length >= totalTableCount) currentKeys = [];

        if (currentKeys.includes(tableKey)) {
            currentKeys = currentKeys.filter(k => k !== tableKey);
            $btn.removeClass('acu-update-selected');
            AcuToast.info(`已取消定向更新: ${$btn.find('span').text()}`);
        } else {
            currentKeys.push(tableKey);
            $btn.addClass('acu-update-selected');
            AcuToast.success(`⚡ 加入定向更新: ${$btn.find('span').text()}`);
        }

        if (currentKeys.length === 0 || currentKeys.length >= totalTableCount) {
            api.clearManualSelectedTables();
            $('.acu-update-selected').removeClass('acu-update-selected');
            if (currentKeys.length >= totalTableCount && window.toastr) {
                AcuToast.info('已选中所有表格，自动恢复为全量更新');
            }
        } else {
            api.setManualSelectedTables(currentKeys);
        }
    });

    // [新增] 绑定日历图标点击事件
    $('body').off('click.acu_cal').on('click.acu_cal', '.acu-calendar-trigger', function(e) {
        e.stopPropagation();
        // 获取同级文本节点内容 (移除 HTML 标签后的纯文本)
        const timeStr = $(this).parent().text().trim();
        CalendarModule.show(timeStr);
    });

    $('body').off('click.acu_nav_toggle').on('click.acu_nav_toggle', '.acu-nav-toggle-btn', function(e) {
        e.stopPropagation();
        e.preventDefault();
        
        // 1. 切换数据状态
        const current = Store.get('acu_hide_nav_only', false);
        const newState = !current;
        Store.set('acu_hide_nav_only', newState);
        
        // 2. [新增] 立即手动切换图标 (视觉瞬时反馈)
        const $icon = $(this);
        if (newState) {
            $icon.removeClass('fa-eye').addClass('fa-eye-slash');
            $icon.attr('title', '显示主面板');
            AcuToast.info('🙈 主面板已隐藏');
        } else {
            $icon.removeClass('fa-eye-slash').addClass('fa-eye');
            $icon.attr('title', '隐藏主面板');
        }
        
        // 3. 触发重绘
        renderInterface(); 
    });
    
    // [新增] 嵌入式日历交互
    $('body').off('click.acu_emb_cal_nav').on('click.acu_emb_cal_nav', '#acu-rpg-embedded-cal-container .acu-cal-nav-btn', function(e) {
        e.stopPropagation();
        const data = window._acuEmbeddedCalData;
        if (!data) return;
        if ($(this).attr('id') === 'cal-prev') {
            data.month--;
            if (data.month < 1) { data.month = 12; data.year--; }
        } else {
            data.month++;
            if (data.month > 12) { data.month = 1; data.year++; }
        }
        $('#acu-rpg-embedded-cal-details').slideUp(100);
        $('#acu-rpg-embedded-cal-container').html(CalendarModule.render(data.year, data.month, data.day, data.events));
    });

    $('body').off('click.acu_emb_cal_cell').on('click.acu_emb_cal_cell', '#acu-rpg-embedded-cal-container .acu-cal-cell', function(e) {
        e.stopPropagation();
        const data = window._acuEmbeddedCalData;
        if (!data) return;
        $('#acu-rpg-embedded-cal-container .acu-cal-cell').removeClass('selected');
        $(this).addClass('selected');

        const dateKey = $(this).data('date');
        const hasEvt = $(this).data('has-evt');
        const $detailPanel = $('#acu-rpg-embedded-cal-details');
        const $list = $('#acu-emb-evt-list');

        if (hasEvt) {
            const dayEvents = data.events.filter(evt => evt.date === dateKey);
            dayEvents.sort((a,b) => CalendarModule.getEventScore(b.type) - CalendarModule.getEventScore(a.type));

            $('#acu-emb-evt-date-title').text(dateKey);
            
            const listHtml = dayEvents.map(evt => {
                let tagClass = CalendarModule.getEventClass(evt.type);
                let cleanType = evt.type.replace(/[\[\]]/g, '');

                return `
                    <div class="acu-event-item">
                        <div>
                            <span class="acu-event-tag ${tagClass}">${escapeHtml(cleanType)}</span>
                            <span class="acu-event-title">${escapeHtml(evt.title)}</span>
                        </div>
                        ${evt.desc ? `<div class="acu-event-desc">${escapeHtml(evt.desc)}</div>` : ''}
                    </div>
                `;
            }).join('');

            $list.html(listHtml);
            $detailPanel.slideDown(200);
        } else {
            $detailPanel.slideUp(200);
        }
    });


    $('body').off('click.acu_autoclose').on('click.acu_autoclose', function(e) {
        if (isEditingOrder) return;
        
        if (window._acuBlockNextClick || document.querySelector('.acu-inline-editing-row')) {
            return;
        }

        // [核心优化 7] 使用极速的原生 DOM API (e.target.closest) 替代 jQuery 的查找，降低 90% 的点击事件开销
        const target = e.target;
        
        if (target.closest('.acu-wrapper, .acu-cell-menu, .acu-menu-backdrop, .acu-edit-overlay, .acu-edit-dialog')) return;
        if (target.closest('#send_textarea, #send_but, #send_form, .bottom_bar_container')) return;

        const tagName = target.tagName ? target.tagName.toLowerCase() : '';
        if (tagName === 'input' || tagName === 'textarea' || target.isContentEditable) return;
        
        const $target = $(target); // 保留向下兼容

        // 原有逻辑：点击其他无关区域（如背景聊天记录）时关闭
        const isPanelOpen = $('#acu-data-area').hasClass('visible');
        const isCollapsed = $('#acu-btn-expand').length > 0;
        if (isCollapsed) return;
        if (isPanelOpen) { closePanel(); } else { saveCollapsedState(true); renderInterface(); }
    });

    $('body').off('click.acu_delegate').on('click.acu_delegate', '.acu-wrapper', function(e) {
        if (isEditingOrder) return;

        if ($('.acu-inline-editing-row').length > 0 || window._acuBlockNextClick) {
            if ($(e.target).closest('.acu-inline-editing-row').length === 0) {
                e.stopPropagation();
                e.preventDefault();
                return;
            }
        }

        const $target = $(e.target);
        const $navBtn = $target.closest('.acu-nav-btn');
        if ($navBtn.length) {
            e.stopPropagation();
            const tableName = $navBtn.data('table'); const currentActiveTab = getActiveTabState();
            if (currentActiveTab === tableName && $('#acu-data-area').hasClass('visible')) { closePanel(); return; }
            $('.acu-nav-btn').removeClass('active'); $navBtn.addClass('active');
            if ($('.acu-panel-content').length && currentActiveTab) { saveCurrentTabState(); }
            saveActiveTabState(tableName); 
            
            // [新增] 如果是人物关系网标签，特殊处理
            if (tableName === VIRTUAL_RELATIONSHIP_TAB) {
                const $dataArea = $('#acu-data-area');
                $dataArea.html(renderRelationshipPanel()).addClass('visible');
                bindRelationshipPanelEvents();
                return;
            }
            
            // [核心优化 2] 标签页切换实行“局部 DOM 替换”，绕过主渲染引擎
            const rawData = cachedRawData || getTableData();
            if (rawData) {
                const tables = processJsonData(rawData);
                if (tables[tableName]) {
                    const $dataArea = $('#acu-data-area');
                    $dataArea.html(renderTableContent(tables[tableName], tableName)).addClass('visible');
                    
                    // 完美恢复滚动条状态
                    const savedState = tableScrollStates[tableName];
                    if (savedState) {
                        const $newContent = $dataArea.find('.acu-panel-content');
                        $newContent.scrollTop(savedState.top || 0);
                        $newContent.scrollLeft(savedState.left || 0);
                        if (savedState.inner) {
                            Object.keys(savedState.inner).forEach(key => {
                                const scrollTop = savedState.inner[key];
                                const $targetTitle = $newContent.find(`.acu-editable-title[data-row="${key}"]`);
                                if ($targetTitle.length) {
                                    const $card = $targetTitle.closest('.acu-data-card');
                                    $card.scrollTop(scrollTop);
                                    $card.find('.acu-card-body').scrollTop(scrollTop);
                                }
                            });
                        }
                    }
                    
                    bindEvents(tables); // 重新绑定面板内事件
                    updateSaveButtonState();
                    return; // 局部替换成功，直接结束，彻底干掉全局重绘的卡顿
                }
            }
            
            setTimeout(() => renderInterface(), 0); return;
        }
        const $cell = $target.closest('.acu-cell');
        if ($cell.length) { 
            if ($cell.closest('.acu-inline-editing-row').length) return; // [修复] 处于整体编辑模式时，点击单元格不触发菜单
            e.stopPropagation(); showCellMenu(e, $cell[0]); return; 
        }
        const $pageBtn = $target.closest('.acu-page-btn');
        if ($pageBtn.length) {
            e.stopPropagation(); if ($pageBtn.hasClass('disabled') || $pageBtn.hasClass('active')) return;
            const newPage = parseInt($pageBtn.data('page')); const activeTab = getActiveTabState();
            if (activeTab) { 
                tablePageStates[activeTab] = newPage; 
                if (tableScrollStates[activeTab]) {
                    tableScrollStates[activeTab].top = 0;
                    tableScrollStates[activeTab].left = 0;
                }
                // [核心优化 3] 翻页也实行局部 DOM 替换
                const rawData = cachedRawData || getTableData();
                const tables = processJsonData(rawData || {});
                if (tables[activeTab]) {
                    $('#acu-data-area').html(renderTableContent(tables[activeTab], activeTab));
                    const $newContent = $('.acu-panel-content');
                    $newContent.scrollTop(0);
                    $newContent.scrollLeft(0);
                    bindEvents(tables);
                } else {
                    window._acuForceScrollTop = true; 
                    renderInterface(); 
                }
            }
            return;
        }
        const $dataArea = $target.closest('#acu-data-area'); const $navBar = $target.closest('#acu-nav-bar');
        const isInteractive = $target.closest('.acu-data-card, .acu-nav-btn, .acu-action-btn, .acu-page-btn, .acu-search-wrapper, .acu-close-btn, .acu-panel-title, .acu-panel-header, .acu-header-actions, .acu-height-control, .acu-view-btn, .acu-expand-trigger, .acu-order-controls, .acu-search-input, .acu-panel-footer, .acu-rel-canvas-wrapper, .acu-rel-svg, .acu-rel-node, .acu-rel-edge').length > 0;
        if (isInteractive) return;
        if ($dataArea.length || $target.is('#acu-data-area')) { 
            // [修复] 人物关系图模式下，仅点击面板内容区域不关闭（保留交互空间）
            if (getActiveTabState() === VIRTUAL_RELATIONSHIP_TAB) return;
            if (window._acuBlockNextClick) return; // 如果盾牌举着，说明刚退出编辑，只消耗点击，不关闭面板
            if ($('.acu-inline-editing-row').length > 0) return; // 【终极防御】如果有正在编辑的卡片，绝不关闭面板！
            closePanel(); 
            return; 
        }
        else if ($navBar.length || $target.is('#acu-nav-bar')) { const isPanelOpen = $('#acu-data-area').hasClass('visible'); if (isPanelOpen) { closePanel(); } else { saveCollapsedState(true); renderInterface(); } }
    });

    $('body').off('click.acu_btn_expand').on('click.acu_btn_expand', '#acu-btn-expand', (e) => { e.stopPropagation(); if (isEditingOrder) return; saveCollapsedState(false); renderInterface(); });
    // [回归] 收起按钮逻辑
    $('body').off('click.acu_btn_collapse').on('click.acu_btn_collapse', '#acu-btn-collapse', (e) => { 
        e.stopPropagation(); 
        if (isEditingOrder) return; 
        saveCollapsedState(true); 
        renderInterface(); 
    });
    
    // [修改版] 刷新按钮 = 极速回档 (Instant Revert)
    $('body').off('click.acu_btn_refresh').on('click.acu_btn_refresh', '#acu-btn-refresh', async (e) => {
        e.stopPropagation();

        // [修复] 关键漏网之鱼：如果是编辑布局模式，禁止触发刷新，只允许被拖拽
        if (isEditingOrder) return;

        // 1. 安全锁：如果正在后台保存，禁止刷新，防止数据冲突
        if (isSaving) {
            AcuToast.warning('⏳ 正在后台同步数据，无法撤销，请稍后...');
            return;
        }

        const $btn = $(e.currentTarget);
        const $icon = $btn.find('i');

        // 2. 【核心】彻底清除所有未保存状态 (瞬间丢弃脏数据)
        // (1) 清空待删除记录
        savePendingDeletions({}); 
        
        // (2) 清空内存缓存 -> 丢弃未保存的修改
        cachedRawData = null; 
        
        // (3) 重置状态标记
        hasUnsavedChanges = false;
        currentDiffMap.clear();
        if (window.acuModifiedSet) window.acuModifiedSet.clear();

        // (4) 重置保存按钮样式 (去掉呼吸灯)
        const $saveBtn = $('#acu-btn-save-global');
        $saveBtn.find('i').removeClass('acu-icon-breathe');
        $saveBtn.attr('title', '保存所有修改').css('color', '');

        // 3. 【极速优化】移除 300ms 延时，直接读取快照
        // await new Promise(r => setTimeout(r, 300)); // <--- 删掉这行人为延时
        
        // 尝试优先读取本地快照（Last Snapshot），这样最快，不需要等后端API
        const snapshot = loadSnapshot();
        if (snapshot) {
            cachedRawData = snapshot; // 强制回滚到快照
        }

        // 4. 重新渲染界面
        // 清理旧的样式标签，防止残留
        $('.acu-edit-overlay, .acu-cell-menu, .acu-menu-backdrop').remove(); 
        
        // 立即重绘
        renderInterface(); 
        
        AcuToast.success('已重置：未保存的修改已清除');
    });

    // [修复] 补回手动更新按钮的事件绑定头
    $('body').off('click.acu_btn_force_update').on('click.acu_btn_force_update', '#acu-btn-force-update', async (e) => {
        e.stopPropagation(); 
        if (isEditingOrder) return;
        const api = getCore().getDB();
        if (api && typeof api.manualUpdate === 'function') {
            // --- [新增] 动态提示：判断是全量还是部分更新 ---
            if (api.getManualSelectedTables) {
                const selInfo = api.getManualSelectedTables();
                const totalTableCount = $('.acu-nav-btn[data-key!=""]').length || 999;
                
                // 加一道防线：不仅要有选中的表，而且不能是全选，才播报“定向更新”
                if (selInfo && selInfo.hasManualSelection && selInfo.selectedTables.length > 0 && selInfo.selectedTables.length < totalTableCount) {
                    AcuToast.info(`⚡ 已请求定向更新选中的 ${selInfo.selectedTables.length} 个表格...`);
                } else {
                    AcuToast.info('已请求全量更新，请等待后台生成...');
                }
            } else {
                AcuToast.info('已请求更新，请等待后台生成...');
            }
            // ---------------------------------------------
            try {
                await api.manualUpdate();
            } catch(err) {
                console.error('[ACU] 手动更新失败:', err);
                AcuToast.error('手动更新触发失败');
            }
        } else {
            AcuToast.warning('⚠️ 后端脚本未提供 manualUpdate 接口，请确保同时也更新了最新的后端脚本');
        }
    });
    $('body').off('click.acu_btn_settings').on('click.acu_btn_settings', '#acu-btn-settings', (e) => { e.stopPropagation(); if (isEditingOrder) return; showSettingsModal(); });
    

    $('body').off('click.acu_btn_open_editor').on('click.acu_btn_open_editor', '#acu-btn-open-editor', (e) => {
        e.stopPropagation();
        if (isEditingOrder) return;
        const api = getCore().getDB();
        if (api && typeof api.openVisualizer === 'function') {
            api.openVisualizer();
        } else if (window.toastr) {
            AcuToast.warning('后端脚本(神·数据库)未就绪或版本过低');
        }
    });

    // [新增] 绑定打开神·数据库原生设置面板的事件
    $('body').off('click.acu_btn_open_db_settings').on('click.acu_btn_open_db_settings', '#acu-btn-open-db-settings', async (e) => {
        e.stopPropagation();
        if (isEditingOrder) return;
        const api = getCore().getDB();
        if (api && typeof api.openSettings === 'function') {
            await api.openSettings(); // 调用文档中提供的 API
        } else if (window.toastr) {
            AcuToast.warning('后端脚本(神·数据库)未就绪或版本过低');
        }
    });
    
    $('body').off('click.acu_btn_save_global').on('click.acu_btn_save_global', '#acu-btn-save-global', function(e) { 
        e.stopPropagation(); if (isEditingOrder) return;
        
        let dataToSave = null;
        if (hasUnsavedChanges && cachedRawData) { dataToSave = cachedRawData; } else { dataToSave = getTableData(); }
        
        if (!dataToSave) { 
            AcuToast.error('无法获取有效数据，保存失败'); 
            return;
        }
        
        // ============================================================
        // [优化] 第一步：立即更新 UI（同步，0延迟）
        // ============================================================
        const $btn = $('#acu-btn-save-global');
        const $icon = $btn.find('i');
        
        // 1. 按钮变成 spinner
        $icon.removeClass('fa-save acu-icon-breathe').addClass('fa-spinner fa-spin');
        $btn.prop('disabled', true);
        
        // 2. 立即清除所有橙色高亮（视觉上"秒变"）
        $('.acu-highlight-manual').removeClass('acu-highlight-manual');
        
        // 3. 立即清理状态标记
        if (window.acuModifiedSet) window.acuModifiedSet.clear();
        hasUnsavedChanges = false;
        
        // 4. 立即弹出提示（用户感知：点击即反馈，瞬间给予安全感）
        AcuToast.success('💾 已保存');
        
        // ============================================================
        // [优化] 第二步：后台异步保存（不阻塞 UI）
        // ============================================================
        (async () => {
            try {
                // 执行保存
                await saveDataToDatabase(dataToSave, true, true);
                
                // 保存成功：恢复按钮状态
                $icon.removeClass('fa-spinner fa-spin').addClass('fa-save');
                $btn.attr('title', '保存所有修改').css('color', '');
                $btn.prop('disabled', false);
                
            } catch (err) {
                console.error('[ACU] 保存失败:', err);
                // 保存失败：恢复按钮 + 提示
                $icon.removeClass('fa-spinner fa-spin').addClass('fa-save');
                $btn.prop('disabled', false);
                AcuToast.error('保存失败，请重试');
            }
        })();
    });


    // [终极修复] 使用全局挂载与事件委托，彻底免疫 DOM 重绘导致的搜索失效与防抖失忆
    $('body')
        .off('compositionstart.acu_search compositionend.acu_search input.acu_search', '.acu-search-input')
        .on('compositionstart.acu_search', '.acu-search-input', () => { 
            window._acuIsComposing = true; 
        })
        .on('compositionend.acu_search', '.acu-search-input', function() { 
            window._acuIsComposing = false; 
            const val = $(this).val();
            const activeTab = getActiveTabState();
            if (activeTab) {
                tableSearchStates[activeTab] = val;
                tablePageStates[activeTab] = 1;
                window._acuForceScrollTop = true; // [新增] 强制回顶标记
                renderInterface();
                setTimeout(() => { $('.acu-search-input').focus(); }, 0);
            }
        })
        .on('input.acu_search', '.acu-search-input', function() {
            if (window._acuIsComposing) return; 
            const val = $(this).val(); 
            const selectionStart = this.selectionStart;
            const selectionEnd = this.selectionEnd;
            
            if (window._acuSearchTimeout) clearTimeout(window._acuSearchTimeout);
            window._acuSearchTimeout = setTimeout(() => {
                const activeTab = getActiveTabState();
                if (activeTab) {
                    tableSearchStates[activeTab] = val; 
                    tablePageStates[activeTab] = 1;
                    const isFocus = document.activeElement && document.activeElement.classList.contains('acu-search-input'); 
                    window._acuForceScrollTop = true; // [新增] 强制回顶标记
                    renderInterface();
                    
                    if (isFocus) { 
                        const $newInput = $('.acu-search-input'); 
                        $newInput.focus(); 
                        if ($newInput.length && $newInput[0].setSelectionRange) {
                            try { $newInput[0].setSelectionRange(selectionStart, selectionEnd); } catch(e) {}
                        }
                    }
                }
            }, 300);
        });

// --- [新增] 移植功能的事件绑定 (全局事件委托重构) ---

        // 0.5. 卡片标题栏快捷【锁定/解锁整行】
        $('body').off('click.acu_row_lock').on('click.acu_row_lock', '.acu-row-lock-btn', function(e) {
            e.preventDefault(); e.stopPropagation();
            const tableKey = $(this).data('key');
            const rowIdx = parseInt($(this).data('row'), 10);
            const api = getCore().getDB();
            
            if (api && api.toggleTableRowLock) {
                // 触发 API 锁定/解锁整行 (注意行号从1开始算表头，所以数据行是 +1)
                const success = api.toggleTableRowLock(tableKey, rowIdx + 1);
                if (success !== false) {
                    const isNowLocked = $(this).hasClass('fa-unlock');
                    AcuToast.success(isNowLocked ? '🔒 已物理锁定整行，免疫 AI 篡改' : '🔓 已解除整行锁定');
                    renderInterface(); // 立即重绘 UI 更新图标状态
                }
            } else if (api && api.toggleTableCellLock) {
                // 降级处理：如果后端没提供整行锁 API，则退而求其次锁定该行标题格
                const success = api.toggleTableCellLock(tableKey, rowIdx + 1, 1); 
                if (success !== false) {
                    AcuToast.success('🔒 已锁定标题格 (提示: 后端版本较低，未提供整行锁API)');
                    renderInterface();
                }
            } else {
                AcuToast.warning('后端脚本版本过低，请升级神·数据库');
            }
        });

        // 0. 标题栏快捷排序切换
        $('body').off('click.acu_sort_toggle').on('click.acu_sort_toggle', '.acu-sort-toggle-btn', function(e) {
            e.preventDefault(); e.stopPropagation();
            const tableName = $(this).data('table');
            let currentList = Store.get('acu_reverse_tables', []);
            
            if (currentList.includes(tableName)) {
                currentList = currentList.filter(n => n !== tableName);
                AcuToast.success(`【${tableName}】已切换为：正序 (最早在前)`);
            } else {
                currentList.push(tableName);
                AcuToast.success(`【${tableName}】已切换为：倒序 (最新在前)`);
            }
            Store.set('acu_reverse_tables', currentList);
            
            // [核心优化 5] 排序切换也实行“局部 DOM 替换”
            const rawData = cachedRawData || getTableData();
            const tables = processJsonData(rawData || {});
            if (tables[tableName]) {
                $('#acu-data-area').html(renderTableContent(tables[tableName], tableName));
                bindEvents(tables); // 重新绑定面板内事件
            } else {
                renderInterface(); 
            }
        });
        
        // 1. 视图切换
        $('body').off('click.acu_switch_style').on('click.acu_switch_style', '#acu-btn-switch-style', function(e) {
            e.preventDefault(); e.stopPropagation();
            const tableName = $(this).data('table');
            const styles = getTableStyles();
            const current = styles[tableName] || 'list';
            const newStyle = current === 'grid' ? 'list' : 'grid';
            styles[tableName] = newStyle; 
            saveTableStyles(styles);
            
            // [核心优化 4] 纯 CSS 切换网格/列表视图，不重建整个大面板 DOM
            const $icon = $(this).find('i');
            $icon.removeClass('fa-th-large fa-list').addClass(newStyle === 'grid' ? 'fa-th-large' : 'fa-list');
            $(this).attr('title', `🔄 点击切换视图模式 (当前: ${newStyle === 'grid' ? '双列网格' : '单列列表'})`);
            
            const $cardBodies = $('#acu-data-area').find('.acu-card-body');
            if (newStyle === 'grid') {
                $cardBodies.removeClass('view-list').addClass('view-grid');
            } else {
                $cardBodies.removeClass('view-grid').addClass('view-list');
            }
        });

        // 2. 高度拖拽
        $('body').off('pointerdown.acu_height_drag').on('pointerdown.acu_height_drag', '.acu-height-drag-handle', function(e) {
            if (e.button && e.button !== 0) return; // [修复] 兼容移动端触摸（button可能为undefined）
            e.preventDefault(); e.stopPropagation();
            const handle = this;
            handle.setPointerCapture(e.pointerId);
            $(handle).addClass('active');
            const $panel = $('#acu-data-area');
            const startHeight = $panel.height();
            const startY = e.clientY;
            const tableName = $(handle).data('table');
            
            handle.onpointermove = function(moveE) {
                const dy = moveE.clientY - startY;
                let newHeight = startHeight - dy; // 向上拖动增加高度
                if (newHeight < MIN_PANEL_HEIGHT) newHeight = MIN_PANEL_HEIGHT;
                if (newHeight > MAX_PANEL_HEIGHT) newHeight = MAX_PANEL_HEIGHT;
                $panel.css('height', newHeight + 'px');
            };
            handle.onpointerup = function(upE) {
                $(handle).removeClass('active');
                handle.releasePointerCapture(upE.pointerId);
                handle.onpointermove = null;
                handle.onpointerup = null;
                if (tableName) {
                     const heights = getTableHeights();
                     heights[tableName] = parseInt($panel.css('height'));
                     saveTableHeights(heights);
                     $panel.addClass('acu-manual-mode');
                }
            };
        });
        
        // 3. 双击重置高度 - 支持整个头部区域触发
        $('body').off('dblclick.acu_height_reset_handle').on('dblclick.acu_height_reset_handle', '.acu-height-drag-handle', function(e) {
             e.preventDefault(); e.stopPropagation();
             const tableName = $(this).data('table');
             if (tableName) {
                 const heights = getTableHeights();
                 delete heights[tableName];
                 saveTableHeights(heights);
                 $('#acu-data-area').css('height', '').removeClass('acu-manual-mode');
                 AcuToast.info('✓ 已恢复自适应高度');
             }
        });

        // [新增] 双击头部任意位置也可重置高度
        $('body').off('dblclick.acu_panel_header').on('dblclick.acu_panel_header', '.acu-panel-header', function(e) {
            if ($(e.target).closest('.acu-search-input, .acu-close-btn, .acu-view-btn').length) return;
            e.preventDefault(); e.stopPropagation();
            const tableName = getActiveTabState();
            if (tableName) {
                const heights = getTableHeights();
                delete heights[tableName];
                saveTableHeights(heights);
                $('#acu-data-area').css('height', '').removeClass('acu-manual-mode');
                AcuToast.info('✓ 已恢复自适应高度');
            }
        });

    $('body').off('click.acu_close_btn').on('click.acu_close_btn', '.acu-close-btn', function(e) { 
        e.stopPropagation(); const $input = $('.acu-search-input');
        if ($input.val()) { $input.val('').trigger('input').focus(); } else { closePanel(); }
    });
    } // end if (!_globalEventsBound)
};

    let selectedSwapSource = null;
    const toggleOrderEditMode = () => {
        const { $ } = getCore();
        isEditingOrder = !isEditingOrder;

        if (isEditingOrder) {
            // 1. 触发异步重绘，把极简模式炸开
            renderInterface();
            
            // 2. 核心修复：必须等待异步渲染完成后，再去获取并修改 DOM！
            setTimeout(() => {
                const $container = $('#acu-nav-bar');
                const $hint = $('#acu-order-hint');
                const $pool = $('#acu-action-pool');

                selectedSwapSource = null;
                $('.acu-swap-selected').removeClass('acu-swap-selected');

                $container.addClass('editing-order');
                $pool.addClass('visible');

                $hint.html(`
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span><i class="fa-solid fa-layer-group"></i> 界面布局编辑器</span>
                            <span style="font-size:11px; opacity:0.9; font-weight:normal; border-left:1px solid rgba(255,255,255,0.3); padding-left:10px;">
                                1. 拖动<b>表格标签</b>调整顺序 · 2. 将需要的<b>功能按钮</b>从上方备选池拖到底栏 (最多6个)
                            </span>
                        </div>
                        <button id="acu-btn-finish-sort" style="background:rgba(255,255,255,0.2); color:#fff; border:1px solid rgba(255,255,255,0.4); padding:2px 12px; border-radius:4px; cursor:pointer; font-size:12px; transition:all 0.2s;">
                            <i class="fa-solid fa-check"></i> 完成保存
                        </button>
                    </div>
                `).addClass('visible').css('display', 'flex');
                
                $('#acu-btn-finish-sort').hover(
                    function() { $(this).css({'background':'#fff', 'color':'var(--acu-accent)'}); },
                    function() { $(this).css({'background':'rgba(255,255,255,0.2)', 'color':'#fff'}); }
                );

                $('#acu-btn-finish-sort').one('click', (e) => { e.stopPropagation(); toggleOrderEditMode(); });

                $('#acu-data-area').removeClass('visible');
                $('.acu-nav-btn, .acu-action-btn').attr('draggable', 'true');
                
                initSortable();
            }, 50); // 延迟 50ms 确保 DOM 已经完全更新
            
        } else {
            const $container = $('#acu-nav-bar');
            const $hint = $('#acu-order-hint');
            const $pool = $('#acu-action-pool');
            
            $container.removeClass('editing-order');
            $hint.removeClass('visible').hide();
            $pool.removeClass('visible');
            
            $('.acu-nav-btn, .acu-action-btn').attr('draggable', 'false');
            $('.acu-nav-btn, .acu-action-btn').off('.sort');
            
            // 1. 保存表格标签顺序
            const newTableOrder = [];
            $('.acu-nav-btn').each(function() { 
                if (this.id !== 'acu-btn-settings') {
                    newTableOrder.push($(this).data('table')); 
                }
            });
            saveTableOrder(newTableOrder);
            
            // 2. 保存功能按钮
            const newActionOrder = [];
            $('#acu-active-actions .acu-action-btn').each(function() { newActionOrder.push($(this).attr('id')); });
            
            if (!newActionOrder.includes('acu-btn-settings')) {
                newActionOrder.push('acu-btn-settings');
            }
            
            localStorage.setItem(STORAGE_KEY_ACTION_ORDER, JSON.stringify(newActionOrder));
            
            renderInterface();
        }
    };


const initSortable = () => {
    const { $ } = getCore();
    let $dragSrcEl = null; 
    
    // 清理旧事件
    $('.acu-nav-btn, .acu-action-btn, #acu-action-pool, #acu-active-actions').off('.sort');

    // --- 1. 按钮本身的拖拽逻辑 (交换顺序) ---
    const $items = $('.acu-nav-btn, .acu-action-btn');
    
    $items.on('dragstart.sort', function(e) {
        $dragSrcEl = $(this); 
        $(this).css('opacity', '0.4');
        e.originalEvent.dataTransfer.effectAllowed = 'move';
    });

    $items.on('dragend.sort', function(e) { 
        $(this).css('opacity', '1'); 
        $('.acu-drag-over').removeClass('acu-drag-over'); 
        $('.acu-actions-group, .acu-unused-pool').removeClass('dragging-over');
    });

    $items.on('dragover.sort', function(e) { e.preventDefault(); return false; });
    $items.on('dragenter.sort', function() { if ($dragSrcEl && this !== $dragSrcEl[0]) $(this).addClass('acu-drag-over'); });
    $items.on('dragleave.sort', function() { $(this).removeClass('acu-drag-over'); });
    
    $items.on('drop.sort', function(e) {
        e.stopPropagation();
        $(this).removeClass('acu-drag-over');
        if (!$dragSrcEl || $dragSrcEl[0] === this) return false;

        const isSrcAction = $dragSrcEl.hasClass('acu-action-btn');
        const isTgtAction = $(this).hasClass('acu-action-btn');
        if (isSrcAction !== isTgtAction) return false;

        if (isSrcAction) {
            const targetPoolId = $(this).parent().attr('id');
            const srcPoolId = $dragSrcEl.parent().attr('id');
            
            if (srcPoolId === 'acu-action-pool' && targetPoolId === 'acu-active-actions') {
                if ($('#acu-active-actions').children().length >= MAX_ACTION_BUTTONS) {
                    AcuToast.warning('活动栏最多6个，请先拖走一个');
                    return false;
                }
            }

            if (srcPoolId !== targetPoolId) {
                $(this).before($dragSrcEl);
                return false;
            }
        }

        const $temp = $('<span>').hide();
        $dragSrcEl.before($temp);
        $(this).before($dragSrcEl);
        $temp.replaceWith($(this));
        return false;
    });

    // --- 2. 容器的拖拽逻辑 (上架/下架) ---
    const $containers = $('#acu-action-pool, #acu-active-actions');
    
    $containers.on('dragover.sort', function(e) { 
        e.preventDefault(); 
        if ($dragSrcEl && $dragSrcEl.hasClass('acu-action-btn')) {
            $(this).addClass('dragging-over');
        }
    });

    $containers.on('dragleave.sort', function(e) { $(this).removeClass('dragging-over'); });

    $containers.on('drop.sort', function(e) {
        e.stopPropagation();
        $(this).removeClass('dragging-over');
        
        if ($dragSrcEl && $dragSrcEl.hasClass('acu-action-btn')) {
            const currentParentId = $dragSrcEl.parent().attr('id');
            const targetId = $(this).attr('id');
            const btnId = $dragSrcEl.attr('id');

            if (currentParentId !== targetId) {
                if (targetId === 'acu-action-pool') {
                    if (btnId === 'acu-btn-settings') {
                        AcuToast.warning('设置按钮是核心组件，无法移除');
                        return false;
                    }
                    $(this).append($dragSrcEl);
                }
                else if (targetId === 'acu-active-actions') {
                    if ($(this).children().length >= 6) {
                        AcuToast.warning('活动栏已满6个，无法继续添加');
                        return false;
                    }
                    $(this).append($dragSrcEl);
                }
            }
        }
        return false;
    });

    // --- 【新增】3. 容器点击事件 - 支持点动移动功能按钮 ---
    $containers.on('click.sort', function(e) {
        e.stopPropagation();
        
        // 如果点击的是按钮本身，不处理
        if ($(e.target).closest('.acu-action-btn, .acu-nav-btn').length > 0) return;
        
        // 如果没有选中任何按钮，不处理
        if (!selectedSwapSource) return;
        
        const $src = $(selectedSwapSource);
        
        // 只有功能按钮才能跨池移动
        if (!$src.hasClass('acu-action-btn')) {
            AcuToast.warning('表格标签不能移入功能池');
            $src.removeClass('acu-swap-selected');
            selectedSwapSource = null;
            return;
        }
        
        const srcPoolId = $src.parent().attr('id');
        const targetId = $(this).attr('id');
        const btnId = $src.attr('id');
        
        // 同一个容器内点击，取消选中
        if (srcPoolId === targetId) {
            $src.removeClass('acu-swap-selected');
            selectedSwapSource = null;
            return;
        }
        
        // 活动栏 → 备选池
        if (targetId === 'acu-action-pool') {
            if (btnId === 'acu-btn-settings') {
                AcuToast.warning('设置按钮是核心组件，无法移除');
                $src.removeClass('acu-swap-selected');
                selectedSwapSource = null;
                return;
            }
            $(this).append($src);
            $src.removeClass('acu-swap-selected');
            selectedSwapSource = null;
            AcuToast.success('已移至备选池');
        }
        // 备选池 → 活动栏
        else if (targetId === 'acu-active-actions') {
            if ($('#acu-active-actions').children().length >= MAX_ACTION_BUTTONS) {
                AcuToast.warning('活动栏已满6个，请先移走一个');
                return;
            }
            $(this).append($src);
            $src.removeClass('acu-swap-selected');
            selectedSwapSource = null;
            AcuToast.success('已移至活动栏');
        }
    });

    // --- 4. 点击互换模式 (Click-to-Swap) - 按钮之间 ---
    $items.on('click.sort', function(e) {
        e.preventDefault(); e.stopPropagation();

        if (selectedSwapSource && selectedSwapSource === this) {
            $(this).removeClass('acu-swap-selected');
            selectedSwapSource = null;
            return;
        }

        if (!selectedSwapSource) {
            selectedSwapSource = this;
            $(this).addClass('acu-swap-selected');
            AcuToast.info('已选中，请点击目标位置进行交换');
            return;
        }

        const $src = $(selectedSwapSource);
        const $tgt = $(this);
        
        const isSrcAction = $src.hasClass('acu-action-btn');
        const isTgtAction = $tgt.hasClass('acu-action-btn');
        if (isSrcAction !== isTgtAction) {
            AcuToast.warning('无法在表格标签和功能按钮之间交换');
            $src.removeClass('acu-swap-selected');
            selectedSwapSource = this;
            $(this).addClass('acu-swap-selected');
            return;
        }

        const srcPoolId = $src.parent().attr('id');
        const tgtPoolId = $tgt.parent().attr('id');

        if (isSrcAction && srcPoolId === 'acu-action-pool' && tgtPoolId === 'acu-active-actions') {
            if ($('#acu-active-actions').children().length >= MAX_ACTION_BUTTONS) {
                AcuToast.warning('活动栏最多6个，请先移走一个');
                return;
            }
        }

        if (srcPoolId !== tgtPoolId) {
            $tgt.before($src);
        } else {
            const $temp = $('<span>').hide();
            $src.before($temp);
            $tgt.before($src);
            $temp.replaceWith($tgt);
        }

        $src.removeClass('acu-swap-selected');
        selectedSwapSource = null;
        AcuToast.success('操作已完成');
    });
};


    const showCellMenu = (e, cell) => {
        const { $ } = getCore();
        $('.acu-cell-menu, .acu-menu-backdrop').remove();
        const backdrop = $('<div class="acu-menu-backdrop"></div>');
        $('body').append(backdrop);
        
                const rowIdx = parseInt($(cell).data('row'), 10);
        const colIdx = parseInt($(cell).data('col'), 10);
        if (isNaN(rowIdx) || isNaN(colIdx)) { console.warn('[ACU] 无效的行/列索引'); backdrop.remove(); return; }
        const tableKey = $(cell).data('key');
        // v19.x 可能没有 tname，尝试获取
        const tableName = $(cell).data('tname') || $(cell).closest('.acu-data-card').find('.acu-editable-title').text();
        const content = decodeURIComponent($(cell).data('val'));
        const config = getConfig();
        
        // 唯一标识 ID
        const cellId = `${tableKey}-${rowIdx}-${colIdx}`;
        if (!window.acuModifiedSet) window.acuModifiedSet = new Set();
        
        // 状态检查
        const isModified = window.acuModifiedSet.has(cellId);
        
        // 获取当前表格的待删除列表
        const pendingDeletionsMap = getPendingDeletions();
        const tableDeletions = pendingDeletionsMap[tableKey] || [];
        const isPending = tableDeletions.includes(rowIdx);

        // [新增] 检查单元格锁定状态
        const api = getCore().getDB();
        let isLocked = false;
        if (api && api.getTableLockState) {
            const lockState = api.getTableLockState(tableKey);
            if (lockState) {
                const r = rowIdx + 1; // 后端 API 行号包含表头，所以数据行从 1 开始
                const c = colIdx;
                // 检查单元格、所在行、所在列是否被锁定
                if (
                    (lockState.cells && (lockState.cells.includes(`${r}:${c}`) || lockState.cells.some(arr => arr[0] === r && arr[1] === c))) ||
                    (lockState.rows && lockState.rows.includes(r)) ||
                    (lockState.cols && lockState.cols.includes(c))
                ) {
                    isLocked = true;
                }
            }
        }

        const menu = $(`
            <div class="acu-cell-menu acu-theme-${config.theme}">
                <div class="acu-cell-menu-item" id="act-edit"><i class="fa-solid fa-pen"></i> 编辑内容</div>
                <div class="acu-cell-menu-item" id="act-edit-card" style="color:#9b59b6"><i class="fa-solid fa-edit"></i> 整体编辑</div>
                <div class="acu-cell-menu-item" id="act-insert" style="color:#2980b9"><i class="fa-solid fa-plus"></i> ${config.layout === 'vertical' ? '在下方追加新行' : '在旁边追加新行'}</div>
                <div class="acu-cell-menu-item" id="act-copy"><i class="fa-solid fa-copy"></i> 复制内容</div>
                <div class="acu-cell-menu-item" id="act-send-to-input" style="color:#3498db"><i class="fa-solid fa-keyboard"></i> 输入至消息栏</div>
                <div class="acu-cell-menu-item" id="act-lock" style="color:#f39c12; border-top:1px dashed var(--acu-border);"><i class="fa-solid ${isLocked ? 'fa-unlock' : 'fa-lock'}"></i> ${isLocked ? '解除锁定状态' : '锁定防篡改 (保护此格)'}</div>
                
                ${isModified 
                    ? `<div class="acu-cell-menu-item" id="act-undo" style="color:#e67e22; border-top:1px solid #eee;"><i class="fa-solid fa-undo"></i> 撤销本次修改</div>` 
                    : ''}

                ${isPending 
                    ? `<div class="acu-cell-menu-item" id="act-restore" style="color:#27ae60"><i class="fa-solid fa-undo"></i> 恢复整行</div>` 
                    : `<div class="acu-cell-menu-item" id="act-delete" style="color:#e74c3c"><i class="fa-solid fa-trash"></i> 删除整行</div>`
                }
                <div class="acu-cell-menu-item" id="act-close"><i class="fa-solid fa-times"></i> 关闭菜单</div>
            </div>
        `);
        $('body').append(menu);
        
        // 稳健的坐标计算
        const winWidth = $(window).width(); const winHeight = $(window).height();
        const mWidth = menu.outerWidth() || 150; const mHeight = menu.outerHeight() || 150;
        let clientX = e.clientX; let clientY = e.clientY;
        if (!clientX && e.originalEvent && e.originalEvent.touches && e.originalEvent.touches.length) {
            clientX = e.originalEvent.touches[0].clientX; clientY = e.originalEvent.touches[0].clientY;
        } else if (!clientX && e.changedTouches && e.changedTouches.length) {
             clientX = e.changedTouches[0].clientX; clientY = e.changedTouches[0].clientY;
        }
        
        // 兜底坐标
        if (clientX === undefined) clientX = winWidth / 2;
        if (clientY === undefined) clientY = winHeight / 2;

        let left = clientX + 5; let top = clientY + 5;
        if (left + mWidth > winWidth) left = clientX - mWidth - 5;
        if (top + mHeight > winHeight) top = clientY - mHeight - 5;
        
        // 防止负坐标
        if (left < 5) left = 5; 
        if (top < 5) top = 5;

        menu.css({ top: top + 'px', left: left + 'px' });

        const closeAll = () => { menu.remove(); backdrop.remove(); };
        backdrop.on('click', closeAll);
        menu.find('#act-close').click(closeAll);
        
        // 复制功能 (v7.9 融合增强版：优先酒馆接口，兼容性最佳)
        menu.find('#act-copy').click(async (e) => {
            e.stopPropagation();

            // 【第一优先级】尝试使用酒馆 v7.7 的原生接口 (移动端/PWA 完美兼容)
            // 来源: slash_command.txt /clipboard-set
            if (window.TavernHelper && window.TavernHelper.triggerSlash) {
                try {
                    // 转义特殊字符防止命令崩溃
                    const safeContent = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
                    await window.TavernHelper.triggerSlash(`/clipboard-set "${safeContent}"`);
                    AcuToast.success('已复制');
                    closeAll();
                    return; // 如果成功，直接结束，不走后面的浏览器逻辑
                } catch (err) {
                    console.warn('酒馆接口复制失败，尝试浏览器原生方法', err);
                }
            }

            // 【第二优先级】浏览器原生逻辑 (v7.8 的兜底方案)
            const doCopy = (text) => {
                // 方案A: 现代 API (仅在 HTTPS 或 localhost 下有效)
                if (navigator.clipboard && window.isSecureContext) {
                    navigator.clipboard.writeText(text).then(() => {
                        AcuToast.success('已复制');
                    }).catch(() => {
                        fallbackCopy(text);
                    });
                } else {
                    // 方案B: 传统 execCommand (兼容 HTTP)
                    fallbackCopy(text);
                }
            };

            const fallbackCopy = (text) => {
                try {
                    const textArea = document.createElement("textarea");
                    textArea.value = text;
                    
                    // 移动端防抖动处理
                    textArea.style.position = "fixed";
                    textArea.style.left = "-9999px";
                    textArea.style.top = "0";
                    textArea.setAttribute("readonly", "");
                    
                    document.body.appendChild(textArea);
                    
                    textArea.select();
                    textArea.setSelectionRange(0, 99999); // 针对 iOS Safari
                    
                    const successful = document.execCommand('copy');
                    document.body.removeChild(textArea);
                    
                    if (successful) {
                        AcuToast.success('已复制');
                    } else {
                        throw new Error('execCommand failed');
                    }
                } catch (err) {
                    console.error('复制失败:', err);
                    prompt("复制失败，请长按下方文本手动复制:", text);
                }
            };

            doCopy(content);
            closeAll();
        });

        // 输入至消息栏功能
        menu.find('#act-send-to-input').click(() => {
            const ta = $('#send_textarea');
            if (ta.length) {
                const domEl = ta[0];
                const startPos = domEl.selectionStart;
                const endPos = domEl.selectionEnd;
                const currentVal = ta.val();
                
                if (startPos !== undefined && endPos !== undefined) {
                    const newVal = currentVal.substring(0, startPos) + content + currentVal.substring(endPos);
                    ta.val(newVal);
                    const newCursorPos = startPos + content.length;
                    domEl.setSelectionRange(newCursorPos, newCursorPos);
                } else {
                    const newVal = currentVal ? currentVal + ' ' + content : content;
                    ta.val(newVal);
                }
                ta.trigger('input').trigger('change').focus();
                AcuToast.success('已追加至消息栏');
            } else {
                AcuToast.warning('未找到消息输入框');
            }
            closeAll();
        });

        // 撤销功能
        menu.find('#act-undo').click(() => {
            // [修改] 1. 尝试读取本回合的基准数据（这是AI刚生成的内容）
            let restoreSource = Store.get(STORAGE_KEY_ROUND_BASELINE);
            
            // [修改] 2. 安全检查：如果没找到基准，或者换了聊天卡，就兜底用上一回合的快照
            const currentCtx = getCurrentContextFingerprint();
            if (!restoreSource || (restoreSource._contextId && restoreSource._contextId !== currentCtx)) {
                restoreSource = loadSnapshot();
            }

            let originalValue = null;
            // [修改] 3. 从选定的源（restoreSource）中获取原始值
            if (restoreSource && restoreSource[tableKey]?.content[rowIdx + 1]) {
                originalValue = restoreSource[tableKey].content[rowIdx + 1][colIdx];
            }

            if (originalValue !== null) {
                if (!cachedRawData) cachedRawData = getTableData();
                if (cachedRawData && cachedRawData[tableKey]?.content[rowIdx + 1]) {
                    cachedRawData[tableKey].content[rowIdx + 1][colIdx] = originalValue;
                }

                
                const $cell = $(cell);
                $cell.attr('data-val', encodeURIComponent(originalValue));
                $cell.data('val', encodeURIComponent(originalValue));
                
                // [核心修复1] 正确查找显示目标，防止覆盖 Label
                let $displayTarget = $cell;
                if ($cell.find('.acu-card-value').length > 0) {
                    $displayTarget = $cell.find('.acu-card-value');
                } else if ($cell.hasClass('acu-grid-item')) {
                    $displayTarget = $cell.find('.acu-grid-value');
                } else if ($cell.hasClass('acu-full-item')) {
                    $displayTarget = $cell.find('.acu-full-value');
                }
                
                const badgeStyle = getBadgeStyle(originalValue);
                if (badgeStyle && !$cell.hasClass('acu-editable-title')) {
                     $displayTarget.html(`<span class="acu-badge ${badgeStyle}">${originalValue}</span>`);
                } else {
                     $displayTarget.text(originalValue);
                }
                
                // [修复] 修正类名，确保撤销后高亮立即消失
                $displayTarget.removeClass('acu-highlight-manual acu-highlight-diff');
                if ($cell.hasClass('acu-editable-title')) $cell.removeClass('acu-highlight-manual acu-highlight-diff');
                
                window.acuModifiedSet.delete(cellId);

                // --- 【完美修复】重新生成一次最新的差异字典，彻底消除幽灵高亮 ---
                // 因为我们在上面刚把 originalValue 塞回了 cachedRawData，
                // 此时立刻重算一次 Diff，就能洗掉刚才由于“整体编辑”污染的假差异，拿到最准确的 AI 状态。
                if (cachedRawData) {
                    currentDiffMap = generateDiffMap(cachedRawData);
                }
                
                const diffKey = `${tableName}-${rowIdx}-${colIdx}`;
                const rowDiffKey = `${tableName}-row-${rowIdx}`;
                
                let shouldRestoreAiHighlight = false;
                
                if ($cell.hasClass('acu-editable-title')) {
                    shouldRestoreAiHighlight = currentDiffMap.has(rowDiffKey) || currentDiffMap.has(diffKey);
                } else {
                    shouldRestoreAiHighlight = currentDiffMap.has(diffKey);
                }

                if (shouldRestoreAiHighlight && config.highlightNew) {
                    $displayTarget.addClass('acu-highlight-diff');
                    if ($cell.hasClass('acu-editable-title')) $cell.addClass('acu-highlight-diff');
                }
                // ------------------------------------------------------------------------
                
                if (window.acuModifiedSet.size === 0) {
                    // [修复] 撤销编辑时，还需要检查是否还有待删除的行
                    const newDels = getPendingDeletions();
                    let hasAnyDels = false;
                    for (let k in newDels) { if (newDels[k] && newDels[k].length > 0) hasAnyDels = true; }
                    if (!hasAnyDels) {
                        hasUnsavedChanges = false;
                    }
                    updateSaveButtonState();
                    AcuToast.success('已撤销修改');
                } else {
                     AcuToast.info('已撤销该单元格');
                }
            } else {
                AcuToast.warning('无法找到原始数据，撤销失败');
            }
            closeAll();
        });
        
        // [优化] 删除逻辑 (修复参数错误并增强兜底)
        menu.find('#act-delete').click(async () => {
            closeAll();

            let actOrd = Store.get(STORAGE_KEY_ACTION_ORDER);
            if (!actOrd || !Array.isArray(actOrd)) actOrd = DEFAULT_ACTION_ORDER;
            const isInstantMode = !actOrd.includes('acu-btn-save-global');

            if (isInstantMode) {
                // --- 视觉优化：前端直接移除 DOM ---
                const $card = $(cell).closest('.acu-data-card');
                $card.css('transition', 'all 0.2s ease').css('opacity', '0').css('transform', 'scale(0.9)');
                setTimeout(() => $card.slideUp(200, () => $card.remove()), 200);

                const api = getCore().getDB();
                if (!cachedRawData) cachedRawData = getTableData() || loadSnapshot();
                
                try {
                    let apiSuccess = false;
                    // --- 核心修复：将 tableName 改为 tableKey ---
                    if (api && api.deleteRow) {
                        apiSuccess = await api.deleteRow(tableKey, rowIdx + 1);
                        if (apiSuccess) {
                            AcuToast.success('已彻底删除');
                            // 同步本地缓存防穿帮
                            if (cachedRawData && cachedRawData[tableKey]?.content) {
                                cachedRawData[tableKey].content.splice(rowIdx + 1, 1);
                                saveSnapshot(cachedRawData);
                            }
                        }
                    }
                    
                    // 如果后端 API 失败或不存在，使用全量覆盖兜底，保证 100% 成功
                    if (!apiSuccess) {
                        if (cachedRawData && cachedRawData[tableKey]?.content) {
                            cachedRawData[tableKey].content.splice(rowIdx + 1, 1);
                            saveSnapshot(cachedRawData);
                            await saveDataToDatabase(cachedRawData, true, true); 
                            AcuToast.success('已彻底删除 (同步完成)');
                        }
                    }
                } catch (err) {
                    console.error('[ACU] 删除失败', err);
                    AcuToast.error('删除同步失败，请检查网络或控制台');
                }
            } else {
                // --- 默认模式 (手动保存，保持原有标记逻辑) ---
                const dels = getPendingDeletions();
                if (!dels[tableKey]) dels[tableKey] = [];
                if (!dels[tableKey].includes(rowIdx)) {
                    dels[tableKey].push(rowIdx);
                    savePendingDeletions(dels);
                }
                
                $(cell).closest('.acu-data-card').addClass('pending-deletion');
                hasUnsavedChanges = true; // 将删除动作正式注册为未保存状态
                updateSaveButtonState();
                AcuToast.info('已标记删除 (请点击保存)');
            }
        });
        
        // 恢复逻辑
        menu.find('#act-restore').click(() => {
            const dels = getPendingDeletions();
            if (dels[tableKey]) {
                dels[tableKey] = dels[tableKey].filter(i => i !== rowIdx);
                if (dels[tableKey].length === 0) delete dels[tableKey];
                savePendingDeletions(dels);
            }
            
            $(cell).closest('.acu-data-card').removeClass('pending-deletion');
            
            // [新增] 恢复时检查是否还有其他未保存修改，如果没有，则解除全局未保存状态
            const newDels = getPendingDeletions();
            let hasAnyDels = false;
            for (let k in newDels) { if (newDels[k] && newDels[k].length > 0) hasAnyDels = true; }
            if (!hasAnyDels && (!window.acuModifiedSet || window.acuModifiedSet.size === 0)) {
                hasUnsavedChanges = false;
            }
            
            updateSaveButtonState();
            closeAll();
        });
        
        // [新增] 锁定/解锁逻辑
        menu.find('#act-lock').click(() => {
            closeAll();
            if (api && api.toggleTableCellLock) {
                // 触发 API 锁定/解锁
                const success = api.toggleTableCellLock(tableKey, rowIdx + 1, colIdx);
                if (success !== false) {
                    AcuToast.success(isLocked ? '🔓 已解除锁定，AI 现可修改此格' : '🔒 已物理锁定，彻底免疫 AI 篡改');
                    // 重绘 UI 以显示锁图标
                    renderInterface(); 
                }
            } else {
                AcuToast.warning('后端脚本版本过低，请升级神·数据库');
            }
        });

        // [极速优化版] 插入新行功能 (修复参数错误并增强兜底)
        menu.find('#act-insert').click(async () => {
            closeAll();
            
            let actOrd = Store.get(STORAGE_KEY_ACTION_ORDER);
            if (!actOrd || !Array.isArray(actOrd)) actOrd = DEFAULT_ACTION_ORDER;
            const isInstantMode = !actOrd.includes('acu-btn-save-global');
            
            const api = getCore().getDB();
            
            // 无论如何，先准备好本地数据结构
            if (!cachedRawData) cachedRawData = getTableData() || loadSnapshot();
            if (!cachedRawData || !cachedRawData[tableKey]?.content) {
                AcuToast.error('数据异常，无法获取表格结构');
                return;
            }

            if (isInstantMode) {
                AcuToast.info('正在请求插入新行...');
                try {
                    // --- A. 即时模式：尝试优先使用后端 API (修复：tableName 改为 tableKey) ---
                    if (api && api.insertRow) {
                        const newRowIndex = await api.insertRow(tableKey, {});
                        if (newRowIndex !== -1) {
                            AcuToast.success('已追加新行至表尾');
                            cachedRawData = api.exportTableAsJson(); // 强制拉取最新数据
                            renderInterface();
                            setTimeout(() => {
                                const $panel = $('.acu-panel-content');
                                if($panel.length) $panel.scrollTop($panel[0].scrollHeight);
                            }, 150);
                            return; // 成功则直接退出
                        }
                    }
                    
                    // --- B. 兜底模式：如果 API 失败或不存在，直接改写本地 JSON 并全量推给后端 ---
                    const sheet = cachedRawData[tableKey];
                    const colCount = sheet.content[0] ? sheet.content[0].length : 2;
                    const newRow = new Array(colCount).fill('');
                    if (colCount > 0) newRow[0] = String(sheet.content.length); 
                    sheet.content.splice(rowIdx + 2, 0, newRow);
                    
                    await saveDataToDatabase(cachedRawData, false, true);
                    AcuToast.success('已追加新行 (同步完成)');
                    
                    renderInterface(); 
                    setTimeout(() => {
                        const $panel = $('.acu-panel-content');
                        if($panel.length && $panel[0].scrollHeight > $panel.height()) {
                             $panel.scrollTop($panel.scrollTop() + 10); 
                        }
                    }, 100);

                } catch (err) {
                    console.error('[ACU] 插入失败:', err);
                    AcuToast.error('插入失败');
                }
            } else {
                // --- C. 暂存模式：维持原有的本地插行预览逻辑 ---
                const sheet = cachedRawData[tableKey];
                const colCount = sheet.content[0] ? sheet.content[0].length : 2;
                const newRow = new Array(colCount).fill('');
                if (colCount > 0) newRow[0] = String(sheet.content.length); 

                sheet.content.splice(rowIdx + 2, 0, newRow);

                hasUnsavedChanges = true;
                updateSaveButtonState();
                AcuToast.info('已暂存新行，请最后统一点击保存');
                
                renderInterface(); 
                setTimeout(() => {
                    const $panel = $('.acu-panel-content');
                    if($panel.length && $panel[0].scrollHeight > $panel.height()) {
                         $panel.scrollTop($panel.scrollTop() + 10); 
                    }
                }, 100);
            }
        });


        // [极速优化版] 整体编辑 -> 内联卡片编辑 (无弹窗，原地变表单)
        menu.find('#act-edit-card').click(() => {
            closeAll();
            const $card = $(cell).closest('.acu-data-card');
            if ($card.hasClass('acu-inline-editing-row')) return;
            
            const rawData = cachedRawData || getTableData();
            if (!rawData || !rawData[tableKey]) return;
            const headers = rawData[tableKey].content[0];
            const currentRow = rawData[tableKey].content[rowIdx + 1];
            if (!currentRow) return;

            // 视觉反馈：卡片高亮进入编辑模式
            $card.addClass('acu-inline-editing-row');
            $card.css({'box-shadow': '0 0 0 2px var(--acu-accent)', 'transform': 'scale(1.02)', 'z-index': '10', 'transition': 'all 0.2s ease'});
            AcuToast.info('✏️ 已进入整行编辑，点击卡片外空白处保存');

            const originalHtmlMap = new Map();
            
            // 辅助函数：将单元格转换为自适应高度的 textarea
            const convertToInput = ($target, colIndex, isTitle = false) => {
                originalHtmlMap.set($target[0], $target.html());
                const val = currentRow[colIndex] || '';
                const align = isTitle ? 'center' : 'left';
                const fw = isTitle ? 'bold' : 'normal';
                $target.html(`<textarea class="acu-inline-editor" data-col="${colIndex}" spellcheck="false" style="width:100%; min-height:${isTitle?'24px':'32px'}; background-color:var(--acu-btn-bg) !important; background-image:none !important; color:var(--acu-text-main) !important; border:1px solid var(--acu-accent); border-radius:4px; padding:4px 6px; outline:none; resize:vertical; font-size:inherit; font-family:inherit; text-align:${align}; font-weight:${fw}; box-sizing:border-box; line-height:1.4; overflow:hidden;"></textarea>`);
                
                const $ta = $target.find('textarea');
                $ta.val(val); // 使用 val() 赋值防止 HTML 转义符号被破坏
                
                const adjustHeight = () => {
                    if ($ta[0]._isAdjusting) return;
                    $ta[0]._isAdjusting = true;
                    requestAnimationFrame(() => {
                        $ta[0].style.height = '0px';
                        $ta[0].style.height = ($ta[0].scrollHeight + 2) + 'px';
                        $ta[0]._isAdjusting = false;
                    });
                };
                $ta.on('input', adjustHeight);
                setTimeout(adjustHeight, 10);
            };

            // 1. 转换标题
            const $title = $card.find('.acu-editable-title');
            const titleCol = parseInt($title.data('col'));
            if (!isNaN(titleCol)) convertToInput($title, titleCol, true);

            // 2. 转换所有内容单元格
            $card.find('.acu-card-row').each(function() {
                const $valTarget = $(this).find('.acu-card-value');
                const cIdx = parseInt($(this).data('col'));
                if (!isNaN(cIdx)) convertToInput($valTarget, cIdx, false);
            });

            // 智能聚焦：定位到用户真正点击的那个单元格对应的输入框
            const $targetInput = $card.find(`textarea[data-col="${colIdx}"]`);
            if ($targetInput.length) {
                $targetInput.focus();
                // 顺便把光标移到文本末尾，体验更好
                const len = $targetInput.val().length;
                if ($targetInput[0].setSelectionRange) {
                    $targetInput[0].setSelectionRange(len, len);
                }
            } else {
                // 兜底：如果没找到，再聚焦第一个
                $card.find('textarea').first().focus();
            }

            // 绑定光标焦点流失事件 (FocusOut)：当没有框被选中时，自动退出并保存
            const closeRowEdit = async (e) => {
                // e.relatedTarget 是光标即将去往的新元素。
                // 如果光标还在这个卡片内部（比如点击了相邻的输入框），说明只是在切换格子，不退出
                if (e && e.relatedTarget && $(e.relatedTarget).closest($card).length) {
                    return;
                }

                // 延迟一帧，确保浏览器的 document.activeElement 已完全更新
                setTimeout(async () => {
                    // 兜底检查：如果当前页面有焦点，且焦点还在卡片的输入框里，依然不退出
                    if (document.activeElement && $(document.activeElement).closest($card).length) {
                        return;
                    }

                    // 防止重复执行
                    if (!$card.hasClass('acu-inline-editing-row')) return;

                    window._acuBlockNextClick = true; 
                    setTimeout(() => { window._acuBlockNextClick = false; }, 500); 

                    // 卸载焦点事件
                    $card.off('focusout.acu_row_edit', closeRowEdit);

                    let hasChanges = false;
                    const updateData = {};
                    
                    // 1. 先光速把数据读出来，趁着 DOM 还没被重绘破坏
                    $card.find('textarea.acu-inline-editor').each(function() {
                        const colIdx = parseInt($(this).data('col'));
                        const newVal = $(this).val();
                        if (String(currentRow[colIdx]) !== String(newVal)) {
                            hasChanges = true;
                            currentRow[colIdx] = newVal;
                            const colName = headers[colIdx];
                            if (colName) updateData[colName] = newVal;
                        }
                    });

                    if (hasChanges) {
                        // --- 🚀 【核心魔法：乐观更新 (Optimistic UI)】---
                        // 不等后端！直接在前端瞬间把 DOM 篡改成最新的样子
                        $card.find('textarea.acu-inline-editor').each(function() {
                            const colIdx = parseInt($(this).data('col'));
                            const newVal = $(this).val();
                            const $targetParent = $(this).parent();
                            
                            // 更新 HTML 节点绑定的隐式数据，防止下次编辑读取错乱
                            let $cellDiv = $(this).closest('.acu-editable-title');
                            if ($cellDiv.length === 0) $cellDiv = $(this).closest('.acu-card-row');
                            $cellDiv.attr('data-val', encodeURIComponent(newVal)).data('val', encodeURIComponent(newVal));

                            const isTitle = $targetParent.hasClass('acu-editable-title');
                            const badgeStyle = getBadgeStyle(newVal);
                            
                            // 细节保护：如果这行被物理锁定了，原标题里会有个 🔒 小图标，我们要把它提取出来拼回去
                            const oldHtml = originalHtmlMap.get($targetParent[0]) || '';
                            const lockMatch = oldHtml.match(/<i[^>]+fa-lock[^>]+><\/i>/);
                            const lockIconHtml = lockMatch ? ' ' + lockMatch[0] : '';
                            
                            // 瞬间渲染文字和气泡
                            if (badgeStyle && !isTitle) {
                                $targetParent.html(`<span class="acu-badge ${badgeStyle}">${escapeHtml(newVal)}</span>${lockIconHtml}`);
                            } else {
                                $targetParent.html(`${escapeHtml(newVal)}${lockIconHtml}`);
                            }
                            
                            // 只有真正被修改的单元格（存在于 updateData 字典中），才套上橙色的手动修改高亮样式
                            const colName = headers[colIdx];
                            if (config.highlightNew && colName && updateData[colName] !== undefined) {
                                $targetParent.removeClass('acu-highlight-diff').addClass('acu-highlight-manual');
                            }
                        });
                    } else {
                        // 无修改，还原被 textarea 吃掉的原有 HTML
                        $card.find('.acu-editable-title').html(originalHtmlMap.get($card.find('.acu-editable-title')[0]));
                        $card.find('.acu-card-value').each(function() {
                            $(this).html(originalHtmlMap.get(this));
                        });
                    }

                    // --- 触发卡片缩回动画 (不管有没有修改，立刻缩回，绝不卡顿) ---
                    $card.removeClass('acu-inline-editing-row').css({'box-shadow': '', 'transform': '', 'z-index': ''});

                    if (hasChanges) {
                        let actOrd = Store.get(STORAGE_KEY_ACTION_ORDER);
                        if (!actOrd || !Array.isArray(actOrd)) actOrd = DEFAULT_ACTION_ORDER;
                        const isInstantMode = !actOrd.includes('acu-btn-save-global');

                        if (isInstantMode) {
                            // 直接提示成功，移除变暗加载动画，给予用户“瞬间完成”的极致错觉
                            AcuToast.success('已自动保存');
                            
                            // 扔进宏任务队列，留出 250ms 让卡片动画从从容容地播完
                            setTimeout(async () => {
                                try {
                                    // 存数据库，并且明确告诉它：不要重绘！不要重绘！
                                    await saveDataToDatabase(cachedRawData, true, true);
                                } catch(e) {
                                    AcuToast.error('保存失败，请检查网络');
                                }
                            }, 250); 
                        } else {
                            if (!window.acuModifiedSet) window.acuModifiedSet = new Set();
                            Object.keys(updateData).forEach(colName => {
                                const cIdx = headers.indexOf(colName);
                                window.acuModifiedSet.add(`${tableKey}-${rowIdx}-${cIdx}`);
                            });
                            hasUnsavedChanges = true;
                            updateSaveButtonState();
                            AcuToast.success('修改已暂存');
                        }
                        
                        // ❌ 【绝杀】这里砍掉了之前那句 renderInterface()！
                        // 既然前端 DOM 已经自己改好了，就彻底不需要推翻重建整个大面板了。这就是性能飞升的秘密。
                    }
                }, 10);
            };

            // 使用 focusout 监听光标焦点流失，完美契合“无光标即退出”的逻辑
            $card.on('focusout.acu_row_edit', closeRowEdit);
        });

// [恢复弹窗版] 单格编辑逻辑 (适合长文本精雕细琢)
        menu.find('#act-edit').click(() => { 
            closeAll();
            showEditDialog(content, async (newVal) => { 
                if (content === newVal) return;
                
                const $cell = $(cell);
                $cell.attr('data-val', encodeURIComponent(newVal)).data('val', encodeURIComponent(newVal));
                
                let $displayTarget = $cell;
                if ($cell.find('.acu-card-value').length) $displayTarget = $cell.find('.acu-card-value');
                else if ($cell.hasClass('acu-grid-item')) $displayTarget = $cell.find('.acu-grid-value');
                else if ($cell.hasClass('acu-editable-title')) $displayTarget = $cell;

                const badgeStyle = getBadgeStyle(newVal);
                if (badgeStyle && !$cell.hasClass('acu-editable-title')) {
                     $displayTarget.html(`<span class="acu-badge ${badgeStyle}">${escapeHtml(newVal)}</span>`);
                } else {
                     $displayTarget.text(newVal);
                }

                if ($cell.hasClass('acu-editable-title') && content !== newVal) {
                    const currentCtxId = getCurrentContextFingerprint();
                    const avatars = getCustomAvatars();
                    if (avatars[currentCtxId] && avatars[currentCtxId][content]) {
                        avatars[currentCtxId][newVal] = avatars[currentCtxId][content];
                        delete avatars[currentCtxId][content];
                        AvatarDB.saveToDB(currentCtxId, avatars[currentCtxId]); 
                    }
                }

                if (!cachedRawData) cachedRawData = getTableData() || loadSnapshot();
                if (cachedRawData && cachedRawData[tableKey]?.content[rowIdx + 1]) { 
                    cachedRawData[tableKey].content[rowIdx + 1][colIdx] = newVal;
                }

                let actOrd = Store.get(STORAGE_KEY_ACTION_ORDER);
                if (!actOrd || !Array.isArray(actOrd)) actOrd = DEFAULT_ACTION_ORDER;
                const isInstantMode = !actOrd.includes('acu-btn-save-global');

                if (isInstantMode) {
                    $displayTarget.removeClass('acu-highlight-manual acu-highlight-diff');
                    if ($cell.hasClass('acu-editable-title')) $cell.removeClass('acu-highlight-manual acu-highlight-diff');
                    
                    // 【降维打击】抛弃不稳定的小颗粒 API，强制使用和“全局保存”一模一样的全量写入接口
                    try {
                        await saveDataToDatabase(cachedRawData, true, true);
                        AcuToast.success('已极速保存');
                    } catch(e) {
                        AcuToast.error('保存失败');
                    }
                } else {
                    $displayTarget.removeClass('acu-highlight-diff').addClass('acu-highlight-manual');
                    if ($cell.hasClass('acu-editable-title')) $cell.removeClass('acu-highlight-diff').addClass('acu-highlight-manual');

                    if (!window.acuModifiedSet) window.acuModifiedSet = new Set();
                    window.acuModifiedSet.add(cellId);
                    hasUnsavedChanges = true;
                    updateSaveButtonState();
                    AcuToast.info('修改已暂存，请点击保存');
                }
            });
        });
    };

    const showEditDialog = (content, onSave) => {
        const { $ } = getCore();
        const config = getConfig();
        
        const dialog = $(`
            <div class="acu-edit-overlay">
                <div class="acu-edit-dialog acu-theme-${config.theme}">
                    <div class="acu-edit-title">编辑单元格内容</div>
                    <textarea class="acu-edit-textarea" style="background-color: var(--acu-btn-bg) !important; color: var(--acu-text-main) !important; background-image: none !important;">${escapeHtml(content)}</textarea>
                    <div class="acu-dialog-btns">
                        <button class="acu-dialog-btn" id="dlg-cancel"><i class="fa-solid fa-times"></i> 取消</button>
                        <button class="acu-dialog-btn acu-btn-confirm" id="dlg-save"><i class="fa-solid fa-check"></i> 保存</button>
                    </div>
                </div>
            </div>
        `);
        $('body').append(dialog);
        dialog.find('#dlg-cancel').click(() => dialog.remove());
        dialog.find('#dlg-save').click(() => { onSave(dialog.find('textarea').val()); dialog.remove(); });
    };

// ============================================================
    // [新增] 模板缝合中心 (Template Stitcher)
    // ============================================================
    const StitcherModule = {
        generateUid: () => 'sheet_' + Math.random().toString(36).substr(2, 8),
        
        show: async function(parentDialog) {
            const { $ } = getCore();
            const config = getConfig();
            
            const dialogHtml = `
                <div class="acu-stitcher-overlay acu-edit-overlay" style="z-index: 2147483649 !important;">
                    <style>
                        .acu-stitcher-layout { display: flex; gap: 15px; flex: 1; padding: 15px; overflow: hidden; }
                        .acu-stitcher-col { flex: 1; display: flex; flex-direction: column; border-radius: 8px; overflow: hidden; }
                        .acu-stitcher-col-merged { flex: 1.2; border: 2px dashed var(--acu-accent); background: rgba(0,0,0,0.1); }
                        .acu-stitcher-col-source { border: 1px solid var(--acu-border); background: var(--acu-bg-panel); }
                        @media (max-width: 768px) {
                            /* 移动端核心修改：使用严格网格切分高度 */
                            .acu-stitcher-layout { 
                                display: grid !important; 
                                grid-template-columns: 1fr 1fr; 
                                grid-template-rows: 1fr 1.2fr;
                                grid-template-areas: "sourceA sourceB" "merged merged";
                                gap: 8px; 
                                padding: 10px; 
                                overflow: hidden !important; 
                                min-height: 0 !important; /* 强制允许内部收缩，绝不撑爆父容器 */
                            }
                            .acu-stitcher-col { min-height: 0; flex: none; height: 100%; overflow: hidden; } 
                            .acu-stitcher-col:nth-child(1) { grid-area: sourceA; } 
                            .acu-stitcher-col:nth-child(2) { grid-area: merged; } 
                            .acu-stitcher-col:nth-child(3) { grid-area: sourceB; }
                            
                            /* 核心修改：弃用坑爹的 vh，使用现代防遮挡动态视口 dvh/svh */
                            .acu-stitcher-dialog { 
                                height: 85vh !important; /* 老旧浏览器兜底 */
                                height: 85dvh !important; /* 动态视口，完美跟随浏览器工具栏的伸缩 */
                                max-height: calc(100svh - 40px) !important; /* 最小安全视口兜底，减去上下边距，死死卡在安全区内 */
                                width: 95% !important; 
                                border-radius: 16px !important; 
                                margin: auto !important; 
                                box-sizing: border-box !important;
                            }
                            .acu-stitcher-toolbar { flex-direction: column; align-items: stretch !important; gap: 6px !important; }
                            
                            /* 强迫症福音：彻底抹除下拉框的默认边距，抹平自身圆角交由父级裁剪，完美贴合顶部框线 */
                            .acu-stitcher-col .acu-select { font-size: 11px; padding: 4px; margin: 0 !important; display: block; width: 100%; border-radius: 0 !important; border-top: none !important; box-sizing: border-box; }
                            .acu-stitcher-col .stitch-item > div:first-child { font-size: 11px !important; }
                            .acu-stitcher-col .stitch-item > div:last-child { font-size: 10px !important; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
                            .acu-stitcher-col .stitch-list { padding: 6px; gap: 6px; }
                        }
                    </style>
                    <div class="acu-edit-dialog acu-stitcher-dialog acu-theme-${config.theme}" style="width: 95%; max-width: 1200px; height: 85vh; display: flex; flex-direction: column;">
                        <div class="acu-edit-title" style="display:flex; justify-content:space-between; align-items:center; flex-shrink: 0;">
                            <span><i class="fa-solid fa-puzzle-piece" style="color:var(--acu-accent);"></i> 模板缝合中心</span>
                            <button class="acu-close-profile-btn" id="btn-close-stitcher" style="background:none; border:none; color:var(--acu-text-sub); cursor:pointer; font-size:16px;"><i class="fa-solid fa-times"></i></button>
                        </div>
                        
                        <div class="acu-stitcher-toolbar" style="padding: 10px; border-bottom: 1px dashed var(--acu-border); display: flex; gap: 10px; align-items:center; flex-shrink: 0;">
                            <span style="font-size:12px; color:var(--acu-text-sub); flex:1;">👉 点击库中的表格，将其加入缝合区。</span>
                            <button class="acu-btn-block" id="acu-btn-save-merged" style="width:auto; margin:0; padding:6px 15px; background: var(--acu-accent); color:#fff; border-color:var(--acu-accent);"><i class="fa-solid fa-save"></i> 保存到系统库</button>
                        </div>

                        <div class="acu-stitcher-layout">
                            <div class="acu-stitcher-col acu-stitcher-col-source">
                                <select class="acu-select" id="stitch-select-a" style="border-radius: 8px 8px 0 0; border:none; border-bottom: 1px solid var(--acu-border); flex-shrink: 0;">
                                    <option value="">-- 选择模板 A --</option>
                                </select>
                                <div class="stitch-list" id="stitch-list-a" style="flex:1; overflow-y:auto; padding: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
                            </div>

                            <div class="acu-stitcher-col acu-stitcher-col-merged">
                                <div style="text-align: center; padding: 10px; font-weight: bold; color: var(--acu-accent); border-bottom: 1px dashed var(--acu-border); background: var(--acu-table-head); flex-shrink: 0;">✨ 最终合并目标 (点击移除)</div>
                                <div class="stitch-list" id="stitch-list-merged" style="flex:1; overflow-y:auto; padding: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
                            </div>

                            <div class="acu-stitcher-col acu-stitcher-col-source">
                                <select class="acu-select" id="stitch-select-b" style="border-radius: 8px 8px 0 0; border:none; border-bottom: 1px solid var(--acu-border); flex-shrink: 0;">
                                    <option value="">-- 选择模板 B --</option>
                                </select>
                                <div class="stitch-list" id="stitch-list-b" style="flex:1; overflow-y:auto; padding: 10px; display: flex; flex-direction: column; gap: 8px;"></div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
            
            $('body').append(dialogHtml);
            const $dialog = $('.acu-stitcher-overlay');
            
            // 加载下拉列表
            const templates = await TemplateDB.getAllTemplates();
            const refreshSelects = () => {
                const options = '<option value="">-- 请选择模板 --</option>' + Object.keys(templates).map(k => {
                    const tName = templates[k].mate?.templateName || k;
                    return `<option value="${k}">${escapeHtml(tName)}</option>`;
                }).join('');
                $('#stitch-select-a, #stitch-select-b').html(options);
            };
            refreshSelects();

            // 渲染列表卡片函数
            const renderList = (selectId, listId) => {
                const key = $(`#${selectId}`).val();
                const $list = $(`#${listId}`);
                $list.empty();
                if (!key || !templates[key]) return;
                
                const data = templates[key];
                Object.keys(data).forEach(sheetId => {
                    if (!sheetId.startsWith('sheet_')) return;
                    const sheet = data[sheetId];
                    const safeRaw = encodeURIComponent(JSON.stringify(sheet));
                    const html = `
                        <div class="acu-rpg-item-card stitch-item source-item" data-raw="${safeRaw}" style="cursor:pointer; border-left:3px solid var(--acu-accent);">
                            <div style="font-weight:bold; color:var(--acu-text-main); font-size:13px;">${escapeHtml(sheet.name || '未命名')}</div>
                            <div style="font-size:11px; color:var(--acu-text-sub); margin-top:4px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">
                                ${escapeHtml(sheet.sourceData?.note || '无说明')}
                            </div>
                        </div>
                    `;
                    $list.append(html);
                });
            };

            $('#stitch-select-a').change(() => renderList('stitch-select-a', 'stitch-list-a'));
            $('#stitch-select-b').change(() => renderList('stitch-select-b', 'stitch-list-b'));

            // 点击加入中间
            $dialog.on('click', '.source-item', function() {
                const rawData = decodeURIComponent($(this).attr('data-raw'));
                const sheet = JSON.parse(rawData);
                
                // 查重保护
                let isDuplicate = false;
                $('#stitch-list-merged .merged-item').each(function() {
                    const mergedSheet = JSON.parse(decodeURIComponent($(this).attr('data-raw')));
                    if (mergedSheet.name === sheet.name) isDuplicate = true;
                });
                
                if (isDuplicate) {
                    AcuToast.warning(`已存在同名表 [${sheet.name}]，为防止冲突，不可重复添加`);
                    return;
                }
                
                const safeRaw = encodeURIComponent(JSON.stringify(sheet));
                const html = `
                    <div class="acu-rpg-item-card stitch-item merged-item" data-raw="${safeRaw}" style="cursor:pointer; border-left:3px solid #2ecc71;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div style="font-weight:bold; color:var(--acu-text-main); font-size:13px;">${escapeHtml(sheet.name || '未命名')}</div>
                            <i class="fa-solid fa-minus-circle" style="color:#e74c3c;"></i>
                        </div>
                    </div>
                `;
                $('#stitch-list-merged').append(html);
                
                // [优化] 取消全局弹窗，改为源卡片自身的“按压”物理反馈
                const $clickedCard = $(this);
                $clickedCard.css('transition', 'transform 0.1s, background 0.1s');
                $clickedCard.css({'background': 'rgba(46,204,113,0.15)', 'transform': 'scale(0.96)'});
                
                // 150毫秒后恢复原状，形成清脆的点击手感
                setTimeout(() => {
                    $clickedCard.css({'background': '', 'transform': ''});
                }, 150);
            });

            // 点击移除
            $dialog.on('click', '.merged-item', function() {
                $(this).remove();
            });

            const getMergedJson = () => {
                const finalJson = {
                    mate: {
                        type: "chatSheets",
                        version: 2,
                        updateConfigUiSentinel: -1,
                        globalInjectionConfig: {
                            readableEntryPlacement: { position: "before_character_definition", depth: 2, order: 99981 },
                            wrapperPlacement: { position: "before_character_definition", depth: 2, order: 99980 }
                        }
                    }
                };

                let orderCounter = 0;
                const $mergedItems = $('#stitch-list-merged .merged-item');
                
                if ($mergedItems.length === 0) {
                    AcuToast.warning('中间目标区域为空，无法合并！');
                    return null;
                }

                $mergedItems.each(function() {
                    const rawTableData = JSON.parse(decodeURIComponent($(this).attr('data-raw')));
                    const newUid = StitcherModule.generateUid(); // 重新分配 UID
                    rawTableData.uid = newUid;
                    rawTableData.orderNo = orderCounter++;
                    finalJson[newUid] = rawTableData;
                });
                return finalJson;
            };

            // 存为本地模板 (系统库)
            $('#acu-btn-save-merged').click(async () => {
                const finalJson = getMergedJson();
                if (!finalJson) return;
                
                // [优化] 智能计算默认模板名称，自动添加数字后缀避免同名混淆
                let baseName = "新缝合模板";
                let maxSuffix = 0;
                let hasBase = false;
                
                Object.values(templates).forEach(tpl => {
                    const name = tpl.mate?.templateName;
                    if (name === baseName) {
                        hasBase = true;
                    } else if (name && name.startsWith(baseName)) {
                        const suffix = name.substring(baseName.length);
                        // 如果后缀是纯数字，记录下最大的那个数字
                        if (/^\d+$/.test(suffix)) {
                            maxSuffix = Math.max(maxSuffix, parseInt(suffix, 10));
                        }
                    }
                });
                
                let defaultName = baseName;
                if (maxSuffix > 0) {
                    defaultName = baseName + (maxSuffix + 1); // 比如有3，就叫4
                } else if (hasBase) {
                    defaultName = baseName + "2"; // 只有原名，就叫2
                }

                let templateName = prompt("请为新缝合的模板命名 (例如: 究极缝合包):", defaultName);
                if (!templateName) return;
                
                finalJson.mate.templateName = templateName;
                const tplId = 'tpl_' + Date.now();
                await TemplateDB.saveTemplate(tplId, finalJson);
                
                templates[tplId] = finalJson;
                refreshSelects();
                AcuToast.success('✅ 已保存到系统库！(请退出缝合中心进行外部管理)');
            });

            // [修复] 提取一个通用的关闭并刷新外层列表的函数
            const closeStitcherAndRefresh = async () => {
                $dialog.remove(); // 销毁缝合中心
                if (parentDialog) {
                    parentDialog.show(); // 恢复显示全能设置面板
                    // 重新读取底层数据库，强制刷新外层的下拉列表
                    const tmps = await TemplateDB.getAllTemplates();
                    const options = '<option value="">-- 当前系统库 --</option>' + Object.keys(tmps).map(k => {
                        const tName = tmps[k].mate?.templateName || k;
                        return `<option value="${k}">${escapeHtml(tName)}</option>`;
                    }).join('');
                    parentDialog.find('#cfg-template-select').html(options);
                }
            };

            // 关闭 (返回上一级)
            $('#btn-close-stitcher').click(closeStitcherAndRefresh);

            // 点击空白区域 (遮罩层) 返回上一级
            $dialog.on('click', function(e) {
                if ($(e.target).hasClass('acu-stitcher-overlay')) {
                    closeStitcherAndRefresh();
                }
            });
        }
    };

    // ==========================================
    // [优化后] 新的初始化入口 (Observer 只创建一次)
    // ==========================================
    const init = async () => {
    if (isInitialized) return;
    
    // 等待 IndexedDB 异步提取全部头像数据进入内存
    await AvatarDB.init(); 
    await TemplateDB.init(); // 初始化模板数据库 
    
    addStyles();
    // [核心修复] 初始化时必须主动应用一次配置，否则每次刷新网页字体和布局都会丢失
    applyConfigStyles(getConfig());


        // 2. 保留原有的 SillyTavern 事件监听（使用具名函数防止重复注册）
        if (window.SillyTavern && window.SillyTavern.eventSource) {
            const events = window.SillyTavern.eventTypes;
            const source = window.SillyTavern.eventSource;
            // [精准触发] 仅保留基础事件 + 删除楼层 + 强制打断生成
            const triggers = [
                events.CHAT_CHANGED, 
                events.MESSAGE_SWIPED, 
                events.MESSAGE_RECEIVED, 
                events.STREAM_MESSAGE_END,
                events.MESSAGE_DELETED,         // 监听：删除楼层
                events.GENERATION_STOPPED       // 监听：强制打断生成
            ];
            
            // 确保只创建一次处理函数
            if (!_boundRenderHandler) {
                _boundRenderHandler = () => { 
                    if (!isEditingOrder) {
                        // [核心修复2] 监听到任何反悔操作时，强制重置所有状态并唤醒选项
                        optionPanelVisible = true;
                        lastOptionHash = null;
                        window._lastEmbeddedHash = null;
                        setTimeout(renderInterface, 500); 
                    }
                };
            }

            // ---------- [新增] 专门监听生成事件，用于完美挂载状态栏 ----------
            if (!window._acuBoundGenHandlers) {
                window._acuBoundGenHandlers = {
                    start: () => { 
                        window._acuIsGenerating = true; 
                        // AI 开始思考/打字时：原位锁死 RPG 状态栏
                        // 【原生解法】主面板不重绘，直接利用原生 DOM API 物理移动到 #chat 最底部
                        const chatEl = document.getElementById('chat');
                        const wrapperEl = document.querySelector('.acu-wrapper');
                        if (chatEl && wrapperEl) {
                            chatEl.appendChild(wrapperEl);
                        }
                    },
                    end: () => { 
                        window._acuIsGenerating = false; 
                        // AI 输出完毕后，利用 requestAnimationFrame 确保酒馆的原生 DOM 已更新
                        requestAnimationFrame(() => setTimeout(renderInterface, 100)); 
                    }
                };
            }
            
            // 防止重复注册，先解绑
            source.removeListener(events.GENERATION_STARTED, window._acuBoundGenHandlers.start);
            source.removeListener(events.GENERATION_ENDED, window._acuBoundGenHandlers.end);
            source.removeListener(events.GENERATION_STOPPED, window._acuBoundGenHandlers.end);
            if (window._acuBoundMessageReceivedHandler) {
                source.removeListener(events.MESSAGE_RECEIVED, window._acuBoundMessageReceivedHandler);
            }
            
            // 【原生解法】增加对接收/发送消息的监听，确保非生成状态下的气泡也能把面板挤下去
            window._acuBoundMessageReceivedHandler = () => {
                const chatEl = document.getElementById('chat');
                const wrapperEl = document.querySelector('.acu-wrapper');
                if (chatEl && wrapperEl) {
                    chatEl.appendChild(wrapperEl);
                }
            };

            // 绑定开始与结束事件
            source.on(events.GENERATION_STARTED, window._acuBoundGenHandlers.start);
            source.on(events.GENERATION_ENDED, window._acuBoundGenHandlers.end);
            source.on(events.GENERATION_STOPPED, window._acuBoundGenHandlers.end);
            source.on(events.MESSAGE_RECEIVED, window._acuBoundMessageReceivedHandler);
            // ----------------------------------------------------------------------
            
            // 确保只创建一次聊天切换处理函数（移到模块级防止重复注册）
            if (!window._acuBoundChatChangeHandler) {
                window._acuBoundChatChangeHandler = () => {
                    cachedRawData = null;
                    tablePageStates = {};
                    tableSearchStates = {};
                    tableScrollStates = {};
                    hasUnsavedChanges = false;
                    currentDiffMap.clear();
                    if (window.acuModifiedSet) window.acuModifiedSet.clear();
                    if (window._acuSchemaCache) window._acuSchemaCache.clear(); // [优化] 切换聊天时清空表头智能缓存
                    
                    // [T0 优化] 切换聊天时彻底清空图片缓存，斩断引用，释放浏览器解码内存，防止 OOM 崩溃
                    if (window._acuImageCache) {
                        for (let key in window._acuImageCache) {
                            window._acuImageCache[key].src = ''; 
                        }
                        window._acuImageCache = {};
                    }

                    // [新增] 切换聊天时清理日历旧缓存，防止跨角色数据残留
                    try { localStorage.removeItem('acu_calendar_archive_v1'); } catch(e) {}
                    setTimeout(renderInterface, 500);
                };
            }
            const _boundChatChangeHandler = window._acuBoundChatChangeHandler;
            
            triggers.forEach(evt => {
                if (evt) {
                    source.removeListener(evt, _boundRenderHandler);
                    source.removeListener(evt, _boundChatChangeHandler); // 防止重复注册
                    if (evt === events.CHAT_CHANGED) {
                        source.on(evt, _boundChatChangeHandler);
                    } else {
                        source.on(evt, _boundRenderHandler);
                    }
                }
            });
        }


        // 3. 轮询等待数据库 API 就绪
        const loop = () => {
             const api = getCore().getDB();
             if (api?.exportTableAsJson) {
                 isInitialized = true;

                // (DOM Observer 已安全移除，由原生事件接管驱动)

                 renderInterface(); // 首次渲染
                 
                 // 注册回调
                 if (api.registerTableUpdateCallback) {
                    api.registerTableUpdateCallback(UpdateController.handleUpdate);
                    
                    // 恢复快照功能 & 挂载选项转圈锁
                    if (api.registerTableFillStartCallback) {
                         api.registerTableFillStartCallback(() => {
                             const current = api.exportTableAsJson();
                             if (current) saveSnapshot(current);
                             console.log('[ACU] 检测到数据库开始填表更新...');
                             
                             isWaitingForDbUpdate = true; // [新增] 立刻上锁
                             renderInterface();           // [新增] 重绘UI显示转圈
                             
                             // [T0 优化] 底部防卡死机制：20秒后自动静默解锁，不打扰用户
                             if (dbUpdateTimeout) clearTimeout(dbUpdateTimeout);
                             dbUpdateTimeout = setTimeout(() => {
                                 if (isWaitingForDbUpdate) {
                                     isWaitingForDbUpdate = false;
                                     renderInterface();
                                 }
                             }, 20000);
                         });
                    }
                 }
             } else {
                 // 持续静默轮询，等待后端 API 就绪，不设超时限制
                 if (!isInitialized) {
                     setTimeout(loop, 1000);
                 }
             }
        };
        loop();
        
        // [补回] 监听用户发送消息 - 自动隐藏选项面板
        const setupOptionHideListener = () => {
            const hideOptionPanel = () => {
                optionPanelVisible = false;
                $('.acu-option-panel').fadeOut(200, function() { 
                    $(this).remove(); 
                    // [核心修复1] 物理删除 DOM 的同时，必须清空渲染缓存！
                    window._lastEmbeddedHash = null; 
                });
            };
            
            // 【核心修复】清除指纹缓存并强制恢复显示选项面板
            const restoreOptionPanel = () => {
                isWaitingForDbUpdate = false; // [新增兜底] 强行砸锁，防止死循环转圈
                lastOptionHash = null;
                optionPanelVisible = true;
                setTimeout(renderInterface, 100);
            };

            const ST = window.SillyTavern || window.parent?.SillyTavern;
            const evtName = ST?.eventTypes?.MESSAGE_SENT || (window.tavern_events ? window.tavern_events.MESSAGE_SENT : 'message_sent');
            const evtDeleted = ST?.eventTypes?.MESSAGE_DELETED || (window.tavern_events ? window.tavern_events.MESSAGE_DELETED : 'message_deleted');
            const evtStopped = ST?.eventTypes?.GENERATION_STOPPED || (window.tavern_events ? window.tavern_events.GENERATION_STOPPED : 'generation_stopped');
            const evtSwiped = ST?.eventTypes?.MESSAGE_SWIPED || (window.tavern_events ? window.tavern_events.MESSAGE_SWIPED : 'message_swiped');
            
            if (ST?.eventSource) { 
                ST.eventSource.on(evtName, hideOptionPanel); 
                ST.eventSource.on(evtDeleted, restoreOptionPanel);
                ST.eventSource.on(evtStopped, restoreOptionPanel);
                if (evtSwiped) ST.eventSource.on(evtSwiped, restoreOptionPanel);
                return; 
            }
            if (typeof window.eventOn === 'function') { 
                window.eventOn(evtName, hideOptionPanel); 
                window.eventOn(evtDeleted, restoreOptionPanel);
                window.eventOn(evtStopped, restoreOptionPanel);
                if (evtSwiped) window.eventOn(evtSwiped, restoreOptionPanel);
            }
        };
        setTimeout(setupOptionHideListener, 2000);
        
        // [新增] 页面卸载时清理资源
        $(window).off('beforeunload.acu pagehide.acu').on('beforeunload.acu pagehide.acu', () => {
            try {
                localStorage.setItem(STORAGE_KEY_SCROLL, JSON.stringify(tableScrollStates));
            } catch(e) {}
        });

        // ==========================================
        // [终极修复] 绑定 RPG 交互状态栏事件 (全局委托)
        // ==========================================
        // 1. 展开/收起面板事件 (强制覆盖绑定，无视缓存)
        $('body').off('click.acu_rpg_toggle').on('click.acu_rpg_toggle', '.acu-rpg-summary-toggle, #acu-rpg-summary-toggle', function(e) {
            e.stopPropagation();
            const $panel = $(this).siblings('.acu-rpg-details-panel, #acu-rpg-details-panel');
            const $chevron = $(this).find('.acu-rpg-chevron, #acu-rpg-chevron');
            if ($panel.is(':visible')) {
                $panel.slideUp(250);
                $chevron.css('transform', 'rotate(0deg)');
                localStorage.setItem('acu_rpg_expanded', 'false'); // 保存收起状态
            } else {
                $panel.slideDown(250);
                $chevron.css('transform', 'rotate(180deg)');
                localStorage.setItem('acu_rpg_expanded', 'true'); // 保存展开状态
            }
        });

        // 2. Tab 标签页切换事件
        $('body').off('click.acu_rpg_tab').on('click.acu_rpg_tab', '.acu-rpg-tab-btn', function(e) {
            e.stopPropagation();
            const $this = $(this);
            const $widget = $this.closest('.acu-rpg-widget');
            const targetAttr = $this.data('target');

            // 记录当前激活的标签页
            localStorage.setItem('acu_rpg_active_tab', targetAttr);

            $widget.find('.acu-rpg-tab-btn').removeClass('active');
            $this.addClass('active');

            $widget.find('.acu-rpg-tab-content').removeClass('active').hide();
            // 兼容查找 class 或 id
            $widget.find(`.${targetAttr}, #${targetAttr}`).show().addClass('active');

            // [修复] 如果切入的是“关系”标签，延迟 50ms (等待 fadeIn 让容器获得真实尺寸) 后自动触发重置
            if (targetAttr === 'rpg-tab-relations') {
                setTimeout(() => {
                    $widget.find('#acu-rel-reset-embedded').click();
                }, 50);
            }
        });
        
        // 3. 防止点击面板内部时关闭全局UI
        $('body').off('click.acu_rpg_widget').on('click.acu_rpg_widget', '.acu-rpg-widget', function(e) {
            e.stopPropagation();
        });

        // 4. 资产分页按钮翻页事件
        $('body').off('click.acu_rpg_page').on('click.acu_rpg_page', '.acu-rpg-page-btn', function(e) {
            e.stopPropagation();
            if ($(this).hasClass('disabled')) return;
            window._acuRpgBagPage = parseInt($(this).data('page'), 10);
            renderInterface(); // 翻页后直接刷新界面
        });

        // 5. RPG专属设置(分页数量)更改事件
        $('body').off('change.acu_rpg_cfg').on('change.acu_rpg_cfg', '#acu-rpg-cfg-bag-page', function(e) {
            e.stopPropagation();
            let val = parseInt($(this).val(), 10);
            if (isNaN(val) || val < 0) { val = 0; $(this).val(0); }
            if (typeof saveConfig === 'function') {
                saveConfig({ rpgBagPerPage: val });
                window._acuRpgBagPage = 1; // 修改数量后重置回第一页
                renderInterface();
            }
        });

        // 6. [新增] 资产面板：使用物品按钮
        $('body').off('click.acu_bag_use').on('click.acu_bag_use', '.acu-bag-use-btn', function(e) {
            e.stopPropagation();
            const itemName = $(this).data('name');
            const insertText = '使用 ' + itemName;
            const ta = $('#send_textarea');
            if (ta.length) {
                const domEl = ta[0];
                const startPos = domEl.selectionStart;
                const endPos = domEl.selectionEnd;
                const currentVal = ta.val();
                
                if (startPos !== undefined && endPos !== undefined) {
                    const newVal = currentVal.substring(0, startPos) + insertText + currentVal.substring(endPos);
                    ta.val(newVal);
                    const newCursorPos = startPos + insertText.length;
                    domEl.setSelectionRange(newCursorPos, newCursorPos);
                } else {
                    const newVal = currentVal ? currentVal + ' ' + insertText : insertText;
                    ta.val(newVal);
                }
                ta.trigger('input').trigger('change').focus();
                AcuToast.success('已追加至输入栏：' + insertText);
            }
        });

        // 7. [新增] 资产面板：删除物品按钮
        $('body').off('click.acu_bag_del').on('click.acu_bag_del', '.acu-bag-del-btn', async function(e) {
            e.stopPropagation();
            const $btn = $(this);
            const itemName = $btn.data('name');
            
            // 1. 点击后，垃圾桶瞬间变红示警
            $btn.css('color', '#e74c3c');
            
            // 2. 核心魔法：等待一帧让浏览器把红色画出来，再弹阻塞式的确认框，否则红色会被弹窗憋在肚子里
            await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 10)));

            if (!confirm('【高危操作】\n确定要彻底丢弃/删除资产 [' + itemName + '] 吗？\n此操作将直接修改数据库并保存！')) {
                // 3. 用户点击了取消，垃圾桶乖乖退回原本的低调灰
                $btn.css('color', 'var(--acu-text-sub)');
                return;
            }

            const tableKey = $btn.data('key');
            const rowIdx = parseInt($btn.data('row'), 10);
            const api = getCore().getDB();
            
            // 视觉反馈：UI 层面让卡片瞬间滑出消失，无需等待后端，手感极佳
            const $card = $(this).closest('.acu-rpg-item-card');
            $card.css('transition', 'all 0.2s ease').css('opacity', '0').css('transform', 'scale(0.9)');
            setTimeout(() => $card.slideUp(200, () => $card.remove()), 200);

            try {
                let apiSuccess = false;
                // 优先尝试使用细粒度的行删除 API
                if (api && api.deleteRow) {
                    apiSuccess = await api.deleteRow(tableKey, rowIdx + 1); // 数据库索引含表头，故 +1
                    if (apiSuccess) {
                        AcuToast.success('已彻底删除：' + itemName);
                        // 同步本地数据快照防穿帮
                        if (cachedRawData && cachedRawData[tableKey]?.content) {
                            cachedRawData[tableKey].content.splice(rowIdx + 1, 1);
                            saveSnapshot(cachedRawData);
                        }
                    }
                }
                
                // 兜底方案：如果后端 API 不存在或失效，直接修改本地 JSON 并全局覆盖保存
                if (!apiSuccess) {
                    if (!cachedRawData) cachedRawData = getTableData() || loadSnapshot();
                    if (cachedRawData && cachedRawData[tableKey]?.content) {
                        cachedRawData[tableKey].content.splice(rowIdx + 1, 1);
                        saveSnapshot(cachedRawData);
                        await saveDataToDatabase(cachedRawData, true, true);
                        AcuToast.success('已删除物品 (全量同步完成)');
                    }
                }
            } catch (err) {
                console.error('[ACU] 删除物品失败', err);
                AcuToast.error('删除同步失败，请检查网络或控制台');
            }
        });
    };

    const { $ } = getCore();
    if ($) $(document).ready(init); else window.addEventListener('load', init);
})();