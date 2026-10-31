const { invoke } = window.__TAURI__.core;
const nativeCall = (name, args = {}) => invoke("call_native", { name, args });
const noteEl = document.getElementById("note");
const statusEl = document.getElementById("status");

(async () => {
  const existing = await nativeCall("loadNote");
  if (existing) {
    noteEl.value = existing;
    statusEl.textContent = "loaded from disk";
  }
})();

document.getElementById("save").onclick = async () => {
  const receipt = await nativeCall("saveNote", { text: noteEl.value });
  statusEl.textContent = receipt;
};
