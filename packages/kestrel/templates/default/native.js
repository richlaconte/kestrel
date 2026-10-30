// native.js — your app's privileged code (the desktop analogue of server actions).
// Runs inside the host, not the webview. Regenerate typed client stubs with
// `kestrel typegen` (also runs automatically on `kestrel dev`).
//
// Host bindings exist only for permissions granted in kestrel.json. With
// "fs:app-data", relative paths live in this app's data directory, and paths
// outside it throw.

const DATA_FILE = "kestrel-data.json";

native.greet = ({ name }) => `Hello, ${name}! Greeted from inside the host.`;

native.visitCount = () => {
  const data = hostExists(DATA_FILE) ? JSON.parse(hostReadFile(DATA_FILE)) : { visits: 0 };
  data.visits += 1;
  hostWriteFile(DATA_FILE, JSON.stringify(data));
  return data.visits;
};
