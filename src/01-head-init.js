
/* 主题必须在首帧前决定，否则深色模式会先闪一下白底 */
(function () {
  try {
    var m = localStorage.getItem('themeMode') || 'auto';
    var dark = m === 'dark' || (m === 'auto'
      && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
