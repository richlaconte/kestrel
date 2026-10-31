// Windows packaging for `kestrel build --installer` (#25): an NSIS installer
// made with makensis, and optional Authenticode signing with signtool.
//
// The installer is per user: no admin prompt. It copies the portable folder
// to %LOCALAPPDATA%\Programs\<Title>, adds a Start-menu shortcut with the
// app's icon, registers an uninstaller under HKCU, and
// installs the WebView2 runtime first if the machine has none (Windows 10
// without Edge updates; Windows 11 always has it).
//
// Signing: with KESTREL_WIN_SIGN_PFX (a .pfx code-signing certificate) and
// KESTREL_WIN_SIGN_PASSWORD, the app's exe, the uninstaller and the
// installer are signed and timestamped.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** The WebView2 runtime's EdgeUpdate client id. */
const WEBVIEW2 = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
/** Microsoft's evergreen bootstrapper (about 2 MB; it downloads the rest). */
const WEBVIEW2_BOOTSTRAPPER = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
const DEFAULT_TIMESTAMP = "http://timestamp.digicert.com";

/** A folder- and file-name-safe name from the title. */
export const installNameOf = (m) =>
  m.title
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Windows forbids control characters in file names.
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
    .replace(/[. ]+$/, "")
    .trim() || m.appId;

/** `build/<Title>-<version>-<arch>-setup.exe`'s file name. */
export const installerNameOf = (m, version, arch = process.arch) =>
  `${m.title.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || m.appId}-${version}-${arch}-setup.exe`;

/** Windows version resources want four numbers: "1.2.3-beta" → "1.2.3.0". */
export function fileVersionOf(version) {
  const nums = String(version)
    .split(/[.+-]/)
    .map((p) => (/^\d+$/.test(p) ? Math.min(Number(p), 65535) : null));
  const lead = [];
  for (const n of nums) {
    if (n === null || lead.length === 4) break;
    lead.push(n);
  }
  while (lead.length < 4) lead.push(0);
  return lead.join(".");
}

// NSIS has two kinds of strings. Runtime ones (attributes like InstallDir,
// and every instruction in a Section) unescape `$$` and `$\"`. Compile-time
// ones (OutFile, File, Icon, VIAddVersionKey, !uninstfinalize) take text
// as is, except that `${...}` expands a define. `nsis` is for the first,
// `ct` for the second.

/** Text inside a runtime NSIS string: `$` and `"` escaped, on one line. */
export const esc = (s) =>
  String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/\$/g, "$$$$")
    .replace(/"/g, '$\\"');

/** A quoted runtime NSIS string holding `s` literally. */
export const nsis = (s) => `"${esc(s)}"`;

/** A quoted compile-time NSIS string: `s` in a quote it doesn't contain. */
export function ct(s) {
  const text = String(s)
    .replace(/[\r\n]+/g, " ")
    .replace(/\$\{/g, "$ {");
  const q = ['"', "'", "`"].find((c) => !text.includes(c));
  return q ? `${q}${text}${q}` : `"${text.replace(/"/g, "'")}"`;
}

/** Who the installer names as publisher: package.json `author`, else the title. */
export function publisherOf(pkg, m) {
  const a = pkg?.author;
  if (typeof a === "string" && a.trim()) return a.replace(/\s*<[^>]*>\s*/g, " ").trim();
  if (a && typeof a === "object" && a.name) return a.name;
  return m.title;
}

/**
 * The installer script. `src` is the portable folder, `icon` the .ico,
 * `out` the setup.exe to write; `signCmd`, if given, signs the uninstaller
 * as makensis writes it ("%1" is the file).
 */
export function nsisScript({ m, version, pkg = {}, src, icon, out, signCmd }) {
  const name = installNameOf(m);
  const exe = `${m.appId}.exe`;
  const key = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${m.appId}`;
  const sizeKiB = Math.ceil(dirSize(src) / 1024);
  const lines = [
    "Unicode true",
    "SetCompressor /SOLID lzma",
    "RequestExecutionLevel user",
    "ManifestDPIAware true",
    '!include "MUI2.nsh"',
    '!include "LogicLib.nsh"',
    '!include "FileFunc.nsh"',
    "",
    // --relaunch (from the app's updater, with /S): wait for the running
    // app to let go of its files, then start the new version when done.
    "Var Relaunch",
    `Name ${nsis(m.title)}`,
    `OutFile ${ct(out)}`,
    `InstallDir "$LOCALAPPDATA\\Programs\\${esc(name)}"`,
    `InstallDirRegKey HKCU ${nsis(key)} "InstallLocation"`,
    `!define MUI_ICON ${ct(icon)}`,
    `!define MUI_UNICON ${ct(icon)}`,
    "!define MUI_ABORTWARNING",
    `!define MUI_FINISHPAGE_RUN "$INSTDIR\\${exe}"`,
    `VIProductVersion "${fileVersionOf(version)}"`,
    `VIAddVersionKey "ProductName" ${ct(m.title)}`,
    `VIAddVersionKey "ProductVersion" ${ct(version)}`,
    `VIAddVersionKey "FileVersion" ${ct(version)}`,
    `VIAddVersionKey "FileDescription" ${ct(`${m.title} Setup`)}`,
    `VIAddVersionKey "CompanyName" ${ct(publisherOf(pkg, m))}`,
    `VIAddVersionKey "LegalCopyright" ${ct(publisherOf(pkg, m))}`,
    // Backticks, so the command keeps its own double quotes; = 0 stops the
    // build if signing fails.
    ...(signCmd ? [`!uninstfinalize \`${signCmd}\` = 0`] : []),
    "",
    "!insertmacro MUI_PAGE_DIRECTORY",
    "!insertmacro MUI_PAGE_INSTFILES",
    "!insertmacro MUI_PAGE_FINISH",
    "!insertmacro MUI_UNPAGE_CONFIRM",
    "!insertmacro MUI_UNPAGE_INSTFILES",
    '!insertmacro MUI_LANGUAGE "English"',
    "",
    // WebView2: present if EdgeUpdate lists a version for it, machine-wide
    // or for this user. Otherwise run Microsoft's bootstrapper.
    "Function .onInit",
    "  ${GetParameters} $R0",
    "  ClearErrors",
    '  ${GetOptions} $R0 "--relaunch" $R1',
    "  ${IfNot} ${Errors}",
    '    StrCpy $Relaunch "1"',
    "  ${EndIf}",
    "FunctionEnd",
    "",
    // The exe can't be replaced while it runs. Wait up to 15 s for it.
    "Function WaitForApp",
    "  StrCpy $R2 0",
    "  retry:",
    "  ClearErrors",
    `  Delete "$INSTDIR\\${exe}"`,
    `  \${If} \${FileExists} "$INSTDIR\\${exe}"`,
    "    IntOp $R2 $R2 + 1",
    "    ${If} $R2 < 30",
    "      Sleep 500",
    "      Goto retry",
    "    ${EndIf}",
    `    MessageBox MB_ICONEXCLAMATION|MB_OK "${esc(m.title)} is still running. Quit it and run this setup again." /SD IDOK`,
    "    Abort",
    "  ${EndIf}",
    "FunctionEnd",
    "",
    "Function EnsureWebView2",
    `  ReadRegStr $0 HKLM "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2}" "pv"`,
    '  ${If} $0 == ""',
    `    ReadRegStr $0 HKLM "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2}" "pv"`,
    "  ${EndIf}",
    '  ${If} $0 == ""',
    `    ReadRegStr $0 HKCU "Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2}" "pv"`,
    "  ${EndIf}",
    '  ${If} $0 == ""',
    '  ${OrIf} $0 == "0.0.0.0"',
    '    DetailPrint "Installing the Microsoft Edge WebView2 runtime..."',
    `    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri ''${WEBVIEW2_BOOTSTRAPPER}'' -OutFile ''$TEMP\\MicrosoftEdgeWebview2Setup.exe''"'`,
    "    Pop $1",
    // Stays "not run" if the download failed and there's nothing to run.
    '    StrCpy $1 "not run"',
    "    ExecWait '\"$TEMP\\MicrosoftEdgeWebview2Setup.exe\" /silent /install' $1",
    '    Delete "$TEMP\\MicrosoftEdgeWebview2Setup.exe"',
    "    ${If} $1 != 0",
    '      MessageBox MB_ICONEXCLAMATION|MB_OK "The WebView2 runtime could not be installed (code $1). Install it from https://developer.microsoft.com/microsoft-edge/webview2/ and run this setup again." /SD IDOK',
    "      Abort",
    "    ${EndIf}",
    "  ${EndIf}",
    "FunctionEnd",
    "",
    'Section "Install"',
    "  Call EnsureWebView2",
    '  SetOutPath "$INSTDIR"',
    "  Call WaitForApp",
    // A reinstall replaces the app's files; its data lives elsewhere.
    '  RMDir /r "$INSTDIR\\app"',
    `  File /r ${ct(path.join(src, "*"))}`,
    '  WriteUninstaller "$INSTDIR\\uninstall.exe"',
    `  CreateShortCut "$SMPROGRAMS\\${esc(name)}.lnk" "$INSTDIR\\${exe}" "" "$INSTDIR\\icon.ico"`,
    `  WriteRegStr HKCU ${nsis(key)} "DisplayName" ${nsis(m.title)}`,
    `  WriteRegStr HKCU ${nsis(key)} "DisplayVersion" ${nsis(version)}`,
    `  WriteRegStr HKCU ${nsis(key)} "Publisher" ${nsis(publisherOf(pkg, m))}`,
    `  WriteRegStr HKCU ${nsis(key)} "DisplayIcon" "$INSTDIR\\icon.ico"`,
    `  WriteRegStr HKCU ${nsis(key)} "InstallLocation" "$INSTDIR"`,
    `  WriteRegStr HKCU ${nsis(key)} "UninstallString" '"$INSTDIR\\uninstall.exe"'`,
    `  WriteRegStr HKCU ${nsis(key)} "QuietUninstallString" '"$INSTDIR\\uninstall.exe" /S'`,
    `  WriteRegDWORD HKCU ${nsis(key)} "NoModify" 1`,
    `  WriteRegDWORD HKCU ${nsis(key)} "NoRepair" 1`,
    `  WriteRegDWORD HKCU ${nsis(key)} "EstimatedSize" ${sizeKiB}`,
    '  ${If} $Relaunch == "1"',
    `    Exec '"$INSTDIR\\${exe}"'`,
    "  ${EndIf}",
    "SectionEnd",
    "",
    'Section "Uninstall"',
    `  Delete "$SMPROGRAMS\\${esc(name)}.lnk"`,
    '  RMDir /r "$INSTDIR"',
    `  DeleteRegKey HKCU ${nsis(key)}`,
    "SectionEnd",
    "",
  ];
  return lines.join("\n");
}

function dirSize(p) {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true, recursive: true }))
    if (e.isFile()) total += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  return total;
}

/** makensis: on PATH, else where the NSIS installer puts it. */
export function findMakensis(env = process.env) {
  const candidates = ["makensis"];
  for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles].filter(Boolean))
    candidates.push(path.join(base, "NSIS", "makensis.exe"));
  for (const c of candidates) {
    try {
      execFileSync(c, ["-VERSION"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  return null;
}

/** signtool: on PATH, else the newest Windows SDK's x64 copy. */
export function findSigntool(env = process.env) {
  try {
    execFileSync("signtool", ["/?"], { stdio: "ignore" });
    return "signtool";
  } catch {}
  const kits = path.join(env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  if (!fs.existsSync(kits)) return null;
  const versions = fs
    .readdirSync(kits)
    .filter((d) => /^10\./.test(d))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const v of versions.reverse()) {
    const p = path.join(kits, v, "x64", "signtool.exe");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** What to do with the signing env vars. */
export function signingPlan(env = process.env) {
  const pfx = env.KESTREL_WIN_SIGN_PFX || null;
  return {
    pfx,
    password: env.KESTREL_WIN_SIGN_PASSWORD ?? "",
    timestamp: env.KESTREL_WIN_TIMESTAMP_URL || DEFAULT_TIMESTAMP,
    // A password with no certificate is almost certainly a mistake.
    orphanPassword: !pfx && Boolean(env.KESTREL_WIN_SIGN_PASSWORD),
  };
}

/** signtool's arguments to sign `file` under `plan` (the file last). */
export const signArgs = (plan, file) => [
  "sign",
  "/fd",
  "SHA256",
  "/f",
  plan.pfx,
  ...(plan.password ? ["/p", plan.password] : []),
  "/tr",
  plan.timestamp,
  "/td",
  "SHA256",
  file,
];

/**
 * The same signing as one command line for makensis's !uninstfinalize,
 * with "%1" for the file.
 */
export function signCommand(signtool, plan) {
  for (const [what, v] of [
    ["KESTREL_WIN_SIGN_PASSWORD", plan.password],
    ["KESTREL_WIN_SIGN_PFX", plan.pfx],
    ["signtool's path", signtool],
  ])
    if (/[`"]|\$\{/.test(v))
      throw new Error(`${what} can't contain ", \` or \${ (makensis runs the signing command for the uninstaller)`);
  return signArgs(plan, "%1").reduce(
    (cmd, a) => `${cmd} ${/[\s%]/.test(a) || a === "" ? `"${a}"` : a}`,
    `"${signtool}"`,
  );
}

/** Sign `file` in place. */
export function sign(signtool, plan, file) {
  execFileSync(signtool, signArgs(plan, file), { stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Build the installer: write the script next to `out`, run makensis, and
 * clean up. Returns makensis's output.
 */
export function makeInstaller({ makensis, script, out }) {
  const nsi = `${out}.nsi`;
  fs.writeFileSync(nsi, script);
  try {
    return execFileSync(makensis, ["-V2", "-INPUTCHARSET", "UTF8", nsi], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
  } finally {
    fs.rmSync(nsi, { force: true });
  }
}
