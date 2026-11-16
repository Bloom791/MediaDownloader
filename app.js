import { invoke } from '@tauri-apps/api/core';

const urlInput = document.querySelector('#urlInput');
const analyzeButton = document.querySelector('#analyzeButton');
const processButton = document.querySelector('#processButton');
const resultCard = document.querySelector('#resultCard');
const resultTitle = document.querySelector('#resultTitle');
const resultMessage = document.querySelector('#resultMessage');
const connectionStatus = document.querySelector('#connectionStatus');
const qualitySelect = document.querySelector('#qualitySelect');
let selectedFormat = 'mp4';
let analyzedSource = null;

function showResult(title, message) {
  resultTitle.textContent = title;
  resultMessage.textContent = message;
  resultCard.classList.remove('hidden');
}

async function checkBackend() {
  try {
    const result = await invoke('check_media_tools');
    connectionStatus.textContent = result.ffmpeg && result.ffprobe
      ? 'FFmpeg ready'
      : 'FFmpeg tools not found';
  } catch {
    connectionStatus.textContent = 'Desktop backend unavailable';
  }
}

document.querySelectorAll('.format-option').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.format-option').forEach((item) => item.classList.remove('selected'));
    button.classList.add('selected');
    selectedFormat = button.dataset.format;
    analyzedSource = null;
    processButton.disabled = true;
    qualitySelect.disabled = true;
    qualitySelect.innerHTML = '<option>Analyze a source first</option>';
  });
});

analyzeButton.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) {
    showResult('A URL is needed', 'Paste a supported media URL to continue.');
    urlInput.focus();
    return;
  }

  analyzeButton.disabled = true;
  analyzeButton.textContent = 'Checking…';
  try {
    const result = await invoke('analyze_source', { url });
    analyzedSource = result;
    showResult('Source recognized', `Recognized ${result.kind === 'shorts' ? 'YouTube Shorts' : 'YouTube video'} URL. A permitted media-source adapter is not configured yet, so no formats are being advertised.`);
  } catch (error) {
    showResult('Cannot analyze source', String(error));
  } finally {
    analyzeButton.disabled = false;
    analyzeButton.innerHTML = 'Analyze <span>↗</span>';
  }
});

processButton.addEventListener('click', () => {
  showResult('Processing unavailable', 'Connect and configure an authorized media-source adapter before processing can be enabled.');
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') analyzeButton.click();
});

document.querySelector('#themeButton').addEventListener('click', () => {
  document.body.classList.toggle('light');
});

checkBackend();
