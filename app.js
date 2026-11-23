import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { videoDir } from '@tauri-apps/api/path';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const urlInput = $('#urlInput');
const analyzeButton = $('#analyzeButton');
const processButton = $('#processButton');
const resultCard = $('#resultCard');
const resultTitle = $('#resultTitle');
const resultMessage = $('#resultMessage');
const resultThumbWrap = $('#resultThumbWrap');
const resultKicker = $('#resultKicker');
const resultCheck = $('#resultCheck');
const connectionStatus = $('#connectionStatus');
const qualitySelect = $('#qualitySelect');
const qualityField = $('#qualityField');
const qualityNote = $('#qualityNote');
const destinationPath = $('#destinationPath');
const settingsDestination = $('#settingsDestination');
const chooseFolderButton = $('#chooseFolderButton');
const settingsChooseFolderButton = $('#settingsChooseFolderButton');
const downloadProgress = $('#downloadProgress');
const progressStatus = $('#progressStatus');
const progressPercent = $('#progressPercent');
const progressBar = $('#progressBar');
const progressSpeed = $('#progressSpeed');
const progressEta = $('#progressEta');

let selectedFormat = 'mp4';
let analyzedSource = null;
let currentDownloadDirectory = null;
let isDownloading = false;
const sessionActivity = [];

function showResult(title, message, state = 'success') {
  resultTitle.textContent = title;
  resultMessage.textContent = message;
  resultKicker.textContent = state === 'error' ? 'ACTION REQUIRED' : title === 'Download complete' ? 'DOWNLOAD COMPLETE' : 'SOURCE ANALYZED';
  resultCheck.textContent = state === 'error' ? '!' : '✓';
  resultCard.classList.toggle('is-error', state === 'error');
  resultCard.classList.remove('hidden');
}

function clearResult() {
  resultCard.classList.add('hidden');
  resultCard.classList.remove('is-error');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unknown duration';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function updateDestinationLabels() {
  const path = currentDownloadDirectory || 'No save folder selected';
  destinationPath.textContent = path;
  destinationPath.title = path;
  settingsDestination.textContent = path;
}

async function initializeDestination() {
  try {
    currentDownloadDirectory = localStorage.getItem('downloadParentDirectory');
    if (!currentDownloadDirectory) currentDownloadDirectory = await videoDir();
    updateDestinationLabels();
  } catch (error) {
    destinationPath.textContent = 'Could not load Videos folder';
    settingsDestination.textContent = 'Could not load Videos folder';
    showResult('Save location unavailable', String(error), 'error');
  }
}

async function chooseDownloadFolder(button) {
  if (button) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Opening…';
  }

  try {
    const defaultPath = currentDownloadDirectory || await videoDir();
    const selected = await open({ directory: true, multiple: false, defaultPath });
    if (selected) {
      currentDownloadDirectory = selected;
      localStorage.setItem('downloadParentDirectory', selected);
      updateDestinationLabels();
    }
  } catch (error) {
    showResult('Could not choose folder', String(error), 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.originalText || 'Change';
      delete button.dataset.originalText;
    }
  }
}

chooseFolderButton.addEventListener('click', () => chooseDownloadFolder(chooseFolderButton));
settingsChooseFolderButton.addEventListener('click', () => chooseDownloadFolder(settingsChooseFolderButton));

function setToolStatus(id, available) {
  const element = $(id);
  element.textContent = available ? 'Available' : 'Not found';
  element.classList.toggle('ready', available);
  element.classList.toggle('missing', !available);
  element.classList.remove('pending');
}

async function checkBackend() {
  try {
    const result = await invoke('check_media_tools');
    setToolStatus('#ytDlpStatus', Boolean(result.yt_dlp));
    setToolStatus('#ffmpegStatus', Boolean(result.ffmpeg));
    setToolStatus('#ffprobeStatus', Boolean(result.ffprobe));

    const allAvailable = Boolean(result.yt_dlp && result.ffmpeg && result.ffprobe);
    const anyAvailable = Boolean(result.yt_dlp || result.ffmpeg || result.ffprobe);
    $('#sidebarStatusDot').classList.toggle('ready', allAvailable);
    $('#sidebarStatusDot').classList.toggle('error', !anyAvailable);
    $('#systemPulse').classList.toggle('ready', allAvailable);
    $('#systemPulse').classList.toggle('error', !anyAvailable);
    $('#sidebarStatusTitle').textContent = allAvailable ? 'System ready' : anyAvailable ? 'Tools incomplete' : 'Tools unavailable';
    $('#sidebarStatusText').textContent = allAvailable ? 'All media tools detected' : 'Check required media tools';
    connectionStatus.textContent = allAvailable ? 'All local tools ready' : anyAvailable ? 'Some media tools are missing' : 'Media tools not found';
    connectionStatus.classList.toggle('ready', allAvailable);
    connectionStatus.classList.toggle('error', !anyAvailable);
    $('#statusbarText').textContent = allAvailable ? 'All media tools ready' : anyAvailable ? 'Some media tools are missing' : 'Media tools unavailable';
    $('#systemStatusDot').classList.toggle('error', !anyAvailable);
  } catch (error) {
    for (const id of ['#ytDlpStatus', '#ffmpegStatus', '#ffprobeStatus']) {
      const element = $(id);
      element.textContent = 'Unavailable';
      element.classList.add('missing');
      element.classList.remove('pending');
    }
    $('#sidebarStatusDot').classList.add('error');
    $('#systemPulse').classList.add('error');
    $('#sidebarStatusTitle').textContent = 'Backend unavailable';
    $('#sidebarStatusText').textContent = 'Could not reach desktop backend';
    connectionStatus.textContent = 'Desktop backend unavailable';
    connectionStatus.classList.add('error');
    $('#statusbarText').textContent = 'Desktop backend unavailable';
    $('#systemStatusDot').classList.add('error');
    console.error('Backend check failed:', error);
  }
}

function resetAnalysis() {
  analyzedSource = null;
  processButton.disabled = true;
  qualitySelect.disabled = true;
  qualitySelect.innerHTML = '<option value="">Analyze a source first</option>';
  clearResult();
  resultThumbWrap.innerHTML = '<div class="result-thumb-placeholder">▶</div>';
}

function populateQualities(formats) {
  qualitySelect.innerHTML = '';
  if (!Array.isArray(formats) || formats.length === 0) {
    qualitySelect.add(new Option('No compatible qualities found', ''));
    qualitySelect.disabled = true;
    return;
  }

  for (const format of formats) {
    const fps = format.fps ? ` · ${format.fps} FPS` : '';
    qualitySelect.add(new Option(`${format.label}${fps}`, String(format.height)));
  }
  qualitySelect.selectedIndex = 0;
  qualitySelect.disabled = false;
}

function updateFormatState() {
  $$('.format-option').forEach((button) => {
    const selected = button.dataset.format === selectedFormat;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });

  const isAudio = selectedFormat === 'mp3';
  qualityField.classList.toggle('is-disabled', isAudio);
  qualitySelect.disabled = isAudio || !analyzedSource || !analyzedSource.formats?.length;
  qualityNote.textContent = isAudio
    ? 'MP3 extracts the best available audio stream. Resolution selection is not required.'
    : 'Available resolutions are retrieved from the source during analysis.';
  processButton.disabled = isDownloading || !analyzedSource || (!isAudio && !qualitySelect.value);
}

function displayAnalysis(result) {
  const sourceType = result.kind === 'shorts' ? 'YouTube Shorts' : 'YouTube video';
  const details = [sourceType, result.uploader || 'Unknown uploader', formatDuration(result.duration), `${result.formats.length} quality options`];
  showResult(result.title || 'Source analyzed', details.join(' · '));
  if (result.thumbnail) {
    const image = document.createElement('img');
    image.src = result.thumbnail;
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.onerror = () => { resultThumbWrap.innerHTML = '<div class="result-thumb-placeholder">▶</div>'; };
    resultThumbWrap.replaceChildren(image);
  } else {
    resultThumbWrap.innerHTML = '<div class="result-thumb-placeholder">▶</div>';
  }
  populateQualities(result.formats);
  updateFormatState();
}

$$('.format-option').forEach((button) => {
  button.addEventListener('click', () => {
    if (isDownloading) return;
    selectedFormat = button.dataset.format;
    updateFormatState();
  });
});

analyzeButton.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    showResult('A URL is needed', 'Paste a supported YouTube video or Shorts link to continue.', 'error');
    urlInput.focus();
    return;
  }
  if (isDownloading) return;

  resetAnalysis();
  analyzeButton.disabled = true;
  analyzeButton.textContent = 'Analyzing…';
  try {
    const result = await invoke('analyze_source', { url });
    analyzedSource = result;
    displayAnalysis(result);
  } catch (error) {
    analyzedSource = null;
    resetAnalysis();
    showResult('Analysis failed', String(error), 'error');
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.innerHTML = 'Analyze link <span>↗</span>';
    updateFormatState();
  }
});

function renderActivity() {
  const list = $('#activityList');
  $('#activityCount').textContent = `${sessionActivity.length} ${sessionActivity.length === 1 ? 'ITEM' : 'ITEMS'}`;
  if (!sessionActivity.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-state-icon"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"/></svg></div><strong>No downloads yet</strong><p>Completed downloads from this session will show up here.</p><button class="button button-secondary" data-go-download type="button">Start a download</button></div>`;
    list.querySelector('[data-go-download]').addEventListener('click', () => navigate('download'));
    return;
  }
  list.replaceChildren();
  for (const item of sessionActivity) {
    const row = document.createElement('div');
    row.className = 'activity-entry';
    const icon = document.createElement('span');
    icon.className = 'activity-file-icon';
    icon.textContent = item.format.toUpperCase();
    const main = document.createElement('div');
    main.className = 'activity-entry-main';
    const title = document.createElement('strong');
    title.textContent = item.title;
    const detail = document.createElement('small');
    detail.textContent = `${item.format.toUpperCase()} · ${item.when} · ${item.location}`;
    main.append(title, detail);
    const status = document.createElement('span');
    status.className = 'activity-success';
    status.textContent = 'Completed';
    row.append(icon, main, status);
    list.append(row);
  }
}

function navigate(page) {
  const names = { download: 'New download', activity: 'Activity', settings: 'Settings' };
  $$('.page-view').forEach((view) => view.classList.toggle('active', view.dataset.view === page));
  $$('.nav-item[data-page]').forEach((button) => button.classList.toggle('active', button.dataset.page === page));
  $('#breadcrumbCurrent').textContent = names[page] || names.download;
  if (page === 'activity') renderActivity();
}

$$('.nav-item[data-page]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));

function setTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  localStorage.setItem('mediaDownloaderTheme', theme);
  $('#settingsThemeButton').textContent = theme === 'light' ? 'Use dark theme' : 'Use light theme';
  $('#themeButton').setAttribute('aria-label', theme === 'light' ? 'Switch to dark appearance' : 'Switch to light appearance');
}

function toggleTheme() {
  setTheme(document.body.classList.contains('light') ? 'dark' : 'light');
}

$('#themeButton').addEventListener('click', toggleTheme);
$('#settingsThemeButton').addEventListener('click', toggleTheme);

processButton.addEventListener('click', async () => {
  if (!analyzedSource || !currentDownloadDirectory || isDownloading) {
    if (!currentDownloadDirectory) showResult('Save location unavailable', 'Choose a valid destination folder before downloading.', 'error');
    return;
  }

  const height = Number(qualitySelect.value) || 0;
  if (selectedFormat === 'mp4' && !height) {
    showResult('Choose a quality', 'Select a video resolution before downloading.', 'error');
    return;
  }

  isDownloading = true;
  processButton.disabled = true;
  analyzeButton.disabled = true;
  processButton.querySelector('span').textContent = 'Downloading…';
  downloadProgress.classList.remove('hidden');
  progressStatus.textContent = 'Preparing download…';
  progressPercent.textContent = '0%';
  progressBar.style.width = '0%';
  progressSpeed.textContent = 'Waiting for data…';
  progressEta.textContent = '';

  let unlisten;
  try {
    unlisten = await listen('download-progress', (event) => {
      const progress = event.payload || {};
      const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
      progressBar.style.width = `${percent}%`;
      progressPercent.textContent = `${Math.round(percent)}%`;
      progressStatus.textContent = progress.status || 'Downloading';
      progressSpeed.textContent = progress.speed || ' ';
      progressEta.textContent = progress.eta ? `ETA ${progress.eta}` : '';
    });

    const message = await invoke('download_media', {
      url: analyzedSource.canonical_url,
      outputDir: currentDownloadDirectory,
      format: selectedFormat,
      height
    });

    progressStatus.textContent = 'Download complete';
    progressPercent.textContent = '100%';
    progressBar.style.width = '100%';
    progressSpeed.textContent = 'Finished';
    progressEta.textContent = '';
    showResult('Download complete', message);
    sessionActivity.unshift({
      title: analyzedSource.title || 'Untitled media',
      format: selectedFormat,
      when: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      location: selectedFormat === 'mp4' ? 'Videos folder' : 'Audios folder'
    });
  } catch (error) {
    progressStatus.textContent = 'Download failed';
    progressSpeed.textContent = 'An error occurred';
    progressEta.textContent = '';
    showResult('Download failed', String(error), 'error');
  } finally {
    if (unlisten) unlisten();
    isDownloading = false;
    analyzeButton.disabled = false;
    processButton.querySelector('span').textContent = 'Start download';
    updateFormatState();
  }
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') analyzeButton.click();
});

const savedTheme = localStorage.getItem('mediaDownloaderTheme') || 'dark';
setTheme(savedTheme);
initializeDestination();
checkBackend();
renderActivity();
