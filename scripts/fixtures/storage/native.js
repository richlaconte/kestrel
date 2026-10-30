native.report = (r) => {
  hostWriteFile("storage-result.json", JSON.stringify(r));
  return true;
};
