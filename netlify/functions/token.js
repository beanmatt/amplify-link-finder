<script>
  const CLIENT_ID    = 'PASTE_YOUR_WEB_CLIENT_ID_HERE';
  const REDIRECT_URI = 'https://amplifylinkfinder.netlify.app/';
  const SCOPE        = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email';
  const TOKEN_FN     = 'https://amplifylinkfinder.netlify.app/.netlify/functions/token';

  function getUrlParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function showError(msg) {
    document.getElementById('loading').style.display      = 'none';
    document.getElementById('main-content').style.display = 'none';
    var box = document.getElementById('error-box');
    box.textContent   = msg;
    box.style.display = 'block';
  }

  function generateRandom(length) {
    var array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array, function(b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  async function generateCodeChallenge(verifier) {
    var data   = new TextEncoder().encode(verifier);
    var digest = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  document.getElementById('btn-signin').addEventListener('click', async function(e) {
    e.preventDefault();
    var verifier  = generateRandom(64);
    var challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem('pkce_verifier', verifier);

    var params = new URLSearchParams({
      client_id:             CLIENT_ID,
      redirect_uri:          REDIRECT_URI,
      response_type:         'code',
      scope:                 SCOPE,
      access_type:           'offline',
      prompt:                'consent',
      code_challenge:        challenge,
      code_challenge_method: 'S256'
    });

    window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
  });

  async function exchangeCode(code) {
    var verifier = sessionStorage.getItem('pkce_verifier');
    if (!verifier) { showError('Session expired. Please try again.'); return; }

    document.getElementById('main-content').style.display = 'none';
    document.getElementById('loading').style.display      = 'block';

    try {
      var resp = await fetch(TOKEN_FN, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          code:          code,
          code_verifier: verifier,
          redirect_uri:  REDIRECT_URI
        })
      });

      var data = await resp.json();

      if (data.error) { showError('Sign in failed: ' + data.error); return; }

      var tokenObj = {
        access_token:  data.access_token,
        refresh_token: data.refresh_token || '',
        expiry:        Date.now() + ((data.expires_in || 3600) * 1000),
        email:         data.email || ''
      };

      document.getElementById('loading').style.display       = 'none';
      document.getElementById('signed-in-email').textContent = '✓ Signed in as ' + data.email;
      document.getElementById('token-display').textContent   = JSON.stringify(tokenObj);
      document.getElementById('token-section').style.display = 'block';

      sessionStorage.removeItem('pkce_verifier');
      window.history.replaceState({}, document.title, REDIRECT_URI);

    } catch(e) {
      showError('Error: ' + e.message);
    }
  }

  document.getElementById('btn-copy').addEventListener('click', function() {
    var text = document.getElementById('token-display').textContent;
    navigator.clipboard.writeText(text).then(function() {
      document.getElementById('copy-success').style.display = 'block';
      document.getElementById('btn-copy').textContent       = '✓ Copied!';
    }).catch(function() {
      var el    = document.getElementById('token-display');
      var range = document.createRange();
      range.selectNodeContents(el);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    });
  });

  var code  = getUrlParam('code');
  var error = getUrlParam('error');
  if (error)     showError('Sign in cancelled: ' + error);
  else if (code) exchangeCode(code);
</script>
