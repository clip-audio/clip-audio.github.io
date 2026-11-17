import { AudioRing, SilenceFilter, wav } from './audio.js';

const $ = id => document.getElementById(id);
const ROW_HEIGHT = 82;
const PAD = 12;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const SETTINGS_KEY = 'audio-replay-settings';
const DEFAULT_ZOOM = '15';
const DEFAULT_TAIL = 1;
const DEFAULT_BUFFER = 600;
const DEFAULT_SILENCE = '-42';
let ring;
let capture;
let busy = false;
let clip;
let selection;
let drag;
let previewURL;
let clipPlayheadFrame;
let auditioning = true;
let selectionURL;
let auditionTimer;
let auditionStart;
let playheadAnimation;
let recognition;
let restartSpeech;
let firstRow = 0;
let rowCount = 0;
let visibleRow = 0;
let tailSeconds = DEFAULT_TAIL;
let bufferSeconds = DEFAULT_BUFFER;
let rowSeconds = Number(DEFAULT_ZOOM);
let customSelectionName = false;
let encodingMp3 = false;
let customSilence = -42;
let outputDevice = '';
let outputReady = Promise.resolve();
let selectionPlaybackOutput = Promise.resolve();
let clipOutputDevice = '';
let clipOutputReady = Promise.resolve();
let selectedMicrophone = new URLSearchParams(location.hash.slice(1)).get('mic') || '';
const phrases = [];

function validTail(value) {
  return Number.isFinite(value) && value >= 0.1 && value <= 600;
}

try {
  const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  if (Number.isFinite(settings?.customSilence) && settings.customSilence >= -200 && settings.customSilence <= 0) {
    customSilence = settings.customSilence;
  }
  if (typeof settings?.outputDevice === 'string') outputDevice = settings.outputDevice;
  clipOutputDevice = typeof settings?.clipOutputDevice === 'string' ? settings.clipOutputDevice : outputDevice;
  if (settings && Array.from($('zoom').options).some(option => option.value === settings.zoom)) {
    $('zoom').value = settings.zoom;
    rowSeconds = Number(settings.zoom);
  }
  if (validTail(settings?.tailSeconds)) tailSeconds = settings.tailSeconds;
  if (settings && Array.from($('bufferSize').options).some(option => Number(option.value) === settings.bufferSeconds)) {
    bufferSeconds = settings.bufferSeconds;
  }
  $('timestampPrefix').checked = settings?.timestampPrefix !== false;
  if (typeof settings?.filenamePrefix === 'string') $('filenamePrefix').value = settings.filenamePrefix.slice(0, 80);
  $('prefixPosition').value = settings?.prefixPosition === 'before' ? 'before' : 'after';
  auditioning = settings?.autoPreview !== false;
  $('localSpeech').checked = settings?.localSpeech === true;
  if (Array.from($('silence').options).some(option => option.value === settings?.silence)) {
    $('silence').value = settings.silence;
  }
} catch {
  // The app still works when browser storage is disabled or unavailable.
}
$('tail').value = tailSeconds;
$('bufferSize').value = String(bufferSeconds);
$('customSilence').value = customSilence;
$('customSilenceField').hidden = $('silence').value !== 'custom';

function silenceThreshold() {
  return $('silence').value === 'custom' ? customSilence : Number($('silence').value);
}

function saveSettings() {
  updateDownloadNames();
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      zoom: $('zoom').value, tailSeconds, bufferSeconds, timestampPrefix: $('timestampPrefix').checked,
      autoPreview: auditioning, silence: $('silence').value, customSilence, localSpeech: $('localSpeech').checked,
      filenamePrefix: $('filenamePrefix').value, prefixPosition: $('prefixPosition').value, outputDevice, clipOutputDevice
    }));
  } catch {
    // Keep using the current settings for this tab.
  }
}

function clock(seconds) {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function preciseClock(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  return `${clock(milliseconds / 1000)}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function status(message, live = Boolean(capture)) {
  $('status').textContent = message;
  $('status').dataset.live = live;
}

async function listOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const [id, selected] of [['output', outputDevice], ['clipOutput', clipOutputDevice]]) {
    const select = $(id);
    select.replaceChildren(new Option('System default', ''));
    for (const device of devices.filter(device => device.kind === 'audiooutput' && device.deviceId !== 'default')) {
      select.add(new Option(device.label || 'Audio output', device.deviceId));
    }
    if (selected && !Array.from(select.options).some(option => option.value === selected)) {
      select.add(new Option('Saved output · choose to authorize or reconnect', selected));
    }
    select.value = selected;
  }
}

function routePlayer(player, device, message) {
  return player.setSinkId(device)
    .then(() => { message.textContent = ''; return true; })
    .catch(error => {
      player.pause();
      message.textContent = `Choose output device to authorize or reconnect it. ${error.message}`;
      return false;
    });
}

function routeOutput() {
  outputReady = routePlayer($('selectionPlayer'), outputDevice, $('outputStatus'));
  return outputReady;
}

function routeClipOutput() {
  clipOutputReady = routePlayer($('player'), clipOutputDevice, $('clipOutputStatus'));
  return clipOutputReady;
}

for (const isClip of [false, true]) {
  const select = $(isClip ? 'clipOutput' : 'output');
  const choose = $(isClip ? 'chooseClipOutput' : 'chooseOutput');
  const message = $(isClip ? 'clipOutputStatus' : 'outputStatus');
  const route = isClip ? routeClipOutput : routeOutput;
  const setDevice = device => {
    if (isClip) clipOutputDevice = device;
    else outputDevice = device;
    saveSettings();
  };
  select.onchange = () => {
    setDevice(select.value);
    route();
  };
  choose.onclick = async () => {
    try {
      if (navigator.mediaDevices.selectAudioOutput) {
        const device = await navigator.mediaDevices.selectAudioOutput({
          deviceId: isClip ? clipOutputDevice : outputDevice
        });
        setDevice(device.deviceId);
      } else {
        message.textContent = 'Choose an available output from the list. Use List microphones to reveal device names.';
      }
      await listOutputs();
      await route();
    } catch (error) {
      message.textContent = error.message;
    }
  };
}
if (typeof $('player').setSinkId === 'function' && navigator.mediaDevices) {
  listOutputs().catch(() => {});
  routeOutput();
  routeClipOutput();
  navigator.mediaDevices.addEventListener('devicechange', () => listOutputs().catch(() => {}));
} else {
  for (const id of ['output', 'chooseOutput', 'clipOutput', 'chooseClipOutput']) $(id).disabled = true;
  $('outputStatus').textContent = $('clipOutputStatus').textContent = 'This browser uses the system audio output.';
}

async function listMicrophones(activeId) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const select = $('microphone');
  const selected = activeId ?? selectedMicrophone;
  const inputs = devices.filter(device => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default');
  select.replaceChildren(new Option('System default', ''));
  inputs.forEach((device, i) => select.add(new Option(device.label || `Microphone ${i + 1}`, device.deviceId)));
  if (selected && !inputs.some(device => device.deviceId === selected)) {
    select.add(new Option('Saved microphone · grant access or reconnect device', selected));
  }
  select.value = selected;
  if (typeof $('player').setSinkId === 'function') listOutputs().catch(() => {});
}

$('microphone').onchange = () => {
  selectedMicrophone = $('microphone').value;
  const hash = new URLSearchParams(location.hash.slice(1));
  hash.set('mic', selectedMicrophone);
  location.hash = hash.toString();
};

window.addEventListener('hashchange', () => {
  selectedMicrophone = new URLSearchParams(location.hash.slice(1)).get('mic') || '';
  if (!capture && !busy) listMicrophones().catch(() => {});
});

function recordingControls() {
  $('record').disabled = busy;
  $('record').textContent = capture ? 'Stop recording' : 'Start recording';
  $('access').disabled = busy || Boolean(capture);
  $('microphone').disabled = busy || Boolean(capture);
}

$('access').onclick = async () => {
  busy = true;
  recordingControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      await listMicrophones();
      status('Choose a microphone, then start recording.');
    } finally {
      stream.getTracks().forEach(track => track.stop());
    }
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    recordingControls();
  }
};

async function startCapture() {
  const id = selectedMicrophone;
  const context = new AudioContext(ring ? { sampleRate: ring.rate } : undefined);
  let stream;
  try {
    await context.resume();
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(id && { deviceId: { exact: id } }), echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    await context.audioWorklet.addModule(new URL('./capture.js', import.meta.url));
    const source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'replay-capture');
    const buffer = ring ?? new AudioRing(context.sampleRate, bufferSeconds);
    let filter = new SilenceFilter(buffer.rate);
    let silence = silenceThreshold();
    const session = { context, stream, node };
    node.port.onmessage = ({ data }) => {
      if (data === null) session.flushed?.();
      else {
        if (!Object.is(silence, silenceThreshold())) {
          silence = silenceThreshold();
          filter = new SilenceFilter(buffer.rate);
        }
        filter.append(data, buffer, silence);
      }
    };
    source.connect(node).connect(context.destination);
    ring = buffer;
    capture = session;
    const track = stream.getAudioTracks()[0];
    track.addEventListener('ended', () => {
      if (capture === session && !busy) toggleCapture('Microphone disconnected');
    });
    node.addEventListener('processorerror', () => {
      if (capture === session && !busy) toggleCapture('Audio capture stopped unexpectedly');
    });
    listMicrophones(id).catch(() => {});
    status('Recording');
    startSpeech();
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    await context.close();
    throw error;
  }
}

async function stopCapture(message) {
  const session = capture;
  stopSpeech();
  await new Promise(resolve => {
    const timeout = setTimeout(resolve, 300);
    session.flushed = () => {
      clearTimeout(timeout);
      resolve();
    };
    session.node.port.postMessage('flush');
  });
  session.node.port.close();
  session.stream.getTracks().forEach(track => track.stop());
  capture = null;
  await session.context.close();
  status(message);
}

async function toggleCapture(message = 'Stopped · buffer available') {
  busy = true;
  recordingControls();
  try {
    if (capture) await stopCapture(message);
    else await startCapture();
  } catch (error) {
    status(error.message);
  } finally {
    busy = false;
    recordingControls();
    drawHistory();
  }
}

$('record').onclick = () => toggleCapture();
if (navigator.mediaDevices) {
  listMicrophones().catch(() => {});
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!capture && !busy) listMicrophones().catch(() => {});
  });
} else {
  $('record').disabled = $('access').disabled = true;
  status('Open this app on localhost or HTTPS to use the microphone.');
}

function canvasContext(canvas, height) {
  const width = canvas.clientWidth;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  const pixelsWide = Math.round(width * scale);
  const pixelsHigh = Math.round(height * scale);
  if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
    canvas.width = pixelsWide;
    canvas.height = pixelsHigh;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width };
}

function drawHistory(anchorTime) {
  if (!ring?.total) {
    $('wave').hidden = true;
    $('empty').hidden = false;
    $('empty').textContent = capture && $('silence').value !== 'off'
      ? 'Waiting for sound above the silence threshold.'
      : 'Start recording to see the waveform.';
    $('range').value = '00:00 – 00:00';
    $('last').disabled = $('make').disabled = true;
    updateAudition();
    return;
  }
  const { rate, oldest, total } = ring;
  const rowSize = rate * rowSeconds;
  const previousFirst = firstRow;
  firstRow = Math.floor(oldest / rowSize);
  rowCount = Math.ceil(total / rowSize) - firstRow;
  $('range').value = `${clock(oldest / rate)} – ${clock(total / rate)}`;
  $('wave').hidden = false;
  $('empty').hidden = true;
  const history = $('history');
  const wave = $('wave');
  $('rows').style.height = `${rowCount * ROW_HEIGHT}px`;
  if ($('follow').checked && !drag) history.scrollTop = history.scrollHeight;
  else if (Number.isFinite(anchorTime)) {
    history.scrollTop = (Math.floor(anchorTime / rowSeconds) - firstRow) * ROW_HEIGHT;
  } else if (firstRow > previousFirst) {
    history.scrollTop -= (firstRow - previousFirst) * ROW_HEIGHT;
  }
  visibleRow = Math.floor(history.scrollTop / ROW_HEIGHT);
  const visibleEnd = Math.min(rowCount, Math.ceil((history.scrollTop + history.clientHeight) / ROW_HEIGHT));
  const visibleHeight = (visibleEnd - visibleRow) * ROW_HEIGHT;
  wave.style.top = `${visibleRow * ROW_HEIGHT}px`;
  wave.style.height = `${visibleHeight}px`;
  const { ctx, width } = canvasContext(wave, visibleHeight);
  const usable = Math.max(1, width - PAD * 2);
  const xAt = (frame, start) => PAD + (frame - start) / rowSize * usable;
  const [from, to] = selection || [0, 0];
  for (let row = visibleRow; row < visibleEnd; row++) {
    const start = (firstRow + row) * rowSize;
    const left = Math.max(start, oldest);
    const right = Math.min(start + rowSize, total);
    const y = (row - visibleRow) * ROW_HEIGHT;
    const middle = y + 47;
    ctx.fillStyle = '#293745';
    ctx.fillRect(0, y + ROW_HEIGHT - 1, width, 1);
    ctx.fillRect(PAD, middle, usable, 1);
    ctx.fillStyle = '#a4b2c2';
    ctx.font = '11px system-ui';
    ctx.fillText(clock(start / rate), PAD, y + 17);
    const selectedStart = Math.max(left, from);
    const selectedEnd = Math.min(right, to);
    if (selectedEnd > selectedStart) {
      ctx.fillStyle = '#204b41';
      ctx.fillRect(xAt(selectedStart, start), y + 23, xAt(selectedEnd, start) - xAt(selectedStart, start), 49);
    }
    ctx.fillStyle = '#8af2ce';
    for (let x = Math.floor(xAt(left, start)); x < xAt(right, start); x += 2) {
      const frame = start + (x - PAD) * rowSize / usable;
      const peak = ring.peak(frame, frame + 2 * rowSize / usable);
      const amplitude = Math.max(1, Math.sqrt(peak) * 24);
      ctx.fillRect(x, middle - amplitude, 1, amplitude * 2);
    }
  }
  if (selectionIsAvailable()) {
    ctx.fillStyle = '#d3fff0';
    for (const edge of [0, 1]) {
      const handle = selectionHandle(edge, width);
      if (handle.row < visibleRow || handle.row >= visibleEnd) continue;
      const y = (handle.row - visibleRow) * ROW_HEIGHT;
      ctx.fillRect(handle.x - 1, y + 24, 2, 47);
      ctx.fillRect(handle.x - 4, y + 37, 8, 20);
    }
  }
  if (selectionURL) {
    const frame = auditionStart + $('selectionPlayer').currentTime * rate;
    const row = Math.floor(frame / rowSize) - firstRow;
    if (row >= visibleRow && row < visibleEnd) {
      const y = (row - visibleRow) * ROW_HEIGHT;
      const x = xAt(frame, (row + firstRow) * rowSize);
      ctx.fillStyle = '#ffd080';
      ctx.fillRect(x - 1, y + 22, 2, 52);
    }
  }
  $('last').disabled = false;
  $('make').disabled = !selectionIsAvailable();
  updateAudition();
  $('selectionHint').textContent = selection && from < oldest
    ? 'Part of this selection has rolled out of the buffer.'
    : 'Drag across the waveform or enter times to select a clip.';
  while (phrases.length && phrases[0].end <= oldest) phrases.shift().element.remove();
}

function selectionIsAvailable() {
  return selection && selection[0] >= ring.oldest && selection[1] <= ring.total && selection[1] > selection[0];
}

function selectionHandle(edge, width) {
  const frame = selection[edge];
  const rowSize = ring.rate * rowSeconds;
  const absoluteRow = edge === 0 ? Math.floor(frame / rowSize) : Math.ceil(frame / rowSize) - 1;
  const fraction = (frame - absoluteRow * rowSize) / rowSize;
  return { row: absoluteRow - firstRow, x: PAD + fraction * Math.max(1, width - PAD * 2) };
}

function hitHandle(event) {
  if (!selectionIsAvailable()) return null;
  const rect = $('wave').getBoundingClientRect();
  const y = event.clientY - rect.top;
  const row = visibleRow + Math.floor(y / ROW_HEIGHT);
  if (y % ROW_HEIGHT < 20 || y % ROW_HEIGHT > 75) return null;
  let nearest = null;
  let distance = 12;
  for (const edge of [0, 1]) {
    const handle = selectionHandle(edge, rect.width);
    const gap = Math.abs(event.clientX - rect.left - handle.x);
    if (handle.row === row && gap < distance) {
      nearest = edge;
      distance = gap;
    }
  }
  return nearest;
}

function selectRange(a, b) {
  setSelection([Math.min(a, b), Math.max(a, b)]);
  $('from').value = (selection[0] / ring.rate).toFixed(3);
  $('to').value = (selection[1] / ring.rate).toFixed(3);
}

function setSelection(next) {
  const changed = next?.[0] !== selection?.[0] || next?.[1] !== selection?.[1];
  selection = next;
  if (changed && !auditioning) clearSelectionAudio();
  drawHistory();
  if (changed && auditioning) queueAudition();
}

function pointerFrame(event, offset = 0) {
  const rect = $('wave').getBoundingClientRect();
  const row = Math.min(rowCount - 1, Math.max(0, visibleRow + Math.floor((event.clientY - rect.top) / ROW_HEIGHT)));
  const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left - PAD - offset) / Math.max(1, rect.width - PAD * 2)));
  return Math.min(ring.total, Math.max(ring.oldest, Math.round((firstRow + row + fraction) * rowSeconds * ring.rate)));
}

$('wave').ondblclick = event => {
  if (!ring?.total) return;
  const frame = pointerFrame(event);
  const segment = ring.soundSegments.find(segment => frame >= segment.start && frame < segment.end);
  if (!segment) return;
  $('follow').checked = false;
  const origin = Math.max(ring.oldest, segment.start);
  const end = Math.min(ring.total, segment.end);
  const samples = ring.copy(origin, end);
  const [left, right] = soundEdges(samples, 0, samples.length);
  selectRange(origin + left, origin + right);
};

$('wave').oncontextmenu = event => {
  if (!selectionIsAvailable()) return;
  const frame = pointerFrame(event);
  if (frame < selection[0] || frame >= selection[1]) return;
  event.preventDefault();
  playSelection(false, frame, true);
};

$('wave').onpointerdown = event => {
  if (event.button !== 0 || !ring?.total || drag) return;
  $('follow').checked = false;
  const edge = hitHandle(event);
  const rect = $('wave').getBoundingClientRect();
  const offset = edge === null ? 0 : event.clientX - rect.left - selectionHandle(edge, rect.width).x;
  const frame = pointerFrame(event);
  const inside = edge === null && selectionIsAvailable() && frame >= selection[0] && frame < selection[1];
  drag = { id: event.pointerId, frame, edge, offset, inside, x: event.clientX, y: event.clientY, moved: false };
  $('wave').setPointerCapture(event.pointerId);
  if (edge === null && !inside) selectRange(frame, frame);
};
function moveSelection(event) {
  const frame = pointerFrame(event, drag.offset);
  if (drag.edge === 0) selectRange(Math.min(frame, selection[1] - 1), selection[1]);
  else if (drag.edge === 1) selectRange(selection[0], Math.max(selection[0] + 1, frame));
  else selectRange(drag.frame, frame);
}
$('wave').onpointermove = event => {
  if (ring?.total) {
    const frame = pointerFrame(event);
    const start = Math.max(ring.oldest, frame - Math.round(ring.rate * 0.01));
    const end = Math.min(ring.total, frame + Math.round(ring.rate * 0.01));
    if (end > start) showLevel('timelineLevel', ring.copy(start, end), frame / ring.rate);
  }
  if (drag?.id === event.pointerId) {
    if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
    drag.moved = true;
    moveSelection(event);
  } else {
    $('wave').style.cursor = hitHandle(event) === null ? 'crosshair' : 'ew-resize';
  }
};
$('wave').onpointerup = event => {
  if (drag?.id !== event.pointerId) return;
  if (drag.inside && !drag.moved) {
    const start = drag.frame;
    drag = null;
    playSelection(false, start);
    return;
  }
  const draggedEdge = drag.edge;
  const changed = drag.moved || drag.edge === null;
  if (changed) moveSelection(event);
  drag = null;
  if (changed && auditioning) queueAudition(draggedEdge === 1);
};
$('wave').onlostpointercapture = () => {
  if (!drag) return;
  const { edge, moved } = drag;
  drag = null;
  if (moved && auditioning) queueAudition(edge === 1);
};
$('history').addEventListener('wheel', event => {
  if (event.deltaY < 0) $('follow').checked = false;
}, { passive: true });
$('history').addEventListener('scroll', () => {
  const history = $('history');
  if (history.scrollHeight - history.scrollTop - history.clientHeight > 2) $('follow').checked = false;
  drawHistory();
});
$('follow').onchange = () => drawHistory();
function applyZoom() {
  const anchor = (firstRow + Math.floor($('history').scrollTop / ROW_HEIGHT)) * rowSeconds;
  rowSeconds = Number($('zoom').value);
  drawHistory(anchor);
}

$('zoom').onchange = () => {
  applyZoom();
  saveSettings();
};
$('tail').onchange = () => {
  const value = $('tail').valueAsNumber;
  if (validTail(value)) {
    tailSeconds = value;
    saveSettings();
  }
  $('tail').value = tailSeconds;
};
function applyBufferSize() {
  bufferSeconds = Number($('bufferSize').value);
  ring?.resize(bufferSeconds);
  drawHistory();
}

$('bufferSize').onchange = () => {
  applyBufferSize();
  saveSettings();
};
$('timestampPrefix').onchange = saveSettings;
$('filenamePrefix').oninput = saveSettings;
$('prefixPosition').onchange = saveSettings;
$('silence').onchange = () => {
  $('customSilenceField').hidden = $('silence').value !== 'custom';
  saveSettings();
};
$('customSilence').oninput = () => {
  const value = $('customSilence').valueAsNumber;
  if (!Number.isFinite(value) || value < -200 || value > 0) return;
  customSilence = value;
  saveSettings();
};
$('customSilence').onblur = () => { $('customSilence').value = customSilence; };
$('resetSettings').onclick = () => {
  if (!window.confirm('Reset all settings to their defaults?')) return;
  $('zoom').value = DEFAULT_ZOOM;
  $('tail').value = tailSeconds = DEFAULT_TAIL;
  $('bufferSize').value = String(DEFAULT_BUFFER);
  $('timestampPrefix').checked = true;
  $('filenamePrefix').value = '';
  $('prefixPosition').value = 'after';
  outputDevice = clipOutputDevice = '';
  $('output').value = $('clipOutput').value = '';
  if (typeof $('player').setSinkId === 'function') {
    routeOutput();
    routeClipOutput();
  }
  $('silence').value = DEFAULT_SILENCE;
  customSilence = -42;
  $('customSilence').value = customSilence;
  $('customSilenceField').hidden = true;
  $('localSpeech').checked = false;
  stopSpeech();
  startSpeech();
  setAudition(true);
  applyBufferSize();
  applyZoom();
  try {
    localStorage.removeItem(SETTINGS_KEY);
  } catch {
    // Defaults still apply for this tab.
  }
};

for (const id of ['from', 'to']) {
  $(id).oninput = () => {
    const from = $('from').valueAsNumber;
    const to = $('to').valueAsNumber;
    let next = null;
    if (ring && Number.isFinite(from) && Number.isFinite(to)) {
      const oldest = ring.oldest / ring.rate;
      const latest = ring.total / ring.rate;
      next = [
        Math.abs(from - oldest) <= .0005 ? ring.oldest : Math.round(from * ring.rate),
        Math.abs(to - latest) <= .0005 ? ring.total : Math.round(to * ring.rate)
      ];
    }
    setSelection(next);
  };
}
$('last').onclick = () => selectRange(Math.max(ring.oldest, ring.total - 30 * ring.rate), ring.total);

function updateAudition() {
  const available = selectionIsAvailable();
  $('selectionDuration').value = available
    ? `${((selection[1] - selection[0]) / ring.rate).toFixed(3)} s selected`
    : 'Select audio on the timeline.';
  $('downloadSelection').disabled = !available;
  $('selectionMp3').disabled = !available || encodingMp3;
  const filename = $('selectionName');
  filename.disabled = !available;
  if (available && !customSelectionName && document.activeElement !== filename) {
    const suggested = selectionText() || replayName(selection[0]);
    if (filename.value !== suggested) filename.value = suggested;
  }
  updateDownloadNames();
  if (!available) clearSelectionAudio();
  $('playSelection').disabled = $('restartSelection').disabled = !available;
  $('playSelection').textContent = selectionURL && !$('selectionPlayer').paused ? 'Pause' : 'Play';
  $('audition').classList.toggle('auto-preview-on', auditioning);
  $('audition').textContent = auditioning ? 'Don’t auto-play preview' : selectionURL ? 'Stop preview' : 'Auto-play preview';
}

function clearSelectionAudio() {
  clearTimeout(auditionTimer);
  if (playheadAnimation !== undefined) {
    cancelAnimationFrame(playheadAnimation);
    playheadAnimation = undefined;
  }
  if (!selectionURL) return;
  const player = $('selectionPlayer');
  player.pause();
  player.removeAttribute('src');
  player.load();
  URL.revokeObjectURL(selectionURL);
  selectionURL = null;
}

function setAudition(enabled) {
  auditioning = enabled;
  if (!enabled) clearSelectionAudio();
  updateAudition();
  drawHistory();
}

function drawPlayhead() {
  playheadAnimation = undefined;
  if (!selectionURL) return;
  drawHistory();
  if (selectionURL && !$('selectionPlayer').paused) {
    playheadAnimation = requestAnimationFrame(drawPlayhead);
  }
}

function playSelection(tailOnly = false, clickedFrame, useClipOutput = false) {
  if (!selectionIsAvailable()) return;
  clearSelectionAudio();
  stopPreview();
  const player = $('selectionPlayer');
  selectionPlaybackOutput = typeof player.setSinkId === 'function'
    ? routePlayer(player, useClipOutput ? clipOutputDevice : outputDevice,
      $(useClipOutput ? 'clipOutputStatus' : 'outputStatus'))
    : Promise.resolve(true);
  const [start, end] = selection;
  auditionStart = clickedFrame ?? (tailOnly ? Math.max(start, end - Math.round(tailSeconds * ring.rate)) : start);
  const url = URL.createObjectURL(wav(ring.copy(auditionStart, end), ring.rate));
  selectionURL = player.src = url;
  return resumeSelection();
}

async function resumeSelection() {
  const player = $('selectionPlayer');
  const url = selectionURL;
  if (await selectionPlaybackOutput === false || selectionURL !== url) return;
  const playing = player.play();
  updateAudition();
  try {
    await playing;
    if (selectionURL === url && playheadAnimation === undefined) drawPlayhead();
  } catch (error) {
    if (selectionURL !== url || error.name === 'AbortError') return;
    clearSelectionAudio();
    drawHistory();
    if (error.name === 'NotAllowedError') {
      $('selectionDuration').value = 'Click inside the selection to start playback.';
    }
  }
}

function toggleSelectionPlayback() {
  if (!selectionIsAvailable()) return;
  const player = $('selectionPlayer');
  if (!selectionURL) playSelection();
  else if (player.paused) resumeSelection();
  else {
    player.pause();
    drawHistory();
  }
}

$('playSelection').onclick = toggleSelectionPlayback;
$('restartSelection').onclick = () => playSelection();
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.defaultPrevented || event.target.isContentEditable ||
      event.target.closest('input, textarea, select, button, a') || !selectionIsAvailable()) return;
  event.preventDefault();
  if (!event.repeat) toggleSelectionPlayback();
});

function queueAudition(tailOnly = false) {
  clearSelectionAudio();
  if (!drag && selectionIsAvailable()) auditionTimer = setTimeout(() => playSelection(tailOnly), 200);
}

$('audition').onclick = () => {
  if (selectionURL && !auditioning) {
    clearSelectionAudio();
    drawHistory();
    return;
  }
  setAudition(!auditioning);
  saveSettings();
  if (auditioning) playSelection();
};
$('selectionPlayer').onended = () => {
  clearSelectionAudio();
  drawHistory();
};

function selectionText() {
  const [start, end] = selection;
  return phrases.filter(phrase => phrase.start < end && phrase.end > start)
    .map(phrase => phrase.text).join(' ');
}

function replayName(frame) {
  return `Replay ${clock(frame / ring.rate).replace(':', '-')}`;
}

function selectionName(start) {
  const edited = $('selectionName').value.trim();
  return customSelectionName && edited ? edited : selectionText() || replayName(start);
}

$('selectionName').oninput = () => {
  customSelectionName = Boolean($('selectionName').value.trim());
  updateDownloadNames();
};
$('name').oninput = updateDownloadNames;
for (const [input, button] of [['selectionName', 'selectionMp3'], ['name', 'clipMp3']]) {
  $(input).addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.isComposing && !event.repeat) {
      event.preventDefault();
      if (!$(button).disabled) $(button).click();
    }
  });
}
$('selectionName').onblur = updateAudition;

$('downloadSelection').onclick = () => {
  if (!selectionIsAvailable()) return;
  const [start, end] = selection;
  downloadAudio(wav(ring.copy(start, end), ring.rate), selectionName(start), 'wav');
};

$('selectionMp3').onclick = () => {
  if (encodingMp3 || !selectionIsAvailable()) return;
  const [start, end] = selection;
  exportMp3(ring.copy(start, end), ring.rate, selectionName(start), $('selectionMp3'));
};

$('make').onclick = () => {
  if (!selection || selection[0] < ring.oldest) {
    drawHistory();
    return;
  }
  if ($('make').disabled) return;
  const [start, end] = selection;
  stopPreview();
  const padding = Math.round(ring.rate * 0.5);
  const origin = Math.max(ring.oldest, start - padding);
  const limit = Math.min(ring.total, end + padding);
  clip = { samples: ring.copy(origin, limit), rate: ring.rate };
  const duration = clip.samples.length / clip.rate;
  $('clip').hidden = false;
  $('clipEmpty').hidden = true;
  $('closeClip').hidden = false;
  $('name').value = selectionName(start);
  $('trimStart').value = (start - origin) / clip.rate;
  $('trimEnd').value = (end - origin) / clip.rate;
  $('trimStart').max = $('trimEnd').max = String(duration);
  autoTrimClip();
  drawClip();
};

$('closeClip').onclick = () => {
  stopPreview();
  clip = null;
  $('clip').hidden = true;
  $('clipEmpty').hidden = false;
  $('closeClip').hidden = true;
  updateDownloadNames();
  if (!$('make').disabled) $('make').focus();
};

function trimRange() {
  if (!clip) return null;
  const from = $('trimStart').valueAsNumber;
  const to = $('trimEnd').valueAsNumber;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > Number($('trimEnd').max)) return null;
  const start = Math.round(from * clip.rate);
  const end = to === Number($('trimEnd').max) ? clip.samples.length : Math.round(to * clip.rate);
  return end > start ? [start, end] : null;
}

function soundEdges(samples, start, end) {
  const original = [start, end];
  const threshold = $('silence').value === 'off' ? -72 : silenceThreshold();
  const limit = 32768 * 10 ** (threshold / 20);
  while (start < end && Math.abs(samples[start]) < limit) start++;
  while (end > start && Math.abs(samples[end - 1]) < limit) end--;
  return end > start ? [start, end] : original;
}

function showLevel(id, samples, seconds) {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  const rms = Math.sqrt(energy / Math.max(1, samples.length)) / 32768;
  const db = rms ? (20 * Math.log10(rms)).toFixed(1) : '−∞';
  $(id).value = `${preciseClock(seconds)} · ${db} dBFS (20 ms RMS)`;
}

function autoTrimClip() {
  const trim = trimRange();
  if (!trim) return;
  const [start, end] = soundEdges(clip.samples, ...trim);
  $('trimStart').value = start / clip.rate;
  $('trimEnd').value = end / clip.rate;
}

$('autoTrim').onclick = () => {
  stopPreview();
  autoTrimClip();
  drawClip();
};

let clipDrag;
let clipDragged = false;
function beginClipDrag(event, handleEdge) {
  const trim = trimRange();
  if (!trim || event.button !== 0) return;
  const rect = $('preview').getBoundingClientRect();
  const x = event.clientX - rect.left;
  const positions = trim.map(frame => frame / clip.samples.length * rect.width);
  const edge = handleEdge ?? (Math.abs(x - positions[0]) <= Math.abs(x - positions[1]) ? 0 : 1);
  if (handleEdge === undefined && Math.abs(x - positions[edge]) > 12) return;
  event.preventDefault();
  clipDrag = { id: event.pointerId, edge, offset: x - positions[edge] };
  clipDragged = true;
  stopPreview();
  $('preview').setPointerCapture(event.pointerId);
}
$('preview').onpointerdown = event => beginClipDrag(event);
for (const [edge, id] of ['clipStartHandle', 'clipEndHandle'].entries()) {
  $(id).onpointerdown = event => beginClipDrag(event, edge);
  $(id).onclick = () => { clipDragged = false; };
  $(id).onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const trim = trimRange();
    if (!trim) return;
    event.preventDefault();
    stopPreview();
    const step = Math.max(1, Math.round(clip.rate * (event.shiftKey ? 1 : 0.01)));
    const frame = trim[edge] + (event.key === 'ArrowLeft' ? -step : step);
    if (edge === 0) $('trimStart').value = Math.max(0, Math.min(trim[1] - 1, frame)) / clip.rate;
    else $('trimEnd').value = Math.min(clip.samples.length, Math.max(trim[0] + 1, frame)) / clip.rate;
    drawClip();
  };
}
$('preview').onpointermove = event => {
  if (clip) {
    const rect = $('preview').getBoundingClientRect();
    const frame = Math.max(0, Math.min(clip.samples.length - 1,
      Math.round((event.clientX - rect.left) / rect.width * clip.samples.length)));
    const radius = Math.round(clip.rate * 0.01);
    showLevel('clipLevel', clip.samples.subarray(Math.max(0, frame - radius),
      Math.min(clip.samples.length, frame + radius)), frame / clip.rate);
  }
  if (clipDrag?.id !== event.pointerId) return;
  const trim = trimRange();
  const rect = $('preview').getBoundingClientRect();
  const frame = Math.round((event.clientX - rect.left - clipDrag.offset) / rect.width * clip.samples.length);
  if (clipDrag.edge === 0) $('trimStart').value = Math.max(0, Math.min(trim[1] - 1, frame)) / clip.rate;
  else $('trimEnd').value = Math.min(clip.samples.length, Math.max(trim[0] + 1, frame)) / clip.rate;
  drawClip();
};
$('preview').onpointerup = () => { clipDrag = null; };
$('preview').onlostpointercapture = () => { clipDrag = null; };

function drawClip() {
  if (!clip) return;
  updateDownloadNames();
  const canvas = $('preview');
  const { ctx, width } = canvasContext(canvas, canvas.clientHeight);
  const { samples, rate } = clip;
  const trim = trimRange();
  const [start, end] = trim || [0, 0];
  const left = start / samples.length * width;
  const right = end / samples.length * width;
  for (const [id, x] of [['clipStartHandle', left], ['clipEndHandle', right]]) {
    const handle = $(id);
    handle.hidden = !trim;
    handle.style.left = `${Math.max(0, Math.min(width - handle.offsetWidth, x - handle.offsetWidth / 2))}px`;
  }
  ctx.fillStyle = '#204b41';
  ctx.fillRect(left, 0, right - left, canvas.clientHeight);
  const mid = canvas.clientHeight / 2;
  const step = samples.length / Math.max(1, width);
  for (let x = 0; x < width; x += 2) {
    let peak = 0;
    const limit = Math.min(samples.length, Math.ceil((x + 2) * step));
    for (let i = Math.floor(x * step); i < limit; i++) peak = Math.max(peak, Math.abs(samples[i]));
    const amplitude = Math.max(1, Math.sqrt(peak / 32768) * (mid - 4));
    ctx.fillStyle = x >= left && x < right ? '#8af2ce' : '#677b8b';
    ctx.fillRect(x, mid - amplitude, 1, amplitude * 2);
  }
  $('duration').value = trim ? `${((end - start) / rate).toFixed(3)} s selected` : 'Enter a valid trim range.';
  if (trim) {
    ctx.fillStyle = '#d3fff0';
    for (const x of [left, right]) {
      ctx.fillRect(Math.max(0, Math.min(width - 2, x - 1)), 0, 2, canvas.clientHeight);
      ctx.fillRect(Math.max(0, Math.min(width - 8, x - 4)), mid - 12, 8, 24);
    }
  }
  $('play').disabled = $('save').disabled = !trim;
  $('clipMp3').disabled = !trim || encodingMp3;
}

function stopPreview() {
  cancelAnimationFrame(clipPlayheadFrame);
  $('clipPlayhead').hidden = true;
  const player = $('player');
  player.pause();
  if (previewURL) {
    player.removeAttribute('src');
    player.load();
    URL.revokeObjectURL(previewURL);
    previewURL = null;
  }
  $('play').textContent = 'Play trim';
}

for (const id of ['trimStart', 'trimEnd']) {
  $(id).oninput = () => {
    stopPreview();
    drawClip();
  };
}

function clipWav() {
  const [start, end] = trimRange();
  return wav(clip.samples.subarray(start, end), clip.rate);
}

async function playClipRange(start, end) {
  stopPreview();
  clearSelectionAudio();
  drawHistory();
  previewURL = URL.createObjectURL(wav(clip.samples.subarray(start, end), clip.rate));
  const url = previewURL;
  const player = $('player');
  const playhead = $('clipPlayhead');
  const { rate, samples } = clip;
  const movePlayhead = () => {
    const frame = Math.min(end, start + player.currentTime * rate);
    playhead.style.left = `${frame / samples.length * 100}%`;
    clipPlayheadFrame = requestAnimationFrame(movePlayhead);
  };
  player.src = url;
  $('play').textContent = 'Stop preview';
  try {
    if (await clipOutputReady === false || previewURL !== url) return;
    await player.play();
    if (previewURL === url) {
      playhead.hidden = false;
      movePlayhead();
    }
  } catch (error) {
    if (previewURL === url) {
      stopPreview();
      status(`Preview failed: ${error.message}`);
    }
  }
}

$('play').onclick = () => {
  if (previewURL) return stopPreview();
  const trim = trimRange();
  if (trim) playClipRange(...trim);
};

$('preview').onclick = event => {
  if (clipDragged) {
    clipDragged = false;
    return;
  }
  const trim = trimRange();
  if (!trim) return;
  const rect = $('preview').getBoundingClientRect();
  const frame = Math.floor((event.clientX - rect.left) / rect.width * clip.samples.length);
  const [start, end] = trim;
  if (frame >= start && frame < end) playClipRange(frame, end);
};

$('player').onended = stopPreview;

function safeFilename(name) {
  const cleaned = name.trim().replace(/[. ]+$/g, '').replace(/\.(wav|mp3)$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ');
  let result = '';
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const character of cleaned) {
    bytes += encoder.encode(character).length;
    if (result.length + character.length > 119 || bytes > 220) break;
    result += character;
  }
  result = result.replace(/[. ]+$/g, '');
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *($|\.)/i.test(result)) result = '_' + result;
  return result || 'Replay';
}

function downloadTimestamp(now = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('-');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(pad).join('-');
  return `${date}_${time}`;
}

function downloadFilename(name, extension, now = new Date()) {
  const timestamp = $('timestampPrefix').checked ? downloadTimestamp(now) : '';
  const prefix = $('filenamePrefix').value.trim();
  const parts = $('prefixPosition').value === 'before' ? [prefix, timestamp, name] : [timestamp, prefix, name];
  const filename = parts.filter(part => part.trim()).join(' ');
  return `${safeFilename(filename)}.${extension}`;
}

function updateDownloadNames() {
  const now = new Date();
  const selectionLabel = $('selectionDownloadName');
  const clipLabel = $('clipDownloadName');
  const available = selectionIsAvailable();
  const showNames = (label, name, visible) => {
    label.hidden = !visible;
    if (!visible) return;
    const text = ['mp3', 'wav'].map(extension => downloadFilename(name, extension, now)).join('\n');
    if (label.textContent !== text) label.textContent = text;
  };
  showNames(selectionLabel, available ? selectionName(selection[0]) : '', available);
  showNames(clipLabel, $('name').value, Boolean(clip));
}

function downloadAudio(blob, name, extension) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = downloadFilename(name, extension);
  document.body.append(link);
  link.click();
  link.remove();
  const url = link.href;
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

$('save').onclick = () => downloadAudio(clipWav(), $('name').value, 'wav');

$('clipMp3').onclick = () => {
  const trim = trimRange();
  if (encodingMp3 || !trim) return;
  exportMp3(clip.samples.slice(...trim), clip.rate, $('name').value, $('clipMp3'));
};

async function exportMp3(samples, rate, name, button) {
  const label = button.textContent;
  encodingMp3 = true;
  $('selectionMp3').disabled = $('clipMp3').disabled = true;
  button.textContent = 'Encoding MP3…';
  let worker;
  try {
    worker = new Worker(new URL('./mp3-worker.js', import.meta.url));
    const blob = await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data);
      worker.onerror = () => reject(new Error('Could not load the MP3 encoder.'));
      worker.postMessage({ samples, rate }, [samples.buffer]);
    });
    downloadAudio(blob, name, 'mp3');
  } catch (error) {
    status(`MP3 export failed: ${error.message}`);
  } finally {
    worker?.terminate();
    encodingMp3 = false;
    button.textContent = label;
    $('selectionMp3').disabled = !selectionIsAvailable();
    $('clipMp3').disabled = !clip || !trimRange();
  }
}

function scrollTranscript() {
  const list = $('phrases');
  if ($('followTranscript').checked) list.scrollTop = list.scrollHeight;
}

$('followTranscript').onchange = scrollTranscript;
$('phrases').addEventListener('scroll', () => {
  const list = $('phrases');
  if (list.scrollHeight - list.scrollTop - list.clientHeight > 2) $('followTranscript').checked = false;
});

function addPhrase(start, end, text) {
  const item = document.createElement('li');
  const phrase = { start, end, text, element: item };
  const button = document.createElement('button');
  const time = document.createElement('time');
  time.textContent = preciseClock(start / ring.rate);
  button.append(time, document.createTextNode(text));
  button.onclick = () => {
    $('follow').checked = false;
    const left = Math.max(ring.oldest, phrase.start);
    selectRange(left, Math.max(left, Math.min(ring.total, phrase.end)));
    $('history').scrollTop = (Math.floor(left / (rowSeconds * ring.rate)) - firstRow) * ROW_HEIGHT;
  };
  item.append(button);
  $('phrases').append(item);
  phrases.push(phrase);
  scrollTranscript();
  updateAudition();
  return phrase;
}

function stopSpeech() {
  if (recognition) console.info('[Audio Replay speech] Stopping recognition');
  clearTimeout(restartSpeech);
  const current = recognition;
  recognition = null;
  current?.abort();
  if (Recognition) $('speechStatus').textContent = $('speech').checked
    ? 'Transcription will start with recording.'
    : 'Transcription is off.';
}

async function startSpeech() {
  if (!capture || !$('speech').checked || !Recognition || recognition) return;
  const current = new Recognition();
  recognition = current;
  current.continuous = true;
  current.lang = 'en-US';
  console.info('[Audio Replay speech] Starting', {
    language: current.lang,
    onDeviceRequested: $('localSpeech').checked,
    continuous: current.continuous,
    trackState: capture.stream.getAudioTracks()[0]?.readyState
  });
  if ($('localSpeech').checked) {
    current.processLocally = true;
    try {
      const options = { langs: ['en-US'], processLocally: true };
      console.info('[Audio Replay speech] Checking model availability', options);
      const availability = await Recognition.available(options);
      console.info('[Audio Replay speech] Model availability returned', { availability, type: typeof availability });
      if (recognition !== current) return;
      if (availability !== 'available') {
        recognition = null;
        $('speechStatus').textContent = availability === 'unavailable'
          ? 'This browser cannot provide an on-device en-US model.'
          : 'Install the en-US language pack to start on-device transcription.';
        return;
      }
    } catch (error) {
      console.error('[Audio Replay speech] Model availability check failed', error);
      if (recognition !== current) return;
      recognition = null;
      $('speechStatus').textContent = `On-device recognition unavailable: ${error.message}`;
      return;
    }
  }
  let phraseStart = ring.total;
  let speechSpan = { start: phraseStart, end: null, phrases: [] };
  const endedSpans = [];
  let failed = false;
  current.onstart = () => {
    console.info('[Audio Replay speech] Recognition started', { language: current.lang, processLocally: current.processLocally });
    if (recognition === current) $('speechStatus').textContent = 'Listening. Select a phrase to locate it in the buffer.';
  };
  current.onspeechstart = () => {
    if (recognition !== current) return;
    speechSpan = { start: ring.total, end: null, phrases: [] };
    phraseStart = speechSpan.start;
  };
  current.onspeechend = () => {
    if (recognition !== current) return;
    speechSpan.end = ring.total;
    if (speechSpan.phrases.length) {
      const last = speechSpan.phrases.at(-1);
      last.end = Math.max(last.start + 1, speechSpan.end);
      updateAudition();
    } else endedSpans.push(speechSpan);
  };
  current.onresult = event => {
    if (recognition !== current) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal || !result[0].transcript.trim()) continue;
      const span = endedSpans.shift() || speechSpan;
      const end = span.end ?? ring.total;
      if (end <= ring.oldest) continue;
      const start = Math.max(ring.oldest, Math.min(Math.max(span.start, phraseStart), end - 1));
      const phrase = addPhrase(start, end, result[0].transcript.trim());
      span.phrases.push(phrase);
      phraseStart = end;
    }
  };
  current.onerror = event => {
    console.error('[Audio Replay speech] Recognition error', { error: event.error, message: event.message });
    if (recognition !== current || event.error === 'no-speech') return;
    failed = true;
    $('speech').checked = false;
    $('speechStatus').textContent = `Transcription unavailable (${event.error}). Select Enable to retry.`;
  };
  current.onend = () => {
    console.info('[Audio Replay speech] Recognition ended', { currentSession: recognition === current, failed });
    if (recognition !== current) return;
    recognition = null;
    if (!failed) restartSpeech = setTimeout(startSpeech, 350);
  };
  try {
    current.start(capture.stream.getAudioTracks()[0]);
  } catch (error) {
    console.error('[Audio Replay speech] Recognition start failed', error);
    recognition = null;
    $('speech').checked = false;
    $('speechStatus').textContent = `Transcription unavailable: ${error.message}`;
  }
}

$('speech').onchange = () => {
  if ($('speech').checked && capture) startSpeech();
  else stopSpeech();
};

const localSpeechSupported = Boolean(Recognition &&
  'processLocally' in Recognition.prototype &&
  typeof Recognition.available === 'function' && typeof Recognition.install === 'function');
console.info('[Audio Replay speech] Browser capabilities', {
  userAgent: navigator.userAgent,
  browserLanguage: navigator.language,
  recognitionLanguage: 'en-US',
  secureContext: window.isSecureContext,
  standardAPI: typeof window.SpeechRecognition,
  prefixedAPI: typeof window.webkitSpeechRecognition,
  processLocally: Boolean(Recognition && 'processLocally' in Recognition.prototype),
  availableAPI: typeof Recognition?.available,
  installAPI: typeof Recognition?.install,
  localSpeechSupported,
  onDevicePolicy: (document.permissionsPolicy || document.featurePolicy)?.allowsFeature('on-device-speech-recognition')
});
$('localSpeech').disabled = $('installSpeech').disabled = !localSpeechSupported;
if (!localSpeechSupported) {
  $('localSpeech').checked = false;
  $('speechPackStatus').textContent = 'On-device recognition is unavailable in this browser. Edge may require Canary or Dev with “Speech Recognition with on-device model” enabled in edge://flags.';
}

$('localSpeech').onchange = () => {
  saveSettings();
  stopSpeech();
  startSpeech();
};

$('installSpeech').onclick = async () => {
  $('installSpeech').disabled = true;
  $('speechPackStatus').textContent = 'Installing the en-US language pack…';
  try {
    console.info('[Audio Replay speech] Installing model', { langs: ['en-US'], processLocally: true });
    const installed = await Recognition.install({ langs: ['en-US'], processLocally: true });
    console.info('[Audio Replay speech] Model install returned', { installed });
    if (!installed) throw new Error('The browser could not install the language pack. Try again.');
    $('speechPackStatus').textContent = 'en-US language pack installed.';
    $('localSpeech').checked = true;
    saveSettings();
    stopSpeech();
    startSpeech();
  } catch (error) {
    console.error('[Audio Replay speech] Model installation failed', error);
    $('speechPackStatus').textContent = error.message;
  } finally {
    $('installSpeech').disabled = false;
  }
};

if (!Recognition) {
  $('speech').checked = false;
  $('speech').disabled = true;
  $('speechStatus').textContent = 'This browser does not provide live speech recognition.';
}

setInterval(() => { if (capture) drawHistory(); }, 200);
setInterval(updateDownloadNames, 1000);
const resized = new ResizeObserver(() => {
  drawHistory();
  drawClip();
});
resized.observe($('history'));
resized.observe($('preview'));
drawHistory();
