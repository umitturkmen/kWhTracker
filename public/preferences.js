(() => {
  let preference = 'system';
  try {
    preference = localStorage.getItem('kwhtracker.theme') ?? localStorage.getItem('wattiz.theme') ?? 'system';
  } catch {
    // The OS preference is still available when browser storage is blocked.
  }
  document.documentElement.dataset.theme = preference === 'dark' || preference === 'light'
    ? preference : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
