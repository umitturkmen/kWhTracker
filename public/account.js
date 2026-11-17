import { t } from './i18n.js';

const $ = id => document.getElementById(id);

export function setupAccount(api) {
  const dialog = $('security-dialog');
  const form = $('security-form');
  const password = $('security-password');
  const code = $('security-code');
  const key = $('setup-key');
  const submit = $('security-submit');
  let mode = 'loading';
  let error = '';
  let feedback = '';
  let pending = false;

  const hints = {
    loading: 'Güvenlik durumu alınıyor…',
    off: 'İki adımlı doğrulamayı açmak için panel parolanı gir.',
    setup: 'Uygulamaya hesabı ekle ve üretilen 6 haneli kodu gir.',
    on: 'İki adımlı doğrulama açık.',
    disable: 'İki adımlı doğrulamayı kapatmak için parolanı ve geçerli bir kodu gir.'
  };
  const actionCopy = { off: 'Kuruluma başla', setup: 'Doğrulamayı etkinleştir', disable: 'Doğrulamayı kapat' };

  function render() {
    const showPassword = mode === 'off' || mode === 'disable';
    const showCode = mode === 'setup' || mode === 'disable';
    $('security-status').textContent = t(feedback || hints[mode] || '');
    form.hidden = !actionCopy[mode];
    form.setAttribute('aria-busy', String(pending));
    $('setup-key-field').hidden = mode !== 'setup';
    $('security-password-field').hidden = !showPassword;
    $('security-code-field').hidden = !showCode;
    $('disable-authenticator').hidden = mode !== 'on';
    $('security-back').hidden = mode !== 'setup' && mode !== 'disable';
    $('security-back').disabled = pending;
    $('logout').disabled = pending;
    password.required = showPassword;
    code.required = showCode;
    submit.disabled = pending;
    submit.textContent = t(pending ? 'Kontrol ediliyor…' : actionCopy[mode] || '');
    $('security-error').textContent = t(error);
    $('security-error').hidden = !error;
  }

  function setMode(next) {
    mode = next;
    error = '';
    feedback = '';
    password.value = '';
    code.value = '';
    if (mode !== 'setup') {
      key.value = '';
      $('setup-account').value = '';
    }
  }

  $('account').addEventListener('click', async () => {
    if (pending) return;
    setMode('loading');
    pending = true;
    render();
    dialog.showModal();
    try {
      const status = await api('/api/authenticator');
      setMode(status.enabled ? 'on' : 'off');
    } catch (problem) {
      setMode('unavailable');
      error = problem.message;
    } finally {
      pending = false;
      render();
    }
  });

  $('disable-authenticator').addEventListener('click', () => {
    setMode('disable');
    render();
    password.focus();
  });
  $('security-back').addEventListener('click', () => {
    setMode(mode === 'setup' ? 'off' : 'on');
    render();
    (mode === 'off' ? password : $('disable-authenticator')).focus();
  });
  $('copy-key').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(key.value);
      feedback = 'Kurulum anahtarı kopyalandı.';
    } catch {
      key.focus();
      key.select();
      feedback = 'Kurulum anahtarını kopyalamak için seçili metni kullan.';
    }
    render();
  });
  dialog.addEventListener('close', () => {
    setMode('loading');
    render();
  });
  code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending) return;
    const action = { off: 'setup', setup: 'enable', disable: 'disable' }[mode];
    pending = true;
    error = '';
    feedback = '';
    render();
    try {
      const result = await api('/api/authenticator/' + action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password.value, code: code.value })
      });
      if (!dialog.open) return;
      if (action === 'setup') {
        setMode('setup');
        key.value = result.key;
        $('setup-account').value = 'kWhTracker (' + result.account + ')';
      } else {
        setMode(result.enabled ? 'on' : 'off');
        feedback = result.enabled ? 'İki adımlı doğrulama açıldı.' : 'İki adımlı doğrulama kapatıldı.';
      }
    } catch (problem) {
      if (!dialog.open) return;
      if (problem.message === 'Kurulum süresi doldu. Yeni bir kurulum anahtarı oluştur.') setMode('off');
      error = problem.message;
    } finally {
      pending = false;
      render();
      if (dialog.open && mode === 'setup') {
        code.focus();
        if (error) code.select();
      } else if (dialog.open && (mode === 'off' || mode === 'disable')) {
        const field = mode === 'disable' && error.startsWith('Kod ') ? code : password;
        field.focus();
        if (error) field.select();
      } else if (dialog.open && mode === 'on') $('disable-authenticator').focus();
    }
  });

  $('logout').addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    error = '';
    render();
    try {
      await api('/api/logout', { method: 'POST' });
      location.reload();
      return;
    } catch (problem) {
      error = problem.message;
      pending = false;
      render();
    }
  });

  return render;
}
