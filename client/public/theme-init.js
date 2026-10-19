// Applies the saved theme and language before first paint to avoid a flash.
// Kept as a file (not inline) so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem('hrms.theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  var l = localStorage.getItem('hrms.locale') || 'en';
  document.documentElement.lang = l;
  document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
} catch (e) {}
