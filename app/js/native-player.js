/**
 * Reprodutor de Vídeo Nativo de Hardware para LG webOS 5.6.2
 * O elemento <video> do WAM da LG decodifica HLS (.m3u8) e MP4 (H.264/HEVC) via hardware.
 */
(function () {
  'use strict';

  var modal = document.getElementById('native-player-modal');
  var videoEl = document.getElementById('native-video-el');
  var titleEl = document.getElementById('player-title');
  var closeBtn = document.getElementById('btn-close-player');

  var isOpen = false;

  function openPlayer(mediaUrl, title) {
    if (!mediaUrl) return;
    isOpen = true;
    titleEl.textContent = title || mediaUrl;
    modal.classList.remove('hidden');

    videoEl.innerHTML = '';
    var source = document.createElement('source');
    source.src = mediaUrl;
    if (/\.m3u8(\?|$)/i.test(mediaUrl)) {
      source.type = 'application/vnd.apple.mpegurl';
    } else if (/\.mp4(\?|$)/i.test(mediaUrl)) {
      source.type = 'video/mp4';
    }
    videoEl.appendChild(source);
    videoEl.src = mediaUrl;
    try {
      videoEl.load();
      var playPromise = videoEl.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () {});
      }
    } catch (_) {}
    closeBtn.focus();
  }

  function closePlayer() {
    if (!isOpen) return false;
    isOpen = false;
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (_) {}
    modal.classList.add('hidden');
    return true;
  }

  closeBtn.addEventListener('click', closePlayer);

  window.NeoNativePlayer = {
    open: openPlayer,
    close: closePlayer,
    isOpen: function () { return isOpen; }
  };
})();
