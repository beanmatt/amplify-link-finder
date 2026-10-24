const { entrypoints } = require("uxp");
const { app, LinkStatus, ScriptLanguage } = require("indesign");
const uxp = require("uxp");
const { storage } = uxp;
const localFs = storage.localFileSystem;

const TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const DRIVE_URL  = 'https://www.googleapis.com/drive/v3';
const SIGNIN_URL = 'https://beanmatt.github.io/amplify-link-finder/';

const WORKSPACE_MIMES = new Set([
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
    'application/vnd.google-apps.drawing',
    'application/vnd.google-apps.form',
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.shortcut',
]);

let creds     = null;
let token     = null;
let rootNode  = null;
let outputDir = '';

function toFormBody(obj) {
    return Object.keys(obj)
        .map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); })
        .join('&');
}

async function readPluginFile(filename) {
    try {
        const entry = await localFs.getEntryWithUrl('plugin:///' + filename);
        return await entry.read({ format: storage.formats.utf8 });
    } catch(e) {}
    try {
        const dataFolder = await localFs.getDataFolder();
        const entries    = await dataFolder.getEntries();
        for (const e of entries) {
            if (e.name === filename) return await e.read({ format: storage.formats.utf8 });
        }
    } catch(e) {}
    return null;
}

async function writePluginFile(filename, content) {
    try {
        const dataFolder = await localFs.getDataFolder();
        const file       = await dataFolder.createFile(filename, { overwrite: true });
        await file.write(content, { format: storage.formats.utf8 });
    } catch(e) { console.error('Error writing file:', e); }
}

async function deletePluginFile(filename) {
    try {
        const dataFolder = await localFs.getDataFolder();
        const entries    = await dataFolder.getEntries();
        for (const e of entries) {
            if (e.name === filename) { await e.delete(); break; }
        }
    } catch(e) {}
}

async function setupLinksFolder() {
    const script =
        "if (app.documents.length === 0) { 'NO_DOC'; } else {" +
        "var doc = app.activeDocument;" +
        "if (!doc.saved) { 'UNSAVED'; } else {" +
        "var docFile = new File(doc.fullName);" +
        "var linksFolder = new Folder(docFile.parent.fsName + '/Links');" +
        "if (!linksFolder.exists) linksFolder.create();" +
        "linksFolder.fsName; }}";
    const result = app.doScript(script, ScriptLanguage.javascript);
    if (result === 'NO_DOC')  throw new Error('No document is open in InDesign.');
    if (result === 'UNSAVED') throw new Error('Please save your InDesign document first.');
    if (!result)              throw new Error('Could not determine document folder.');
    outputDir = result;
    return outputDir;
}

async function setupDownloadFolder() {
    const desktopPath = app.doScript('Folder.desktop.fsName;', ScriptLanguage.javascript);
    const folderPath  = desktopPath + '/Found Links';
    const script =
        "var f = new Folder('" + folderPath.replace(/'/g, "\\'") + "');" +
        "if (!f.exists) f.create(); f.fsName;";
    outputDir = app.doScript(script, ScriptLanguage.javascript);
    return outputDir;
}

async function writeDownloadedFile(fileName, arrayBuffer) {
    const desktopPath = app.doScript('Folder.desktop.fsName;', ScriptLanguage.javascript);
    const ext         = fileName.lastIndexOf('.') > -1 ? fileName.substring(fileName.lastIndexOf('.')) : '';
    const tempName    = 'amp_temp_' + Date.now() + ext;
    const tempPath    = desktopPath + '/' + tempName;
    const tempUrl     = 'file://' + tempPath.split('/').map(function(s, i) {
        return i === 0 ? s : encodeURIComponent(s);
    }).join('/');

    try {
        const tempEntry = await localFs.createEntryWithUrl(tempUrl, { overwrite: true });
        await tempEntry.write(new Uint8Array(arrayBuffer), { format: storage.formats.binary });
    } catch(e) { throw new Error('Could not write temp file: ' + e.message); }

    const safeTempPath = tempPath.replace(/'/g, "\\'");
    const safeFolder   = outputDir.replace(/'/g, "\\'");
    const safeFileName = fileName.replace(/'/g, "\\'");
    const script =
        "var src = new File('" + safeTempPath + "');" +
        "var folder = new Folder('" + safeFolder + "');" +
        "if (!folder.exists) folder.create();" +
        "var dst = new File(folder.fsName + '/' + '" + safeFileName + "');" +
        "if (!src.exists) { 'src_not_found'; } else {" +
        "if (dst.exists) dst.remove();" +
        "src.copy(dst.fsName); src.remove();" +
        "dst.exists ? 'ok' : 'copy_failed'; }";
    const result = app.doScript(script, ScriptLanguage.javascript);
    if (result !== 'ok') throw new Error('Could not copy file to folder: ' + result);
}

async function loadCredentials() {
    const raw = await readPluginFile('credentials.json');
    if (!raw) throw new Error('credentials.json not found in plugin folder.');
    const parsed = JSON.parse(raw);
    const data   = parsed.installed || parsed.web || parsed;
    if (!data.client_id || !data.client_secret) throw new Error('credentials.json missing client_id or client_secret.');
    creds = { client_id: data.client_id, client_secret: data.client_secret };
}

async function loadToken() {
    try {
        const raw = await readPluginFile('token.json');
        if (raw) { token = JSON.parse(raw); return true; }
    } catch(e) {}
    token = null;
    return false;
}

async function saveToken(data) {
    token = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token || (token && token.refresh_token) || '',
        expiry:        data.expiry || (Date.now() + ((data.expires_in || 3600) * 1000)),
        email:         data.email || (token && token.email) || ''
    };
    await writePluginFile('token.json', JSON.stringify(token, null, 2));
}

async function clearToken() {
    token = null;
    await deletePluginFile('token.json');
}

function isSignedIn()   { return !!(token && token.access_token); }
function isTokenFresh() { return isSignedIn() && Date.now() < (token.expiry || 0) - 60000; }

async function refreshAccessToken() {
    if (!token || !token.refresh_token) throw new Error('NOT_AUTHENTICATED');
    const resp = await fetch(TOKEN_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    toFormBody({
            client_id:     creds.client_id,
            client_secret: creds.client_secret,
            refresh_token: token.refresh_token,
            grant_type:    'refresh_token'
        })
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error('NOT_AUTHENTICATED');
    await saveToken(data);
    return token.access_token;
}

async function getValidToken() {
    if (isTokenFresh()) return token.access_token;
    if (token && token.refresh_token) {
        try { return await refreshAccessToken(); } catch(e) {}
    }
    throw new Error('NOT_AUTHENTICATED');
}

async function signOut() {
    await clearToken();
    clearLog();
    showView('signin');
}

async function signInWithToken(tokenStr) {
    var errEl = el('signin-error');
    try {
        var parsed = JSON.parse(tokenStr.trim());
        if (!parsed.access_token) throw new Error('Invalid token');
        await saveToken(parsed);
        var emailEl = el('account-email');
        if (emailEl && parsed.email) emailEl.textContent = '✓ ' + parsed.email;
        showView('main');
        clearLog();
        log('✓ Signed in as ' + parsed.email, 'success');
        log('Plugin ready. Click a button to start.', 'success');
    } catch(e) {
        if (errEl) {
            errEl.textContent   = 'Invalid token — please copy it again from the browser.';
            errEl.style.display = 'block';
        }
    }
}

function openSignInPage() {
    try {
        app.doScript(
            'do shell script "open \\"' + SIGNIN_URL + '\\""',
            ScriptLanguage.applescriptLanguage
        );
        return;
    } catch(e) { console.log('AppleScript open failed:', e); }

    var errEl = el('signin-error');
    if (errEl) {
        errEl.textContent   = 'Open this URL in your browser: ' + SIGNIN_URL;
        errEl.style.display = 'block';
    }
}

async function searchDrive(filename) {
    const tkn     = await getValidToken();
    const name    = filename.split('/').pop().split('\\').pop();
    const escaped = name.replace(/'/g, "\\'");
    const query   = "name='" + escaped + "' and trashed=false";
    const results = [];
    let pageToken;

    do {
        const params = {
            q:                         query,
            fields:                    'nextPageToken,files(id,name,mimeType,size,modifiedTime,imageMediaMetadata)',
            pageSize:                  '100',
            includeItemsFromAllDrives: 'true',
            supportsAllDrives:         'true',
            corpora:                   'allDrives'
        };
        if (pageToken) params.pageToken = pageToken;
        const url  = new URL(DRIVE_URL + '/files');
        url.search = toFormBody(params);
        const resp = await fetch(url.toString(), { headers: { Authorization: 'Bearer ' + tkn } });
        if (resp.status === 401) throw new Error('NOT_AUTHENTICATED');
        if (!resp.ok) throw new Error('Drive API error ' + resp.status);
        const data  = await resp.json();
        const files = data.files || [];
        for (let i = 0; i < files.length; i++) {
            if (!WORKSPACE_MIMES.has(files[i].mimeType)) results.push(files[i]);
        }
        pageToken = data.nextPageToken;
    } while (pageToken);

    return results;
}

function pickBest(files) {
    let best = null;
    for (let i = 0; i < files.length; i++) {
        const f   = files[i];
        const img = f.imageMediaMetadata || {};
        const px  = (img.width || 0) * (img.height || 0);
        const sc  = px || parseInt(f.size || 0);
        if (!best) { best = f; continue; }
        const bi  = best.imageMediaMetadata || {};
        const bsc = ((bi.width || 0) * (bi.height || 0)) || parseInt(best.size || 0);
        if (sc > bsc || (sc === bsc && (f.modifiedTime || '') > (best.modifiedTime || ''))) best = f;
    }
    return best;
}

async function downloadDriveFile(fileId, fileName) {
    const tkn  = await getValidToken();
    const resp = await fetch(
        DRIVE_URL + '/files/' + fileId + '?alt=media&supportsAllDrives=true',
        { headers: { Authorization: 'Bearer ' + tkn } }
    );
    if (resp.status === 401) throw new Error('NOT_AUTHENTICATED');
    if (!resp.ok) throw new Error('Download HTTP ' + resp.status);
    await writeDownloadedFile(fileName, await resp.arrayBuffer());
}

function getMissingLinks() {
    const script =
        "if (app.documents.length === 0) { 'NO_DOC'; } else {" +
        "var missing = []; var seen = {};" +
        "var doc = app.activeDocument;" +
        "for (var i = 0; i < doc.links.length; i++) {" +
        "  var lnk = doc.links[i];" +
        "  if (lnk.status === LinkStatus.LINK_MISSING && !seen[lnk.name]) {" +
        "    seen[lnk.name] = true; missing.push(lnk.name);" +
        "  }" +
        "} missing.join('|'); }";
    const result = app.doScript(script, ScriptLanguage.javascript);
    if (result === 'NO_DOC') throw new Error('No document is open in InDesign.');
    if (!result || result === 'EvalScript_ErrMessage') return [];
    return result === '' ? [] : result.split('|');
}

function relinkAndUpdateAll(dir) {
    // This script relinks ALL links that have a matching file in the Links folder
    // regardless of status, then updates any out-of-date links
    const safe   = dir.replace(/\\/g, '/').replace(/'/g, "\\'");
    const script =
        "var doc = app.activeDocument;" +
        "var folder = new Folder('" + safe + "');" +
        "var cnt = 0; var skip = []; var fail = [];" +
        "for (var i = 0; i < doc.links.length; i++) {" +
        "  var lnk = doc.links[i];" +
        "  var parts = lnk.name.split('/');" +
        "  var fname = parts[parts.length - 1];" +
        "  var f = new File(folder.fsName + '/' + fname);" +
        "  if (!f.exists) { skip.push(fname); continue; }" +
        "  try {" +
        "    lnk.relink(f);" +
        "    cnt++;" +
        "  } catch(e) { fail.push(fname); }" +
        "}" +
        // Now update any out-of-date links
        "for (var j = 0; j < doc.links.length; j++) {" +
        "  try {" +
        "    if (doc.links[j].status === LinkStatus.LINK_OUT_OF_DATE) {" +
        "      doc.links[j].update();" +
        "    }" +
        "  } catch(e) {}" +
        "}" +
        "JSON.stringify({count: cnt, skipped: skip, failed: fail});";

    try {
        const raw    = app.doScript(script, ScriptLanguage.javascript);
        const result = JSON.parse(raw);
        return result;
    } catch(e) {
        console.error('Relink error:', e);
        return { count: 0, skipped: [], failed: [] };
    }
}

async function run(runMode) {
    clearLog();
    setProgress(0);
    setStatus('Starting...');

    const btnRelink   = el('btn-run');
    const btnDownload = el('btn-download');
    if (btnRelink)   btnRelink.classList.add('btn-disabled');
    if (btnDownload) btnDownload.classList.add('btn-disabled');

    try {
        await loadCredentials();
        await getValidToken();

        log('Scanning for missing links...', 'info');
        const missing = getMissingLinks();

        if (missing.length === 0) {
            log('✓ No missing links — all links present!', 'success');
            setStatus('All links present ✓');
            setProgress(100);
            return;
        }

        log('Found ' + missing.length + ' missing link(s):', 'info');
        for (let i = 0; i < missing.length; i++) log('  • ' + missing[i], 'info');
        setProgress(10);

        let dir = '';
        if (runMode === 'relink') {
            log('\nSetting up Links folder...', 'info');
            dir = await setupLinksFolder();
        } else {
            log('\nSetting up Found Links folder on Desktop...', 'info');
            dir = await setupDownloadFolder();
        }
        log('  ' + dir, 'dim');

        let downloaded = 0;
        const notFound = [];
        const errors   = [];

        for (let i = 0; i < missing.length; i++) {
            const name = missing[i];
            setProgress(10 + Math.floor((i / missing.length) * 70));
            setStatus('Searching: ' + name);
            log('\n▸ ' + name, 'info');

            try {
                const matches = await searchDrive(name);
                if (!matches.length) {
                    log('  ✗ Not found on Drive', 'warn');
                    notFound.push(name);
                    continue;
                }

                const best  = pickBest(matches);
                const img   = best.imageMediaMetadata || {};
                const px    = (img.width || 0) * (img.height || 0);
                const label = px
                    ? img.width + '×' + img.height + 'px'
                    : Math.round(parseInt(best.size || 0) / 1024).toLocaleString() + ' KB';

                log('  Found ' + matches.length + ' match(es) — best: ' + label, 'info');
                setStatus('Downloading: ' + name);
                await downloadDriveFile(best.id, best.name);
                log('  ✓ Downloaded', 'success');
                downloaded++;

            } catch(e) {
                if (e.message === 'NOT_AUTHENTICATED') throw e;
                log('  ✗ Error: ' + e.message, 'error');
                errors.push(name);
            }
        }

        setProgress(88);

        if (runMode === 'relink' && downloaded > 0) {
            setStatus('Relinking and updating...');
            log('\nRelinking files in InDesign...', 'info');
            const rl = relinkAndUpdateAll(dir);
            log('✓ Relinked: ' + rl.count + ' file(s)', 'success');
            if (rl.skipped.length) log('— No match found for: ' + rl.skipped.join(', '), 'dim');
            if (rl.failed.length)  log('✗ Failed: ' + rl.failed.join(', '), 'error');
        }

        setProgress(100);
        setStatus('Done ✓  Downloaded: ' + downloaded + '  Not found: ' + notFound.length);
        log('\n──────────────────────────────────', 'dim');
        log('Downloaded : ' + downloaded + ' / ' + missing.length, 'info');
        if (notFound.length) log('Not found  : ' + notFound.join(', '), 'warn');
        if (errors.length)   log('Errors     : ' + errors.join(', '), 'error');
        log(runMode === 'relink' ? 'Saved to Links folder next to your InDesign file' : 'Saved to Desktop/Found Links', 'info');
        log('✓ All done!', 'success');

    } catch(e) {
        if (e.message === 'NOT_AUTHENTICATED') {
            log('Session expired — please sign in again.', 'warn');
            setStatus('Please sign in again');
            await clearToken();
            showView('signin');
        } else {
            log('\nERROR: ' + e.message, 'error');
            setStatus('Error — see log above');
            console.error(e);
        }
    } finally {
        if (btnRelink)   btnRelink.classList.remove('btn-disabled');
        if (btnDownload) btnDownload.classList.remove('btn-disabled');
    }
}

function el(id) { return rootNode ? rootNode.querySelector('#' + id) : null; }

function showView(name) {
    ['signin', 'main'].forEach(function(v) {
        var e = el('view-' + v);
        if (e) e.style.display = v === name ? 'flex' : 'none';
    });
}

function log(msg, type) {
    var logEl = el('log');
    if (!logEl) return;
    var colors = { info: '#b0b0b0', success: '#4caf50', warn: '#ff9800', error: '#f44336', dim: '#444' };
    var div = document.createElement('div');
    div.style.color      = colors[type] || '#b0b0b0';
    div.style.fontSize   = '10px';
    div.style.fontFamily = 'monospace';
    div.style.lineHeight = '1.6';
    div.textContent      = msg;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
}

function clearLog()     { var l = el('log');          if (l) l.innerHTML = ''; }
function setStatus(msg) { var s = el('status');        if (s) s.textContent = msg; }
function setProgress(p) { var b = el('progress-bar'); if (b) b.style.width = Math.min(100, Math.max(0, p)) + '%'; }

function buildUI(node) {
    node.innerHTML = [
        '<style>',
        '* { box-sizing: border-box; margin: 0; padding: 0; }',
        '#root { background: #323232; color: #e0e0e0; padding: 12px; display: flex; flex-direction: column; gap: 10px; height: 100%; font-family: sans-serif; font-size: 12px; }',
        '.view { display: none; flex-direction: column; gap: 10px; flex: 1; min-height: 0; }',
        '#focus-trap { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }',
        '#panel-header { width: 100%; overflow: hidden; background: #1a1a1a; display: flex; align-items: center; justify-content: center; border-radius: 4px; margin-bottom: 4px; flex-shrink: 0; }',
        '#panel-header img { max-width: 100%; height: auto; display: block; }',
        '#panel-header-text { color: #F37321; font-size: 14px; font-weight: 700; letter-spacing: 1px; padding: 10px 0; }',
        '.signin-box { background: #1e1e1e; border: 1px solid #3a3a3a; border-radius: 6px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }',
        '.signin-title { font-size: 13px; font-weight: 700; color: #fff; }',
        '.signin-step { font-size: 11px; color: #aaa; line-height: 1.6; }',
        '.signin-step strong { color: #fff; }',
        'textarea { width: 100%; height: 70px; background: #111; color: #8bc34a; border: 1px solid #333; border-radius: 4px; padding: 8px; font-size: 9px; font-family: monospace; resize: none; }',
        '.account-bar { background: #1e1e1e; border: 1px solid #3a3a3a; border-radius: 4px; padding: 6px 10px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; }',
        '.account-email { font-size: 10px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }',
        '.btn-group { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; flex-shrink: 0; }',
        '.btn-divider { font-size: 9px; color: #777; text-align: center; text-transform: uppercase; letter-spacing: 1px; padding: 2px 0; font-style: italic; }',
        '.btn-primary, .btn-secondary-action, .btn-signout { padding: 8px 12px; border-radius: 3px; font-size: 12px; font-weight: 600; cursor: pointer; width: 100%; text-align: center; user-select: none; display: block; }',
        '.btn-primary { background: #F37321; color: #fff; }',
        '.btn-primary:hover { background: #d4611a; }',
        '.btn-secondary-action { background: #F37321; color: #fff; }',
        '.btn-secondary-action:hover { background: #d4611a; }',
        '.btn-signout { background: #3a3a3a; color: #ccc; font-size: 10px; padding: 4px 8px; width: auto; display: inline-block; }',
        '.btn-signout:hover { background: #4a4a4a; }',
        '.btn-disabled { background: #404040 !important; color: #666 !important; cursor: not-allowed !important; }',
        '.progress-track { background: #1e1e1e; height: 8px; overflow: hidden; margin-top: 4px; flex-shrink: 0; }',
        '#progress-bar { height: 100%; width: 0%; background: #ffffff; transition: width 0.3s ease; }',
        '#status { font-size: 10px; color: #777; min-height: 14px; font-style: italic; flex-shrink: 0; }',
        '#log { flex: 1; overflow-y: scroll; background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 3px; padding: 8px; min-height: 0; max-height: 300px; }',
        '</style>',

        '<div id="root">',
        '<input id="focus-trap" type="text" tabindex="0" aria-hidden="true"/>',

        '<div id="panel-header">',
        '<img src="header.png" style="max-width:100%;height:auto;display:block;"/>',
        '<span id="panel-header-text" style="display:none;">AMPLIFY LINK FINDER</span>',
        '</div>',

        '<div id="view-signin" class="view">',
        '<div class="signin-box">',
        '<div class="signin-title">Connect to Google Drive</div>',
        '<div class="signin-step"><strong>Step 1</strong> — Click below to open the sign-in page in your browser.</div>',
        '<div id="btn-open-browser" class="btn-primary">&#127758; Sign In via Browser</div>',
        '<div class="signin-step"><strong>Step 2</strong> — Sign in with your Google account. When done, copy the token shown and paste it below.</div>',
        '<textarea id="token-input" placeholder="Paste your token here..."></textarea>',
        '<div id="btn-submit-token" class="btn-primary">&#10003; Sign In</div>',
        '<div id="signin-error" style="display:none;font-size:10px;color:#f44336;text-align:center;padding-top:4px;"></div>',
        '</div>',
        '</div>',

        '<div id="view-main" class="view">',
        '<div class="account-bar">',
        '<div id="account-email" class="account-email">Signed in to Google Drive</div>',
        '<div id="btn-signout" class="btn-signout">Sign Out</div>',
        '</div>',
        '<div class="btn-group">',
        '<div id="btn-run" class="btn-primary">&#9654; Find &amp; Relink Missing Files</div>',
        '<div class="btn-divider">— or —</div>',
        '<div id="btn-download" class="btn-secondary-action">&#11015; Find &amp; Download Missing Files</div>',
        '</div>',
        '<div class="progress-track"><div id="progress-bar"></div></div>',
        '<div id="status">Ready</div>',
        '<div id="log"></div>',
        '</div>',

        '</div>'
    ].join('');

    var focusTrap = el('focus-trap');
    if (focusTrap) setTimeout(function() { focusTrap.focus(); }, 100);

    var btnBrowser = el('btn-open-browser');
    if (btnBrowser) {
        btnBrowser.addEventListener('click', function() {
            if (focusTrap) focusTrap.focus();
            openSignInPage();
        });
    }

    var btnSubmitToken = el('btn-submit-token');
    if (btnSubmitToken) {
        btnSubmitToken.addEventListener('click', async function() {
            if (focusTrap) focusTrap.focus();
            var tokenInput = el('token-input');
            if (tokenInput && tokenInput.value.trim()) {
                await signInWithToken(tokenInput.value.trim());
            }
        });
    }

    var btnSignout = el('btn-signout');
    if (btnSignout) {
        btnSignout.addEventListener('click', async function() {
            if (focusTrap) focusTrap.focus();
            await signOut();
        });
    }

    var btnRun = el('btn-run');
    if (btnRun) {
        btnRun.addEventListener('click', function() {
            if (btnRun.classList.contains('btn-disabled')) return;
            if (focusTrap) focusTrap.focus();
            run('relink');
        });
    }

    var btnDownload = el('btn-download');
    if (btnDownload) {
        btnDownload.addEventListener('click', function() {
            if (btnDownload.classList.contains('btn-disabled')) return;
            if (focusTrap) focusTrap.focus();
            run('download');
        });
    }
}

entrypoints.setup({
    panels: {
        amplifyPanel: {
            show: async function(node) {
                rootNode = node;
                buildUI(node);
                try {
                    await loadCredentials();
                    await loadToken();
                    if (isSignedIn()) {
                        var emailEl = el('account-email');
                        if (emailEl && token.email) emailEl.textContent = '✓ ' + token.email;
                        showView('main');
                        log('Plugin ready. Click a button to start.', 'success');
                    } else {
                        showView('signin');
                    }
                } catch(e) {
                    showView('signin');
                    console.error('Startup error:', e);
                }
            }
        }
    }
});
