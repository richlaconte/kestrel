// native.js — your app's privileged code (the desktop analogue of server actions).
// Runs inside the host, not the webview. Regenerate typed client stubs with
// `kestrel typegen` (also runs automatically on `kestrel dev`).

const DATA_FILE = "./kestrel-data.json";

native.greet = ({ name }) => `Hello, ${name}! Greeted from inside the host.`;

native.visitCount = () => {
  const raw = hostReadFile(DATA_FILE);
  const data = raw.startsWith("ERR:") ? { visits: 0 } : JSON.parse(raw);
  data.visits += 1;
  hostWriteFile(DATA_FILE, JSON.stringify(data));
  return data.visits;
};
