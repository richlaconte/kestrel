native.report = (r) => {
  hostWriteFile("serve-results-" + r.mode + ".json", JSON.stringify(r, null, 2));
  return true;
};
