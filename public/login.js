import { language, setupPreferences, t } from './i18n.js';

const $ = id => document.getElementById(id);
const form = $('login-form');
const user = $('login-user');
const password = $('login-password');
const toggle = $('password-toggle');
const code = $('login-code');
const back = $('login-back');
const submit = $('login-submit');
const error = $('login-error');
let needsCode = false;
let pending = false;
let message = '';

function render() {
  const title = t(needsCode ? 'Kodla doğrula' : 'Giriş yap');
  $('login-title').textContent = title;
  document.title = title + ' | kWhTracker';
  $('login-credentials').hidden = needsCode;
  $('login-code-field').hidden = !needsCode;
  $('login-hint').hidden = !needsCode;
  back.hidden = !needsCode;
  toggle.textContent = t(password.type === 'text' ? 'Gizle' : 'Göster');
  toggle.setAttribute('aria-label', t(password.type === 'text' ? 'Parolayı gizle' : 'Parolayı göster'));
  code.required = needsCode;
  submit.disabled = pending;
  back.disabled = pending;
  submit.textContent = t(pending ? 'Kontrol ediliyor…' : needsCode ? 'Doğrula ve giriş yap' : 'Giriş yap');
  error.textContent = t(message);
  error.hidden = !message;
  form.setAttribute('aria-busy', String(pending));
}

toggle.hidden = false;
toggle.addEventListener('click', () => {
  password.type = password.type === 'password' ? 'text' : 'password';
  render();
});
back.addEventListener('click', () => {
  needsCode = false;
  message = '';
  code.value = '';
  render();
  user.focus();
});
code.addEventListener('input', () => { code.value = code.value.replace(/\D/g, '').slice(0, 6); });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (pending) return;
  message = '';
  pending = true;
  render();
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Language': language },
      body: JSON.stringify({ user: user.value, password: password.value,
        remember: $('remember-login').checked, code: needsCode ? code.value : undefined })
    });
    const result = await response.json();
    if (!response.ok) {
      message = result.error;
      if (needsCode && response.status === 401) needsCode = false;
    } else if (result.needsCode) {
      needsCode = true;
      password.type = 'password';
    } else {
      location.reload();
      return;
    }
  } catch {
    message = 'Sunucudan yanıt alınamadı.';
  }
  pending = false;
  render();
  if (needsCode) {
    code.focus();
    code.select();
  } else if (message) {
    password.focus();
    password.select();
  }
});

setupPreferences(render);
