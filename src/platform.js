// Apply platform chrome before the first paint or any asynchronous bootstrap.
document.documentElement.classList.toggle('mac-style', window.bridge?.platform === 'darwin');
