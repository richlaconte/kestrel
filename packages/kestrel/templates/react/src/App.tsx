import { useEffect, useState } from "react";
// Typed stubs generated from native.ts — greet's arg and return types are real:
import { greet, visitCount } from "../native-client";

const styles: Record<string, React.CSSProperties> = {
  body: {
    margin: 0, minHeight: "100vh", display: "grid", placeItems: "center",
    fontFamily: "system-ui, sans-serif", background: "#F7F8FA", color: "#1C2430",
  },
  main: { width: "min(520px, 90vw)", textAlign: "center" },
  h1: { fontSize: 28, margin: "0 0 4px" },
  accent: { color: "#B4502A" },
  visits: { fontFamily: "monospace", fontSize: 13, color: "#7A8798", marginBottom: 24 },
  input: { font: "15px system-ui", padding: "9px 14px", borderRadius: 8, border: "1px solid #D9DEE6", width: 200 },
  button: { font: "600 15px system-ui", padding: "9px 18px", borderRadius: 8, border: 0, background: "#B4502A", color: "#fff", cursor: "pointer", marginLeft: 8 },
  msg: { marginTop: 16, minHeight: "1.4em", color: "#2E7D4F", fontFamily: "monospace", fontSize: 13.5 },
  hint: { marginTop: 28, fontSize: 13, color: "#7A8798" },
};

// Module-level so React StrictMode's double-invoked effect counts one visit.
let visitPromise: Promise<number> | null = null;

export default function App() {
  const [visits, setVisits] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    visitPromise ??= visitCount();
    visitPromise.then(setVisits);
  }, []);

  return (
    <div style={styles.body}>
      <main style={styles.main}>
        <h1 style={styles.h1}>
          <span style={styles.accent}>React</span>, running native
        </h1>
        <div style={styles.visits}>
          {visits === null
            ? "…"
            : `opened ${visits} time${visits === 1 ? "" : "s"} — persisted by native.ts`}
        </div>
        <input
          style={styles.input}
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          style={styles.button}
          onClick={async () => setMsg(await greet({ name: name || "stranger" }))}
        >
          Greet
        </button>
        <div style={styles.msg}>{msg}</div>
        <div style={styles.hint}>
          Edit <code>src/App.tsx</code> and save — HMR updates this native window live.
        </div>
      </main>
    </div>
  );
}
