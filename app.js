import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';
import { videoDir } from '@tauri-apps/api/path';

const urlInput = document.querySelector('#urlInput');
const analyzeButton = document.querySelector('#analyzeButton');
const processButton = document.querySelector('#processButton');
const resultCard = document.querySelector('#resultCard');
const resultTitle = document.querySelector('#resultTitle');
const resultMessage = document.querySelector('#resultMessage');
const connectionStatus = document.querySelector('#connectionStatus');
const qualitySelect = document.querySelector('#qualitySelect');
const destinationPath = document.querySelector('#destinationPath');
const chooseFolderButton = document.querySelector('#chooseFolderButton');

let selectedFormat = 'mp4';
let analyzedSource = null;
let currentDownloadDirectory = null;

function showResult(title, message) {
  resultTitle.textContent = title;
  resultMessage.textContent = message;
  resultCard.classList.remove('hidden');
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 'Unknown duration';
  }

  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

async function initializeDestination() {
  try {
    currentDownloadDirectory = localStorage.getItem('downloadParentDirectory');

    if (!currentDownloadDirectory) {
      currentDownloadDirectory = await videoDir();
    }

    destinationPath.textContent = currentDownloadDirectory;
    destinationPath.title = currentDownloadDirectory;
  } catch (error) {
    destinationPath.textContent = 'Could not load Videos folder';
    showResult('Save location unavailable', String(error));
  }
}

chooseFolderButton.addEventListener('click', async () => {
  chooseFolderButton.disabled = true;
  chooseFolderButton.textContent = 'Opening…';

  try {
    const defaultPath = currentDownloadDirectory || await videoDir();

    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath
    });

    if (selected) {
      currentDownloadDirectory = selected;
      localStorage.setItem('downloadParentDirectory', selected);
      destinationPath.textContent = selected;
      destinationPath.title = selected;
    }
  } catch (error) {
    showResult('Could not choose folder', String(error));
  } finally {
    chooseFolderButton.disabled = false;
    chooseFolderButton.textContent = 'Choose folder';
  }
});

async function checkBackend() {
  try {
    const result = await invoke('check_media_tools');
    const available = [];

    if (result.ffmpeg) available.push('FFmpeg');
    if (result.ffprobe) available.push('FFprobe');
    if (result.yt_dlp) available.push('yt-dlp');

    connectionStatus.textContent = available.length
      ? `${available.join(' + ')} ready`
      : 'Media tools not found';
  } catch {
    connectionStatus.textContent = 'Desktop backend unavailable';
  }
}

function resetAnalysis() {
  analyzedSource = null;
  processButton.disabled = true;
  qualitySelect.disabled = true;
  qualitySelect.innerHTML = '<option>Analyze a source first</option>';
}

function populateQualities(formats) {
  qualitySelect.innerHTML = '';

  if (!formats || formats.length === 0) {
    qualitySelect.add(new Option('No compatible qualities found', ''));
    qualitySelect.disabled = true;
    return;
  }

  for (const format of formats) {
    const fps = format.fps ? ` · ${format.fps} FPS` : '';

    qualitySelect.add(
      new Option(`${format.label}${fps}`, String(format.height))
    );
  }

  qualitySelect.disabled = false;
}

function displayAnalysis(result) {
  const sourceType = result.kind === 'shorts'
    ? 'YouTube Shorts'
    : 'YouTube video';

  const details = [
    sourceType,
    result.uploader || 'Unknown uploader',
    formatDuration(result.duration),
    `${result.formats.length} quality options`
  ];

  showResult(result.title, details.join(' · '));
  populateQualities(result.formats);

  qualitySelect.disabled = selectedFormat === 'mp3' || !result.formats.length;
  processButton.disabled = selectedFormat === 'mp4' && !result.formats.length;
}

document.querySelectorAll('.format-option').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.format-option').forEach((item) => {
      item.classList.remove('selected');
    });

    button.classList.add('selected');
    selectedFormat = button.dataset.format;

    // MP3 does not need a video-resolution selection.
    if (selectedFormat === 'mp3') {
      qualitySelect.disabled = true;
      processButton.disabled = !analyzedSource;
    } else if (analyzedSource) {
      populateQualities(analyzedSource.formats);
      processButton.disabled = !analyzedSource.formats.length;
    } else {
      processButton.disabled = true;
    }
  });
});

analyzeButton.addEventListener('click', async () => {
  const url = urlInput.value.trim();

  if (!url) {
    showResult('A URL is needed', 'Paste a supported media URL to continue.');
    urlInput.focus();
    return;
  }

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
    showResult('Analysis failed', String(error));
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.innerHTML = 'Analyze <span>↗</span>';
  }
});

const downloadProgress = document.querySelector('#downloadProgress');
const progressStatus = document.querySelector('#progressStatus');
const progressPercent = document.querySelector('#progressPercent');
const progressBar = document.querySelector('#progressBar');
const progressSpeed = document.querySelector('#progressSpeed');
const progressEta = document.querySelector('#progressEta');

processButton.addEventListener('click', async () => {
  if (!analyzedSource || !currentDownloadDirectory) {
    showResult('Not ready', 'Analyze a video and choose a save folder first.');
    return;
  }

  const height = Number(qualitySelect.value) || 0;

  if (selectedFormat === 'mp4' && !height) {
    showResult('Choose a quality', 'Select a video resolution before downloading.');
    return;
  }

  processButton.disabled = true;
  analyzeButton.disabled = true;
  processButton.textContent = 'Processing…';

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
  } catch (error) {
    progressStatus.textContent = 'Download failed';
    progressSpeed.textContent = 'An error occurred';
    progressEta.textContent = '';
    showResult('Download failed', String(error));
  } finally {
    if (unlisten) unlisten();

    analyzeButton.disabled = false;
    processButton.textContent = 'Start processing';

    processButton.disabled = !analyzedSource ||
      (selectedFormat === 'mp4' && !qualitySelect.value);
  }
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    analyzeButton.click();
  }
});

document.querySelector('#themeButton').addEventListener('click', () => {
  document.body.classList.toggle('light');
});

initializeDestination();
checkBackend();

