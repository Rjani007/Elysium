// Shared music: the storyteller picks a YouTube track and everyone at the table hears it
// at the same moment. The sound streams from YouTube to each browser; the database only
// stores { videoId, title, position, startedAt, playing, loop } for the table.
//
// YouTube's terms want the player visible while it plays (at least 200 x 200 pixels), so
// the dock shows it whenever it plays here; "stop listening" pauses it before folding it away.

import { el, stored } from './util.js';
import { serverNow } from './supa.js';

let apiPromise = null;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT); };
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.onerror = () => { apiPromise = null; reject(new Error('YouTube could not be reached.')); };
      document.head.append(script);
    });
  }
  return apiPromise;
}

/** Where the track should be right now, in seconds. */
export function musicPosition(state, duration = 0, now = serverNow()) {
  if (!state) return 0;
  let pos = Number(state.position) || 0;
  if (state.playing) pos += (now - Number(state.startedAt)) / 1000;
  if (duration > 0) pos = state.loop ? pos % duration : Math.min(pos, duration);
  return Math.max(0, pos);
}

/**
 * controls (storytellers only): { pause(), resume(), stop(), restart(), loop(on) }
 */
export function musicDock({ controls = null } = {}) {
  let state = null;
  let player = null;
  let playerReady = false;
  let loadedVideo = null;
  let listening = stored('music-listening') !== false;
  let blocked = false;
  let timer = null;

  const title = el('span', { class: 'music-title' }, '');
  const holder = el('div', { class: 'music-video' }, el('div', { id: `yt-${Math.random().toString(36).slice(2)}` }));
  const volume = el('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Music volume for you' });
  volume.value = String(stored('music-volume') ?? 60);
  volume.addEventListener('input', () => {
    stored('music-volume', Number(volume.value));
    if (playerReady) player.setVolume(Number(volume.value));
  });
  const listenBtn = el('button', { class: 'btn btn-small btn-primary', onclick: () => setListening(true) }, '🔊 Listen');
  const stopBtn = el('button', { class: 'btn btn-small', onclick: () => setListening(false) }, 'Stop listening');
  const stControls = controls ? el('div', { class: 'row tight music-st' },
    el('button', { class: 'icon-btn', title: 'Pause for everyone', 'aria-label': 'Pause for everyone', onclick: () => (state?.playing ? controls.pause() : controls.resume()) }, '⏯'),
    el('button', { class: 'icon-btn', title: 'Start again', 'aria-label': 'Start again for everyone', onclick: () => controls.restart() }, '⏮'),
    el('button', { class: 'icon-btn', title: 'Stop the music', 'aria-label': 'Stop the music for everyone', onclick: () => controls.stop() }, '⏹'),
    el('label', { class: 'check small' }, el('input', { type: 'checkbox', onchange: (e) => controls.loop(e.target.checked) }), 'loop')) : null;
  const status = el('span', { class: 'muted small' });

  const node = el('aside', { class: 'music-dock', hidden: true, 'aria-label': 'Music' },
    el('div', { class: 'music-head' }, el('span', { 'aria-hidden': 'true' }, '♪'), title, stControls),
    holder,
    el('div', { class: 'music-foot' }, listenBtn, stopBtn, el('label', { class: 'volume small' }, '🔉', volume), status));

  function setListening(on) {
    listening = on;
    stored('music-listening', on);
    blocked = false;
    sync();
  }

  async function ensurePlayer() {
    if (player) return;
    const YT = await loadYouTube();
    await new Promise((resolve) => {
      player = new YT.Player(holder.firstChild, {
        width: '100%', height: 200,
        host: 'https://www.youtube-nocookie.com',
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0, iv_load_policy: 3, origin: location.origin },
        events: {
          onReady: () => { playerReady = true; player.setVolume(Number(volume.value)); resolve(); },
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED && state?.playing && state.loop) { player.seekTo(0, true); player.playVideo(); }
            if (e.data === YT.PlayerState.PLAYING) { blocked = false; paint(); }
          },
          onAutoplayBlocked: () => { blocked = true; paint(); },
          onError: () => { status.textContent = 'YouTube would not play this track here.'; },
        },
      });
    });
  }

  function paint() {
    node.hidden = !state;
    title.textContent = state ? (state.title || 'Music') : '';
    listenBtn.hidden = listening && !blocked;
    listenBtn.textContent = blocked ? '🔊 Click to hear the music' : '🔊 Listen';
    stopBtn.hidden = !listening || blocked;
    node.classList.toggle('music-folded', !listening || blocked);
    if (!status.textContent.startsWith('YouTube')) status.textContent = state && !state.playing ? 'Paused' : '';
    if (stControls) stControls.querySelector('input[type=checkbox]').checked = !!state?.loop;
  }

  async function sync() {
    paint();
    if (!state) {
      if (playerReady) player.stopVideo();
      loadedVideo = null;
      return;
    }
    try { await ensurePlayer(); } catch (err) { status.textContent = err.message; return; }
    const duration = player.getDuration?.() || 0;
    const pos = musicPosition(state, loadedVideo === state.videoId ? duration : 0);
    if (loadedVideo !== state.videoId) {
      loadedVideo = state.videoId;
      status.textContent = '';
      if (listening && state.playing) player.loadVideoById({ videoId: state.videoId, startSeconds: pos });
      else player.cueVideoById({ videoId: state.videoId, startSeconds: pos });
      return;
    }
    if (!listening || !state.playing) {
      if (player.getPlayerState?.() === window.YT.PlayerState.PLAYING) player.pauseVideo();
      if (!state.playing) player.seekTo(pos, true);
      return;
    }
    if (!state.loop && duration && pos >= duration - 0.5) { player.pauseVideo(); return; }
    if (Math.abs((player.getCurrentTime?.() || 0) - pos) > 2) player.seekTo(pos, true);
    if (player.getPlayerState?.() !== window.YT.PlayerState.PLAYING) player.playVideo();
  }

  return {
    node,
    apply(next) {
      state = next && next.videoId ? next : null;
      sync();
      clearInterval(timer);
      // drift check while playing: tabs throttle timers and buffering stalls
      if (state?.playing) timer = setInterval(() => { if (listening) sync(); }, 5000);
    },
    destroy() {
      clearInterval(timer);
      try { player?.destroy(); } catch { /* already gone */ }
      node.remove();
    },
  };
}
