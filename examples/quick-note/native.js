// Quick Note's entire "backend": two native functions.
const NOTE_PATH = "/tmp/quick-note.txt";

native.loadNote = () => {
  const raw = hostReadFile(NOTE_PATH);
  return raw.startsWith("ERR:") ? "" : raw;
};

native.saveNote = ({ text }) => {
  const res = hostWriteFile(NOTE_PATH, text);
  return res === "ok" ? `saved ${text.length} chars to ${NOTE_PATH}` : res;
};
