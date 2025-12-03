// Settings page JS: persist toast settings in localStorage and apply
(function(){
    const KEY = 'mq_toast_settings_v1';
    const defaults = {
        enabled: true,
        duration: 4000,
        position: 'top-right',
        icon: 'default',
        syncToServer: false,
        userToken: '',
        types: { success: true, info: true, warning: true, danger: true }
    };

    function loadLocal() {
        try {
            const raw = localStorage.getItem(KEY);
            if (!raw) return Object.assign({}, defaults);
            const parsed = JSON.parse(raw);
            const out = Object.assign({}, defaults, parsed);
            out.types = Object.assign({}, defaults.types, (parsed && parsed.types) || {});
            return out;
        } catch (e) { return Object.assign({}, defaults); }
    }
    function saveLocal(s) { localStorage.setItem(KEY, JSON.stringify(s)); }

    async function fetchServerSettings(token) {
        if (!token) return null;
        try {
            const res = await fetch('/api/user-settings', { headers: { 'X-User-Token': token } });
            if (!res.ok) return null;
            const j = await res.json();
            return j || null;
        } catch (e) { return null; }
    }

    async function postServerSettings(token, settings) {
        if (!token) return { ok: false, message: 'missing token' };
        try {
            const res = await fetch('/api/user-settings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Token': token }, body: JSON.stringify(settings) });
            if (!res.ok) return { ok: false, status: res.status, message: await res.text() };
            return { ok: true };
        } catch (e) { return { ok: false, message: String(e) }; }
    }

    function applyToForm(s) {
        document.getElementById('toast-enable').checked = !!s.enabled;
        document.getElementById('toast-duration').value = s.duration || defaults.duration;
        document.getElementById('toast-position').value = s.position || defaults.position;
        document.getElementById('toast-icon').value = s.icon || defaults.icon;
        document.getElementById('toast-sync-server').checked = !!s.syncToServer;
        document.getElementById('toast-user-token').value = s.userToken || '';
        document.getElementById('toast-type-success').checked = !!(s.types && s.types.success);
        document.getElementById('toast-type-info').checked = !!(s.types && s.types.info);
        document.getElementById('toast-type-warning').checked = !!(s.types && s.types.warning);
        document.getElementById('toast-type-danger').checked = !!(s.types && s.types.danger);
    }

    function readForm() {
        return {
            enabled: !!document.getElementById('toast-enable').checked,
            duration: Math.max(200, Number(document.getElementById('toast-duration').value) || defaults.duration),
            position: document.getElementById('toast-position').value || defaults.position,
            icon: document.getElementById('toast-icon').value || defaults.icon,
            syncToServer: !!document.getElementById('toast-sync-server').checked,
            userToken: (document.getElementById('toast-user-token').value || '').trim(),
            types: {
                success: !!document.getElementById('toast-type-success').checked,
                info: !!document.getElementById('toast-type-info').checked,
                warning: !!document.getElementById('toast-type-warning').checked,
                danger: !!document.getElementById('toast-type-danger').checked
            }
        };
    }

    // Render a persistent preview toast inside the preview area.
    function renderPreview(s) {
        try {
            const area = document.getElementById('toast-preview-area');
            if (!area) return;
            // clear previous
            area.innerHTML = '';
            const el = document.createElement('div');
            el.className = 'mq-toast mq-toast--preview mq-toast--' + (s.icon ? '' : 'info');
            if (s.position) el.style.margin = '8px';
            // icon
            const iconSpan = document.createElement('span');
            iconSpan.className = 'mq-toast__icon';
            // build markup similar to mq_scripts ICONS mapping
            const ICONS_HTML = {
                'default': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.93 4.588a.5.5 0 0 1-.858.514 1.5 1.5 0 1 0 0 2.796.5.5 0 1 1 .858.514A2.5 2.5 0 1 1 8 5.587zM8 11a.5.5 0 0 1 0 1 .5.5 0 0 1 0-1z"/></svg>',
                'check': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M13.485 3.929a1 1 0 0 1 0 1.414l-7.07 7.071a1 1 0 0 1-1.415 0L2.515 9.91a1 1 0 1 1 1.414-1.414l1.486 1.486 6.363-6.364a1 1 0 0 1 1.207-.295z"/></svg>',
                'bell': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 16a2 2 0 0 0 1.985-1.75H6.015A2 2 0 0 0 8 16zm.104-14.5A1 1 0 0 0 7 1H9a1 1 0 0 0-.104.5c-.03.29-.07.68-.07 1.5H8c0-.82-.04-1.21-.104-1.5zM5 6a3 3 0 0 1 6 0c0 1.098.216 1.934.503 2.5H4.497C4.784 7.934 5 7.098 5 6z"/></svg>',
                'info': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm.93 4.588a.5.5 0 0 1-.858.514 1.5 1.5 0 1 0 0 2.796.5.5 0 1 1 .858.514A2.5 2.5 0 1 1 8 5.587zM8 11a.5.5 0 0 1 0 1 .5.5 0 0 1 0-1z"/></svg>',
                'warning': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M7.001 1.5a1 1 0 0 1 .998 0l6 3.464A1 1 0 0 1 15 6.366v3.268a1 1 0 0 1-.999.902l-6  .5a1 1 0 0 1-.999 0l-6-.5A1 1 0 0 1 1 9.634V6.366a1 1 0 0 1 .001-.902L7.001 1.5zM7.5 5a.5.5 0 0 0-1 0v3a.5.5 0 0 0 1 0V5zm0 5a.5.5 0 0 0-1 0v1a.5.5 0 0 0 1 0v-1z"/></svg>',
                'danger': '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M8 1.333A6.667 6.667 0 1 0 8 14.667 6.667 6.667 0 0 0 8 1.333zm0 4a.667.667 0 0 1 .667.667v3.333A.667.667 0 0 1 8 10a.667.667 0 0 1-.667-.667V6A.667.667 0 0 1 8 5.333zM8 11.333a.667.667 0 1 1 0 1.333.667.667 0 0 1 0-1.333z"/></svg>'
            };
            iconSpan.innerHTML = ICONS_HTML[s.icon] || ICONS_HTML['default'];
            el.appendChild(iconSpan);
            const msg = document.createElement('div');
            msg.className = 'mq-toast__msg';
            msg.innerText = 'Preview: Toast (' + (s.enabled ? 'enabled' : 'disabled') + ', ' + (s.position||'') + ')';
            el.appendChild(msg);
            // add close button for preview
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'btn btn-sm btn-light';
            closeBtn.style.marginLeft = '12px';
            closeBtn.innerText = 'Close';
            closeBtn.addEventListener('click', () => { area.innerHTML = ''; });
            el.appendChild(closeBtn);
            area.appendChild(el);
        } catch (e) { console.warn('renderPreview error', e); }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        // load local first
        let s = loadLocal();
        // if sync enabled and token present, attempt to fetch server settings and merge
        if (s.syncToServer && s.userToken) {
            const server = await fetchServerSettings(s.userToken);
            if (server) {
                s = Object.assign({}, s, server);
            }
        }
        applyToForm(s);
        renderPreview(s);

        // live preview on change
        const inputs = ['toast-enable','toast-duration','toast-position','toast-icon','toast-sync-server','toast-user-token','toast-type-success','toast-type-info','toast-type-warning','toast-type-danger'];
        inputs.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('change', () => {
                const cur = readForm();
                renderPreview(cur);
            });
            el.addEventListener('input', () => {
                const cur = readForm();
                renderPreview(cur);
            });
        });

        document.getElementById('toast-save').addEventListener('click', async () => {
            const newS = readForm();
            saveLocal(newS);
            let msgText = 'Toast settings saved locally.';
            // optionally push to server
            if (newS.syncToServer && newS.userToken) {
                const res = await postServerSettings(newS.userToken, newS);
                if (res && res.ok) msgText = 'Toast settings saved locally and synced to server.';
                else msgText = 'Saved locally; server sync failed: ' + (res && res.message ? res.message : (res && res.status ? 'HTTP ' + res.status : 'unknown'));
            }
            const msg = document.getElementById('settings-msg');
            msg.innerText = msgText; msg.style.display='block';
            setTimeout(()=>{ msg.style.display='none'; }, 4000);
        });

        document.getElementById('toast-reset').addEventListener('click', async () => {
            saveLocal(defaults);
            applyToForm(defaults);
            renderPreview(defaults);
            const msg = document.getElementById('settings-msg');
            msg.innerText = 'Toast settings reset to defaults.'; msg.style.display='block';
            setTimeout(()=>{ msg.style.display='none'; }, 3000);
            // if user requested server sync, push defaults
            const cur = readForm();
            if (cur.syncToServer && cur.userToken) {
                await postServerSettings(cur.userToken, defaults);
            }
        });
    });
})();
