// Quick Note's entire "backend": two native functions. The note lives in the
// app's data directory ("fs:app-data" in kestrel.json).
const NOTE = "note.txt";

native.loadNote = () => (hostExists(NOTE) ? hostReadFile(NOTE) : "");

native.saveNote = ({ text }) => {
  hostWriteFile(NOTE, text);
  return `saved ${text.length} chars to ${hostAppDataDir()}`;
};
