'use strict';
const status = document.querySelector('#folderStatus');
const allow = document.querySelector('#allowFolder');
let currentHandle;
async function update() {
  currentHandle = await ApplicantAllyFolder.read();
  const granted = currentHandle && await currentHandle.queryPermission({ mode: 'readwrite' }) === 'granted';
  allow.disabled = !currentHandle || granted;
  status.textContent = granted ? `File access ready · ${currentHandle.name}` : currentHandle ? 'Allow folder access to resume reading and saving jobs.' : 'Choose your ApplicantAlly folder to get started.';
}
async function configured() {
  const response = await chrome.runtime.sendMessage({ type: 'KAI_TRACKER_CONFIGURE' });
  await update();
  if (!response?.ok || response.result.connection !== 'connected') throw new Error(response?.result?.error?.message || response?.error?.message || 'Folder access is unavailable.');
}
document.querySelector('#chooseFolder').addEventListener('click', async () => {
  try {
    const handle = await showDirectoryPicker({ id: 'applicantally-workspace', mode: 'readwrite' });
    await ApplicantAllyFolder.resolve(handle);
    await ApplicantAllyFolder.save(handle);
    await configured();
  } catch (error) { if (error.name !== 'AbortError') status.textContent = error.message; }
});
allow.addEventListener('click', async () => {
  try {
    if (await currentHandle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Folder access was not granted.');
    await configured();
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#forgetFolder').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'KAI_TRACKER_CLEAR_CONFIG' });
  await update();
});
void update().catch(error => { status.textContent = error.message; });
